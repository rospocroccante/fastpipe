// Server-rendered HTML dashboard — htmx polls fragments, Alpine drives the toast tray.
// Presentation only; server code (src/dashboard.ts, src/node.ts) needs no edits.

import { HTMX_JS, ALPINE_JS } from './vendor.js';
import { CACHE_CREATE_RATE, CACHE_READ_RATE } from '../core/baseline.js';
import type {
  StatsPayload,
  RecentPayload,
  RecentRow,
  SessionsPayload,
  SessionRow,
  FullStatsPayload,
  CurrentSessionPayload,
} from './types.js';

// ---- helpers --------------------------------------------------------

export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

function numFmt(n: number | null | undefined): string {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-US');
}

/** "12.3k" / "1.2M" compact formatter for headline numbers. */
function kFmt(n: number | null | undefined): string {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (a >= 1_000_000) return (v / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1) + 'M';
  if (a >= 1000) return (v / 1000).toFixed(a >= 100_000 ? 0 : 1) + 'k';
  return String(Math.round(v));
}

function formatDuration(s: number): string {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? h + 'h ' : '') + (m || h ? m + 'm ' : '') + sec + 's';
}

function shortPath(p: string | null | undefined): string {
  if (!p) return '-';
  const parts = String(p).split('/');
  return parts[parts.length - 1] || p;
}

// ---- compression toggle (kill switch) ------------------------------------

export function renderToggleFragment(enabled: boolean): string {
  // NOTE: "PASSTHROUGH MODE", "Disable compression", "Enable compression" are asserted by tests.
  const banner = enabled
    ? ''
    : `<div class="banner"><strong>PASSTHROUGH MODE</strong> — compression is off. Every request goes to Claude unchanged: no images, no savings. Use this to A/B test, or if the upstream API is having problems.</div>`;
  // Button POSTs the OPPOSITE of current state; 2s poll keeps it fresh.
  const confirm = enabled
    ? ` hx-confirm="Turn compression off?\n\nRequests will pass straight through to Claude, unchanged. Restarting the proxy turns it back on."`
    : '';
  return (
    banner +
    `<div class="switch">` +
    `<span class="switch-state ${enabled ? 'on' : 'off'}">Compression</span>` +
    // The id lets htmx carry the old state over the 2s swap, so the knob slides instead of jumping.
    `<button class="switch-btn" type="button" id="switch-btn" role="switch" aria-checked="${enabled}" title="Kill switch. Compression turns itself back on when the proxy restarts." aria-label="${enabled ? 'Disable compression' : 'Enable compression'}" hx-post="/fragments/toggle" hx-target="#frag-toggle" hx-vals='{"enabled": ${!enabled}}'${confirm}>` +
    `</button>` +
    `</div>`
  );
}

// ---- compress scope (which models get imaged) ----------------------------

/** Chip catalog — UNION with env scope + active set, so env-var models stay toggleable. Labels are cosmetic. */
const MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-fable-5', label: 'Fable 5 (all versions)' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
];

const GPT_MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol' },
  { id: 'gpt-5.5', label: 'GPT 5.5' },
];

const GROK_MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'grok-4.6', label: 'Grok 4.6' },
  { id: 'grok-4.5', label: 'Grok 4.5' },
];

const GEMINI_MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  // `gemini` is the family base (default on): covers 3.6/3.7/3.8, Pro, 4, 5 and
  // whatever ships next. The per-version chips are for narrowing scope after
  // opting the family off.
  { id: 'gemini', label: 'Gemini (all versions)' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { id: 'gemini-4', label: 'Gemini 4' },
];

export function renderModelsFragment(
  active: string[],
  configured: string[],
  enabled: boolean,
): string {
  const on = new Set(active);
  const labelOf = new Map(
    [...MODEL_CATALOG, ...GPT_MODEL_CATALOG, ...GROK_MODEL_CATALOG, ...GEMINI_MODEL_CATALOG].map((m) => [m.id, m.label]),
  );
  // Union the catalog with env-configured + active ids so PXPIPE_MODELS-enabled
  // families always show as toggles, then split into chip rows (Claude /
  // OpenAI Responses / Gemini) plus the PXPIPE_MODELS CSV textbox that mirrors the scope.
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of [
    ...MODEL_CATALOG.map((m) => m.id),
    ...GPT_MODEL_CATALOG.map((m) => m.id),
    ...GROK_MODEL_CATALOG.map((m) => m.id),
    ...GEMINI_MODEL_CATALOG.map((m) => m.id),
    ...configured,
    ...active,
  ]) {
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  const chipFor = (id: string): string => {
    const lit = on.has(id);
    const label = labelOf.get(id) ?? id;
    return (
      `<button class="chip${lit ? ' on' : ''}" type="button" ` +
      `hx-post="/fragments/models" hx-target="#frag-models" ` +
      `hx-vals='${escapeHtml(`{"model":${JSON.stringify(id)},"on":${!lit}}`)}'>${escapeHtml(label)}${lit ? ' ✓' : ''}</button>`
    );
  };
  const claudeChips = ids.filter((id) => id.startsWith('claude')).map(chipFor).join('');
  const geminiChips = ids.filter((id) => id.includes('gemini')).map(chipFor).join('');
  const gptChips = ids.filter((id) => id.startsWith('gpt')).map(chipFor).join('');
  const grokChips = ids.filter((id) => id.startsWith('grok')).map(chipFor).join('');
  const otherChips = ids
    .filter((id) => !id.startsWith('claude') && !id.startsWith('gpt') && !id.startsWith('grok') && !id.includes('gemini'))
    .map(chipFor)
    .join('');
  const moot = enabled
    ? ''
    : `<div class="models"><span class="hint">compression is off, these settings have no effect right now</span></div>`;
  // Every chip sits in one row, family after family, so the view never stacks rows of buttons.
  const family = (name: string, chips: string): string =>
    `<span class="chip-group"><span class="models-label" title="Image ${name} models">${name}</span>${chips}</span>`;
  return (
    moot +
    `<div class="chips">` +
    family('Claude', claudeChips) +
    family('Gemini', geminiChips) +
    family('OpenAI Responses', gptChips + grokChips + otherChips) +
    `</div><!-- /chips -->` +
    `<p class="hint">Claude: unlisted models get plain text. Gemini: on by default (100/100 vision reader), toggle off to opt out. OpenAI Responses: opt-in, no Anthropic cache_control.</p>` +
    `<div class="models">` +
    `<span class="models-label">PXPIPE_MODELS</span>` +
    `<input class="models-csv" id="models-csv" type="text" name="list" ` +
    `value="${escapeHtml(active.join(','))}" spellcheck="false" autocomplete="off" ` +
    `hx-post="/fragments/models" hx-target="#frag-models" hx-trigger="change">` +
    `<span class="hint">CSV of bases, or off. Applies on enter or blur, export to persist.</span>` +
    `</div>`
  );
}

// ---- session hero --------------------------------------------------------

// Must stay in lockstep with ASSUMED_INPUT_USD_PER_MTOK in src/dashboard.ts.
const INPUT_USD_PER_MTOK = 10.0;
void INPUT_USD_PER_MTOK; // suppress unused-var; renderHeaderFragment uses the server's pricing block.

// Lifetime hero. Reads the SAME cumulative weighted totals as the header strip
// (serveStats), so the headline and the "$ saved" tiles can never disagree, and
// the number stops swinging on tiny per-session samples. Cache-weighted on
// purpose ("lifeweight"): it answers "did fastpipe move my real, cache-discounted
// bill since this proxy started", not a raw token count.
export function renderSessionSummaryFragment(s: StatsPayload): string {
  const measured = s.compressed_requests ?? 0;
  if (measured <= 0) {
    return (
      `<div class="gauge gauge-empty">` +
      `<header class="head"><h2 class="head-title">Warming up…</h2>` +
      `<p class="head-sub">Point Claude Code at this proxy with <code>ANTHROPIC_BASE_URL</code>, or launch it with <code>fastpipe warp -- claude</code> to keep <code>/remote-control</code> and claude.ai connectors working. Send a message and your running savings show up right here.</p></header>` +
      `<div class="record"><div class="gauge-track"></div></div>` +
      `</div>`
    );
  }
  // Cache-aware reduction — same basis as the Details panel + Saved column.
  // Raw count_tokens would over-claim: most of the text baseline would have been
  // cheap cache-reads (~0.1×), not full-price tokens. Weighting both sides at their
  // real cache rate is the only comparison that can't contradict the Saved column.
  // Input-only: fastpipe never touches output, so lumping it in just dampened the %.
  const baselineW = s.baseline_input_weighted ?? 0; // same context as text, cache-aware
  const actualW = s.actual_input_weighted ?? 0; // what we actually sent, cache-aware
  const inputPct = baselineW > 0 ? (1 - actualW / baselineW) * 100 : 0;
  const loss = inputPct < 0;

  // One pipe on one scale. It is as long as the larger of the two amounts and filled from the
  // left with the smaller one, so the saving (or the excess, on a loss) is the part left over.
  const whole = Math.max(baselineW, actualW);
  const part = loss ? baselineW : actualW;
  const rest = whole - part;
  let partPct = whole > 0 ? (part / whole) * 100 : 0;
  // A part too small to draw at its true width still gets half a percent.
  if (part > 0) partPct = Math.max(0.5, partPct);
  if (rest > 0) partPct = Math.min(99.5, partPct);
  const restPct = whole > 0 ? 100 - partPct : 0;
  const seg = (cls: string, pct: number, name: string, amount: number): string =>
    pct > 0
      ? `<span class="gauge-seg ${cls}" style="width:${pct.toFixed(1)}%">` +
        `<span class="seg-name">${name}</span><span class="seg-num">${kFmt(amount)}</span></span>`
      : '';

  // Without a text baseline there is nothing to compare against: show what was sent and say so.
  const compared = baselineW > 0;
  const spoken = !compared
    ? `${kFmt(actualW)} input tokens sent, text baseline not measured yet`
    : loss
      ? `${kFmt(actualW)} input tokens sent, ${kFmt(rest)} more than the ${kFmt(baselineW)} the same context takes as text`
      : `${kFmt(actualW)} input tokens sent, ${kFmt(rest)} not sent, out of ${kFmt(baselineW)} without fastpipe`;
  // The whole pipe stands for the larger amount: the text on a saving, what was sent on a loss.
  const wholeLabel = !compared
    ? `<span class="rec-name">Text baseline not measured yet</span>`
    : `<span class="rec-name">${loss ? 'With fastpipe' : 'Without fastpipe'}</span><span class="rec-num">${kFmt(whole)}</span>`;

  return (
    `<div class="gauge${loss ? ' gauge-loss' : ''}">` +
    `<header class="head"><h2 class="head-title"><span class="gauge-num">${Math.abs(inputPct).toFixed(0)}%</span> ` +
    `${loss ? 'more input tokens' : 'fewer input tokens'}</h2>` +
    `<p class="head-sub">Since start, after cache discounts. ${numFmt(measured)} request${measured === 1 ? '' : 's'} imaged.</p></header>` +
    `<div class="record">` +
    `<div class="rec-head">${wholeLabel}</div>` +
    `<div class="gauge-track" role="img" aria-label="${spoken}" style="--cut:${rest > 0 ? (part > 0 ? partPct.toFixed(1) : '-100') : '200'}%">` +
    (loss
      ? seg('gauge-base', partPct, 'As text', part) + seg('gauge-over', restPct, 'Extra sent', rest)
      : seg('gauge-sent', partPct, 'Sent', part) + seg('gauge-saved', restPct, 'Not sent', rest)) +
    `</div>` +
    `</div>` +
    `</div>`
  );
}

// ---- rows of numbers + the "Math" group ------------------------------------

function mathRow(key: string, val: number | string | undefined, note = ''): string {
  const v = typeof val === 'number' ? numFmt(val) : String(val ?? '-');
  return `<div><span class="k">${key}:</span> <span class="v">${escapeHtml(v)}</span> <span class="k">${note}</span></div>`;
}

function mathBlock(title: string, body: string): string {
  return `<section class="math-block"><h4>${title}</h4><div class="formula">${body}</div></section>`;
}

/** One row of numbers. `tip` makes the label focusable and shows the explanation on hover or focus. */
function ledgerRow(label: string, value: string, note: string, cls = '', tip = ''): string {
  const name = tip
    ? `<span class="q" tabindex="0" aria-label="${escapeHtml(`${label}. ${tip}`)}" data-tip="${escapeHtml(tip)}">${label}</span>`
    : label;
  return (
    `<div class="ledger-row">` +
    `<dt>${name}</dt>` +
    `<dd class="ledger-val${cls ? ` ${cls}` : ''}">${value}</dd>` +
    `<dd class="ledger-note">${note}</dd>` +
    `</div>`
  );
}

export function renderHeaderFragment(s: StatsPayload, port: number): string {
  const pa = s.pricing_assumptions;
  const unpricedImaged = Math.max(
    0,
    (s.compressed_requests ?? 0) - (s.compressed_paid_requests ?? 0),
  );
  const onlyUnpriced = unpricedImaged > 0 && (s.compressed_paid_requests ?? 0) === 0;

  // Compare the same imaged requests on both sides. Passthrough requests are
  // generally smaller because the profitability gate selected them, so their
  // average is not a valid "without fastpipe" counterfactual.
  const cAvg = s.compressed_avg_usd_per_request ?? 0;
  const paidImaged = s.compressed_paid_requests ?? 0;
  const withoutAvg = paidImaged > 0 ? cAvg + (s.saved_usd ?? 0) / paidImaged : 0;
  const costRow = paidImaged > 0
    ? ledgerRow(
        'Cost per request',
        `$${cAvg.toFixed(4)}`,
        `vs $${withoutAvg.toFixed(4)} without fastpipe`,
        cAvg <= withoutAvg ? 'pos' : 'neg',
        'Average cost of paid imaged requests versus the cache-aware text counterfactual for those same requests. Unmeasured requests are assigned zero savings.',
      )
    : onlyUnpriced
      ? ledgerRow(
          'Cost per request',
          '—',
          'provider pricing not configured',
          'muted-val',
          'Token savings are available, but this provider is excluded from Claude-priced dollar estimates.',
        )
      : ledgerRow(
        'Cost per request',
        'collecting…',
        'waiting for a paid imaged request',
        'muted-val',
        'The comparison appears after an imaged request returns provider usage.',
      );

  const savedUsdRow = onlyUnpriced
    ? ledgerRow(
        'Estimated saved',
        '—',
        'provider pricing not configured',
        'muted-val',
        'Token savings are shown separately. Dollar estimates require provider-specific pricing and are not inferred from Claude rates.',
      )
    : ledgerRow(
        'Estimated saved',
        `$${(s.saved_usd ?? 0).toFixed(2)}`,
        unpricedImaged > 0
          ? `${numFmt(unpricedImaged)} provider-priced request${unpricedImaged === 1 ? '' : 's'} excluded`
          : `at $${pa.input_per_mtok}/M base input price`,
        '',
        'Cache-aware estimate for requests covered by the configured pricing assumptions. Other providers remain excluded.',
      );

  const ledger =
    `<div class="numbers"><h2 class="list-head">Since start</h2><dl class="ledger">` +
    ledgerRow(
      'Input tokens saved',
      numFmt(s.saved_input_tokens),
      'vs sending the same context as text',
      'pos',
       'Bulky context sent as compact images instead of text. Uses provider-reported input tokens and a measured or model-profile text counterfactual; recent turns and output stay text.',
     ) +
    savedUsdRow +
    costRow +
    ledgerRow('Requests', numFmt(s.requests), `${numFmt(s.compressed_requests)} turned into images`) +
    // NOTE: tests assert the header fragment contains the port number.
    ledgerRow('Running for', formatDuration(s.uptime_sec), `on port ${port}`) +
    `</dl></div>`;

  // math drawer
  const savedMath =
    `<div><span class="k">formula:</span> <span class="v">saved = baseline − actual</span></div>` +
    `<div><span class="k">weights:</span> <span class="v">input×1.0, cache_write_5m×1.25, cache_write_1h×2.0, cache_read×0.10</span></div>` +
    `<div class="sp"></div>` +
    mathRow('baseline', s.baseline_input_weighted, '(cache-aware: cacheable×weight + cold_tail)') +
    mathRow('actual', s.actual_input_weighted, '(input + cc_5m×1.25 + cc_1h×2.0 + cr×0.10)') +
    mathRow('saved', s.saved_input_tokens, `<span class="op">=</span> baseline − actual`) +
    `<span class="src">output excluded — identical with/without compression</span>`;

  const usdMath = onlyUnpriced
    ? `<div><span class="v">Unavailable for this provider.</span></div>` +
      `<span class="src">Token savings are still reported; Claude pricing is not applied across providers.</span>`
    :
    `<div><span class="k">formula:</span> <span class="v">$ saved = saved_tokens × $${pa.input_per_mtok}/Mtok</span></div>` +
    `<div class="sp"></div>` +
    mathRow('saved_tokens', s.saved_input_tokens, '(cache-aware, input-side)') +
    mathRow('saved_usd', `$${(s.saved_usd || 0).toFixed(4)} `, `<span class="op">=</span> saved_tokens × input_rate / 1e6`) +
    `<span class="src">source: ${escapeHtml(pa.source || 'docs.anthropic.com pricing')}</span>`;

  const costPerRequestMath =
    `<div><span class="k">formula:</span> <span class="v">without_fastpipe = actual_imaged + measured_savings</span></div>` +
    `<div><span class="k">why:</span> <span class="v">both averages cover the same paid imaged requests. Passthrough requests are not used because the profitability gate selects a different, generally smaller population.</span></div>` +
    `<div class="sp"></div>` +
    mathRow(`actual imaged (n=${paidImaged})`, `$${(s.compressed_actual_usd || 0).toFixed(4)}`, `total · avg $${cAvg.toFixed(4)}/req`) +
    mathRow('measured savings', `$${(s.saved_usd || 0).toFixed(4)}`, 'cache-aware input-side total') +
    mathRow('without fastpipe', `$${withoutAvg.toFixed(4)}/req`, '<span class="op">=</span> (actual imaged + measured savings) / n') +
    `<span class="src">unmeasured imaged rows remain in n and actual cost, with zero assumed savings</span>`;

  const pctMath =
    `<div><span class="k">formula:</span> <span class="v">share_of_spend = saved / (all_baseline_equivalent + all_output × ${pa.output_multiplier})</span></div>` +
    `<div><span class="k">diagnostic, not the headline:</span> <span class="v">this is a counterfactual ("what you WOULD have paid"). It leans on the count_tokens probe, the cache-aware split, and an input-rate assumption. Useful as a sanity check; the real-traffic answer is the compressed-vs-passthrough split above.</span></div>` +
    `<div class="sp"></div>` +
    mathRow('saved', s.saved_input_tokens, '(measured-rows numerator; cache-aware)') +
    mathRow('all_baseline_equivalent', s.all_baseline_equivalent_weighted, '(every paid request; baseline on measured + actual on the rest)') +
    mathRow(`all_output × ${pa.output_multiplier}`, s.all_output_weighted, '(every paid request)') +
    mathRow('share_of_spend', (s.saved_pct_of_all_spend || 0).toFixed(1) + '%', `<span class="op">=</span> saved / counterfactual_total × 100`) +
    mathRow('all_usage_requests', s.all_usage_requests, '(denominator request count — compressed + passthrough + probe-failed)') +
    `<span class="src">measured numerator, all-rows counterfactual denominator — bounded at 100%</span>`;

  const tokeqMath =
    `<div><span class="k">formula:</span> <span class="v">token_equivalent = input + output × ${pa.output_multiplier}</span></div>` +
    `<div><span class="k">why:</span> <span class="v">matches Anthropic's per-Mtok price ratio ($${pa.input_per_mtok} input vs $${pa.input_per_mtok * pa.output_multiplier} output) — this is what the weekly-limit meter counts.</span></div>` +
    `<div class="sp"></div>` +
    mathRow('actual_token_equivalent', s.actual_token_equivalent) +
    mathRow('baseline_token_equivalent', s.baseline_token_equivalent, `(unproxied counterfactual, same ×${pa.output_multiplier} on output)`) +
    `<div class="sp"></div>` +
    mathRow('events_with_measurement', s.events_with_measurement, '(events where the SSE/JSON scanner produced char counts)') +
    mathRow('measured_text_chars', s.measured_text_chars, '') +
    mathRow('measured_thinking_chars', s.measured_thinking_chars, '') +
    mathRow('measured_tool_use_chars', s.measured_tool_use_chars, '') +
    mathRow('measured_redacted_blocks', s.measured_redacted_block_count, '(opaque encrypted blocks — billed but unmeasurable)') +
    `<span class="src">measured — no estimation</span>`;

  // A block of its own, after the numbers: the page shows the numbers in the strip and this in the Math view.
  const math =
    `<section class="math">` +
    `<p class="drawer-intro">Every number in the strip, derived from the same per-event log. The proxy only moves <em>input</em> tokens; output is shown on both sides so percentages stay honest.</p>` +
    `<div class="math-grid">` +
    mathBlock('Input tokens saved', savedMath) +
    mathBlock('Dollars saved', usdMath) +
    mathBlock('Cost per imaged request', costPerRequestMath) +
    mathBlock('Share of total spend (diagnostic)', pctMath) +
    mathBlock('Token-equivalent (what the weekly cap counts)', tokeqMath) +
    `</div></section>`;

  return ledger + math;
}

// ---- request x-ray (image vs text breakdown) -----------------------------

export interface ContextMapData {
  id: number; // first image id (matches recent-table link)
  baselineTokens: number; // RAW count_tokens as plain text (cache-blind; sub-line only)
  realInput: number; // RAW input + cache_create + cache_read (cache-blind)
  baselineInputEff: number; // cache-WEIGHTED baseline — what text would actually be billed
  actualInputEff: number; // cache-WEIGHTED actual — what the images were actually billed
  haveBaseline: boolean; // weighted pair is trustworthy (baseline probe resolved)
  cacheRead: number; // cache_read tokens this turn. >0 ⇒ the actual request hit cache.
  warm: boolean; // did the TEXT baseline's prefix read warm? Server-observed only:
  // true iff the actual request had cache_read > 0. This keeps the text baseline
  // on the same cache state as the image path; no wall-clock-only inference.
  output: number;
  imageCount: number;
  /** Image blocks the CLIENT sent. They spend from the provider's cap exactly
   *  like ours, so they explain a turn that compressed less than usual. */
  nativeImages?: number;
  /** Image blocks really on the wire. Lower than imageCount when the history
   *  collapse absorbed messages that already carried our images. */
  wireImages?: number;
  /** Imaging steps that degraded to text because the cap was full. */
  imageBudgetSkips?: number;
  baselineImagedTokens?: number;
  buckets: Partial<Record<string, number>>; // bucket → chars rendered to PNG
  imageIds: number[]; // image-ring ids for the gallery
  compressed: boolean;
  model?: string;
  responsesComposition?: {
    instructions: number; systemDeveloper: number; userAssistant: number;
    functionCalls: number; functionOutputs: number; reasoningEncrypted: number;
    compactionOpaque: number; toolsJson: number; other: number;
    totalLocal: number; imageParts: number;
    completedFunctionPairs?: number; recentNativeFunctionPairs?: number;
    oldFunctionPairs?: number; openFunctionCalls?: number;
    orphanFunctionOutputs?: number; malformedFunctionItems?: number;
    imageableFunctionCalls?: number; imageableFunctionOutputs?: number;
    collapsedFunctionPairs?: number; collapsedFunctionCalls?: number;
    collapsedFunctionOutputs?: number;
  };
  /** Difference between the provider text counterfactual and local o200k buckets.
   * Can include envelope, tokenizer, and server-side additions. */
  responsesUnexplainedTokens?: number;
  restored?: boolean; // rebuilt from JSONL after a restart — PNG thumbnails are gone
}

const CTXMAP_BUCKETS: ReadonlyArray<readonly [string, string]> = [
  ['static_slab', 'System prompt + tool docs'],
  ['reminder', 'System-reminder blocks'],
  ['tool_result_prose', 'Tool results — prose'],
  ['tool_result_log', 'Tool results — logs'],
  ['tool_result_json', 'Tool results — JSON'],
  ['history', 'Older conversation turns'],
];

/** Image-vs-text breakdown for one request. */
export function renderContextMapFragment(
  c: ContextMapData | undefined,
  history: ContextMapData[] = [],
  notFound = false,
): string {
  const isLatest = c !== undefined && c.id === (history.at(-1)?.id ?? -1);
  if (notFound) {
    return `<div class="ctxmap"><div class="empty-note">That request's breakdown isn't kept anymore — only the most recent requests are. Pick <strong>Details</strong> on a newer row.</div></div>`;
  }
  if (!c || (c.baselineTokens <= 0 && c.imageCount <= 0)) {
    return `<div class="ctxmap"><div class="empty-note">Pick <strong>Details</strong> on a request to see exactly which parts became images and which stayed as text.</div></div>`;
  }
  // Cache-aware billing-equivalent basis — identical to the recent row's
  // As-text / Sent / Saved/lost columns. These are not raw token counts; they apply
  // Anthropic's cache rates so create/read misses are visible in the comparison.
  // The two panels can never contradict each other. The raw
  // count_tokens ratio is cache-blind: it over-states savings whenever the
  // prefix would have been a cheap cache-read, so it must NOT drive the
  // headline. It survives only as a clarifying sub-line below.
  const showCompare = c.haveBaseline && c.baselineInputEff > 0;
  const base = c.baselineInputEff;
  const real = c.actualInputEff;
  const pct = showCompare ? Math.round((1 - real / base) * 100) : 0;
  const rawShrink = c.baselineTokens > 0 ? Math.round((1 - c.realInput / c.baselineTokens) * 100) : 0;
  const totalImagedChars = CTXMAP_BUCKETS.reduce((a, [key]) => a + (c.buckets[key] ?? 0), 0);

  const imgRows = CTXMAP_BUCKETS.map(([key, label]) => [label, c.buckets[key] ?? 0] as const)
    .filter(([, ch]) => ch > 0)
    .map(
      ([label, ch]) =>
        `<div class="ctx-row"><span class="ctx-lbl">${label}</span><span class="ctx-val">${kFmt(ch)} chars</span></div>`,
    )
    .join('');

  const rc = c.responsesComposition;
  const responseRows: ReadonlyArray<readonly [string, number]> = rc
    ? [
        ['Instructions', rc.instructions],
        ['System / developer items', rc.systemDeveloper],
        ['User / assistant text kept native', rc.userAssistant],
        ['Native tool JSON', rc.toolsJson],
        ['Tool calls (function + custom)', rc.functionCalls],
        ['Tool outputs (function + custom)', rc.functionOutputs],
        ['Tool outputs eligible in old closed pairs', rc.imageableFunctionOutputs ?? 0],
        ['Tool outputs actually imaged this request', rc.collapsedFunctionOutputs ?? 0],
        ['Reasoning / encrypted items', rc.reasoningEncrypted],
        ['Compaction / opaque items', rc.compactionOpaque],
        ['Other Responses items', rc.other],
      ]
    : [];
  const responseBreakdown = rc
    ? `<div class="split-note" style="margin-top:12px"><strong>Original Responses composition (local o200k estimate)</strong></div>` +
      responseRows.filter(([, n]) => n > 0).map(([label, n]) =>
        `<div class="ctx-row"><span class="ctx-lbl">${label}</span><span class="ctx-val">${kFmt(n)} tok</span></div>`,
      ).join('') +
      `<div class="ctx-row"><span class="ctx-lbl">Imageable text baseline</span><span class="ctx-val">${kFmt(c.baselineImagedTokens ?? 0)} tok</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">Completed tool pairs (old / recent native / imaged)</span><span class="ctx-val">${rc.completedFunctionPairs ?? 0} (${rc.oldFunctionPairs ?? 0} / ${rc.recentNativeFunctionPairs ?? 0} / ${rc.collapsedFunctionPairs ?? 0})</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">Open calls kept native</span><span class="ctx-val">${rc.openFunctionCalls ?? 0}</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">Native image parts</span><span class="ctx-val">${rc.imageParts}</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">Provider tokens not explained locally</span><span class="ctx-val">${kFmt(c.responsesUnexplainedTokens ?? 0)} tok</span></div>` +
      `<div class="split-note">This diagnostic uses local o200k counts only; it never calls Anthropic /count_tokens.</div>`
    : '';

  const ids = c.imageIds ?? [];
  const modelLabel = c.model ? escapeHtml(c.model) : 'the model';
  const gallery = ids.length
    ? `<div class="pages-title">${ids.length} image page${ids.length === 1 ? '' : 's'} sent to ${modelLabel} — click one to read the exact text behind it:</div>` +
      `<div class="pages">` +
      ids
        .map(
          (id) =>
            `<img class="page" src="/proxy-latest-png?id=${id}" alt="page ${id}" loading="lazy" title="Click to read the source text behind page ${id}" onclick="ppPin(${id});ppSource(true)" onerror="this.classList.add('page-gone'); this.alt='page ${id} expired from buffer';" />`,
        )
        .join('') +
      `</div>`
    : c.restored && c.imageCount > 0
      ? `<div class="pages-title">${c.imageCount} image page${c.imageCount === 1 ? '' : 's'} were sent — thumbnails expired when the proxy restarted. The breakdown above is reconstructed from the saved log.</div>`
      : '';

  // Did the TEXT baseline's prefix read warm this turn? This follows the actual
  // request's observed cache state: cache_read > 0 means warm, cache_read === 0
  // means cold. No wall-clock-only counterfactual is credited.
  const warm = showCompare && c.warm;
  const google = c.model?.startsWith('gemini-') === true;
  const textNoun = warm ? 'cached text' : 'text';
  // Raw count_tokens can grow (imaging bloated a short prompt), so say so rather
  // than rendering a nonsensical "shrank -36%".
  const rawPhrase =
    rawShrink >= 0 ? `Raw content shrank ${rawShrink}%.` : `Raw content grew ${-rawShrink}%.`;
  const headline = !showCompare
    ? `<strong>${kFmt(c.actualInputEff || c.realInput)}</strong> billing-equivalent input tokens sent`
    : pct >= 0
      ? google
        ? `<span class="ctx-big">${pct}%</span> smaller — text would account as <strong>${kFmt(base)}</strong> input tokens; images account as <strong>${kFmt(real)}</strong>`
        : `<span class="ctx-big">${pct}%</span> smaller — ${textNoun} would bill as <strong>${kFmt(base)}</strong> input tokens; images billed as <strong>${kFmt(real)}</strong>`
      : google
        ? `<span class="ctx-big">${-pct}%</span> bigger — images account as <strong>${kFmt(real)}</strong> input tokens vs <strong>${kFmt(base)}</strong> for text`
        : `<span class="ctx-big">${-pct}%</span> bigger — images billed as <strong>${kFmt(real)}</strong> input tokens vs <strong>${kFmt(base)}</strong> for ${textNoun}`;
  // Clarifying sub-line. It must match the actual request's cache state: claiming
  // a 0.1× read discount when cache_read===0 would count hypothetical cache as a
  // fastpipe effect, so cold rows price both paths cold.
  const subnote = !showCompare
    ? 'Billed tokens count cache discounts (reads at 0.1×) — no trustworthy text baseline for this request yet.'
    : google
      ? `Same provider-token basis as the Saved column. The gap is token count. ${rawPhrase}`
    : !warm
      ? `No warm text cache this turn — the text counterfactual's prefix is priced at the 1.25× create rate (the same event the imaged path pays), identical basis to the Saved column. The gap is purely token count. ${rawPhrase}`
      : pct < 0 && rawShrink > 0
          ? `Billed = after cache discounts (reads at 0.1×), same basis as the Saved column. The raw text is ${rawShrink}% smaller, but most of it would have been a cheap cache-read — so imaging it cost more.`
          : `Billed = after cache discounts (reads at 0.1×), same basis as the Saved column. ${rawPhrase}`;
  const title = isLatest ? 'Latest request' : 'Selected request';

  // The provider caps a request at 100 image blocks and counts the CLIENT's
  // images against the same limit. Three facts are worth showing, and only when
  // they are true — a quiet turn should stay quiet:
  //   - the client brought its own images (they shrank our room),
  //   - we rendered more pages than we shipped (the collapse ate some),
  //   - we gave up on imaging something because the cap was full.
  const capBits: string[] = [];
  if ((c.nativeImages ?? 0) > 0) {
    capBits.push(`${c.nativeImages} image${c.nativeImages === 1 ? '' : 's'} came from your side and count against the same 100-image request cap`);
  }
  if (c.wireImages !== undefined && c.wireImages < c.imageCount + (c.nativeImages ?? 0)) {
    const absorbed = c.imageCount + (c.nativeImages ?? 0) - c.wireImages;
    capBits.push(`${absorbed} rendered page${absorbed === 1 ? '' : 's'} never went out — the history collapse absorbed those messages (${c.wireImages} on the wire)`);
  }
  if ((c.imageBudgetSkips ?? 0) > 0) {
    capBits.push(`${c.imageBudgetSkips} block${c.imageBudgetSkips === 1 ? '' : 's'} stayed as text because the image cap was full`);
  }
  const capNote = capBits.length
    ? `<div class="split-note cap-note">${capBits.map(escapeHtml).join(' · ')}</div>`
    : '';


  return (
    `<div class="ctxmap">` +
    `<div class="ctx-headline"><span class="ctx-title">${title}</span> ${headline}</div>` +
    `<div class="split-note ctx-subnote">${subnote}</div>` +
    `<div class="legend"><span class="tag tag-img">Became an image</span><span class="tag tag-txt">Stayed as text</span></div>` +
    `<div class="split">` +
    `<div class="split-col split-img">` +
    `<div class="split-head">Compressed into images <span class="split-sum">${kFmt(totalImagedChars)} chars · ${c.imageCount} page${c.imageCount === 1 ? '' : 's'}</span></div>` +
    (imgRows || `<div class="ctx-row muted-row">nothing imaged this request</div>`) +
    capNote +
    `<div class="split-note">fastpipe can misread exact values inside images — treat these as gist, not byte-exact.</div>` +
    `</div>` +
    `<div class="split-col split-txt">` +
    `<div class="split-head">Kept as plain text <span class="split-sum">byte-exact</span></div>` +
    `<div class="ctx-row"><span class="ctx-lbl">Your latest messages</span><span class="ctx-val">verbatim</span></div>` +
    `<div class="ctx-row"><span class="ctx-lbl">Model reply (output)</span><span class="ctx-val">${kFmt(c.output)} tok</span></div>` +
    `<div class="split-note">never imaged — safe for IDs, hashes and exact numbers.</div>` +
    `</div>` +
    `</div>` +
    responseBreakdown +
    gallery +
    `</div>`
  );
}

// ---- recent requests table -----------------------------------------------

function statusCls(status: number): string {
  if (status >= 500) return 'bad';
  if (status >= 400) return 'warn';
  return 'good';
}

export function renderRecentFragment(p: RecentPayload): string {
  const rows = (p.recent ?? []).slice().reverse();
  const body =
    rows.length === 0
      ? `<tr><td colspan="9" class="empty-cell">No requests yet — they stream in here live.</td></tr>`
      : rows
          .map((e: RecentRow) => {
            const viewId = (e.img_ids ?? (e.img_id != null ? [e.img_id] : []))[0];
            const viewLink =
              viewId != null
                ? `<a class="row-view" href="#" hx-get="/fragments/context-map?req=${viewId}" hx-target="#frag-context-map" hx-swap="innerHTML">Details →</a>`
                : `<span class="muted">—</span>`;
            const saved = e.session_saved_so_far_delta;
            // A loss that disappears when the newly written prefix is repriced at
            // the read rate is just the one-time cache-create premium — the
            // purchase price of the cheap cache reads on the turns that follow.
            // Mark it so create turns don't read as gate failures.
            const cc = e.cache_create ?? 0;
            const createLoss =
              saved != null &&
              saved < 0 &&
              cc > 0 &&
              saved + cc * (CACHE_CREATE_RATE - CACHE_READ_RATE) > 0;
            const createNote = createLoss
              ? ` <span class="mk-create" title="Cache-create turn: this loss is the one-time ${CACHE_CREATE_RATE}× premium for writing ${numFmt(cc)} tokens to cache. Later turns re-read that prefix at ${CACHE_READ_RATE}×, which typically recoups it.">create</span>`
              : '';
            const savedCell = saved == null
              ? `<td class="num muted">—</td>`
              : saved > 0
                ? `<td class="num pos">${numFmt(saved)}</td>`
                : saved < 0
                  ? `<td class="num neg">${numFmt(saved)}${createNote}</td>`
                  : `<td class="num">0</td>`;
            const imaged = e.cc_added
              ? `<span class="badge badge-img">image</span>`
              : `<span class="badge badge-txt">text</span>`;
            return (
              `<tr>` +
              savedCell +
              `<td>${e.model ? `<code>${escapeHtml(e.model)}</code>` : '<span class="muted">—</span>'}</td>` +
              `<td>${imaged}</td>` +
              `<td class="num">${e.baseline_input != null ? numFmt(e.baseline_input) : '—'}</td>` +
              `<td class="num">${e.actual_input != null ? numFmt(e.actual_input) : '—'}</td>` +
              `<td class="num">${e.cache_read != null ? numFmt(e.cache_read) : '—'}</td>` +
              `<td><span class="pill pill-${statusCls(e.status)}">${e.status}</span></td>` +
              `<td class="endp">${escapeHtml(shortPath(e.path))}</td>` +
              `<td class="num">${viewLink}</td>` +
              `</tr>`
            );
          })
          .join('');
  return (
    `<table class="rtable"><thead><tr>` +
    // Columns run from the one that matters most to the one that matters least; the link stays in view.
    `<th class="num" title="As-text minus Sent; negative means imaging cost more">Saved/lost</th>` +
    `<th>Model</th>` +
    `<th title="Was this request's context compressed into an image?">Sent as</th>` +
    `<th class="num" title="Billing-equivalent input if kept as plain text, after cache create/read rates">As text</th>` +
    `<th class="num" title="Actual billing-equivalent input after imaging, after cache create/read rates">Sent</th>` +
    `<th class="num" title="Tokens the provider reported as served from cache">Cache hits</th>` +
    `<th>Result</th>` +
    `<th>Endpoint</th>` +
    `<th></th>` +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

// ---- image ↔ source inspector --------------------------------------------

export interface LatestFragmentInput {
  payload: RecentPayload;
  pin: number | null; // pinned image id, or null to follow latest
  showSource: boolean;
  sourceText: string | null; // null = not captured
}

export function renderLatestFragment(inp: LatestFragmentInput): string {
  const { payload, pin, showSource, sourceText } = inp;
  const hasPreview = payload.has_preview === true;
  const meta = payload.preview_meta ?? '';
  const imageIds = payload.image_ids ?? [];
  const pinnedEvicted = pin != null && !imageIds.includes(pin);

  // Pinned id, or latest (cache-busted by meta).
  const imgSrc =
    pin != null
      ? `/proxy-latest-png?id=${pin}`
      : `/proxy-latest-png?t=${encodeURIComponent(meta)}`;

  let main: string;
  if (pin != null && pinnedEvicted) {
    main = `<div class="evicted">image #${pin} is no longer in the buffer</div>`;
  } else if (pin != null || hasPreview) {
    // When source pane is open the image appears inside the pairing — don't duplicate it.
    main = showSource ? '' : `<div class="frame"><img src="${imgSrc}" alt="rendered page" /></div>`;
  } else {
    main = `<div class="empty-note">No images yet — they appear the instant fastpipe compresses a request.</div>`;
  }

  // Every button of the viewer sits in one row above the image, with the caption beside them.
  const showBtn = pin != null ? !pinnedEvicted : hasPreview;
  const caption =
    pin != null ? `image #${pin}` : meta ? `${escapeHtml(meta)}, top-left at native size` : '';
  const backBtn =
    pin != null ? `<button class="mini-btn" type="button" onclick="ppPin(null)">Back to latest</button>` : '';
  const srcBtn = showBtn
    ? `<button class="mini-btn" type="button" onclick="ppSource(${showSource ? 'false' : 'true'})">${showSource ? 'Hide source text' : 'Show source text'}</button>`
    : '';
  const bar =
    backBtn || srcBtn
      ? `<div class="viewer-bar">${backBtn}${srcBtn}<span class="mini-label">${caption}</span></div><!-- /viewer-bar -->`
      : caption
        ? `<div class="viewer-caption">${caption}</div>`
        : '';

  let pane = '';
  if (showSource) {
    pane =
      sourceText == null
        ? `<div class="evicted">source text wasn't captured for this image</div>`
        : `<div class="pairing">` +
          `<div class="pair-col"><div class="pair-head pair-img">What the model sees · image</div><div class="frame frame-sm"><img src="${imgSrc}" alt="rendered page" /></div></div>` +
          `<div class="pair-mid">made from ↓</div>` +
          `<div class="pair-col"><div class="pair-head pair-txt">The original text · byte-exact</div><pre class="src-pane">${escapeHtml(sourceText)}</pre></div>` +
          `</div>`;
  }

  return bar + main + pane;
}

// ---- sessions bar chart --------------------------------------------------

const TOP_N = 8;

export function renderSessionsFragment(p: SessionsPayload): string {
  const all = p.sessions ?? [];
  const rows = [...all]
    .sort((a, b) => (b.tokensSavedEst ?? 0) - (a.tokensSavedEst ?? 0))
    .slice(0, TOP_N);
  const max = rows.reduce((m, s) => Math.max(m, s.tokensSavedEst ?? 0), 0);

  const label = (s: SessionRow) => {
    const proj = s.claudeCode?.projectPath || s.project;
    return proj ? shortPath(proj) : s.id.slice(0, 8);
  };
  const barPct = (v: number) => (max <= 0 || v <= 0 ? 0 : (v / max) * 100);

  const status = `<div class="status">${all.length} session${all.length === 1 ? '' : 's'} tracked</div>`;
  if (rows.length === 0) return status + `<div class="empty">No sessions yet.</div>`;

  const chart = rows
    .map((s) => {
      const v = s.tokensSavedEst ?? 0;
      const pct = barPct(v);
      const fill = pct > 0 ? `<div class="bar-fill" style="width:max(3px,${pct}%)"></div>` : '';
      return (
        `<div class="bar-row">` +
        `<div class="bar-label" title="${escapeHtml(s.claudeCode?.projectPath || s.project || s.id)}">${escapeHtml(label(s))}</div>` +
        `<div class="bar-track">${fill}</div>` +
        `<div class="bar-val${v < 0 ? ' neg' : ''}">${numFmt(v)}</div>` +
        `</div>`
      );
    })
    .join('');

  return (
    status +
    `<div class="bars">${chart}</div>` +
    `<div class="axis">tokens saved per session (cache-aware) · top ${rows.length} of ${all.length}</div>`
  );
}

// ---- full-history stats table --------------------------------------------

export function renderStatsTableFragment(p: FullStatsPayload): string {
  if (p.error || !p.summary) {
    return `<div class="status">${escapeHtml(p.error || 'no data')}</div><table class="dtable"><tbody></tbody></table>`;
  }
  const s = p.summary;
  const totalIn = (s.inputTokensTotal || 0) + (s.cacheCreateTokensTotal || 0) + (s.cacheReadTokensTotal || 0);
  const hitRateTok = totalIn > 0 ? ((s.cacheReadTokensTotal / totalIn) * 100).toFixed(1) + '%' : '-';
  const hitRateEv =
    s.eventsWithUsage > 0 ? ((s.cacheHitEvents / s.eventsWithUsage) * 100).toFixed(1) + '%' : '-';
  const charRatio =
    s.origCharsTotal > 0 ? (s.imageBytesTotal / s.origCharsTotal).toFixed(2) : '-';

  // NOTE: the literal word "requests" is asserted by tests.
  const tr = (k: string, v: string) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`;
  return (
    `<div class="status">${numFmt(p.parsed)} events parsed from disk</div>` +
    `<table class="dtable"><tbody>` +
    tr('requests', numFmt(s.total)) +
    tr('2xx / 4xx / 5xx', `${numFmt(s.ok2xx)} / ${numFmt(s.err4xx)} / ${numFmt(s.err5xx)}`) +
    tr('compressed', numFmt(s.compressed)) +
    tr('passthrough', numFmt(s.passthrough)) +
    tr('input tokens', numFmt(s.inputTokensTotal)) +
    tr('cache create', numFmt(s.cacheCreateTokensTotal)) +
    tr('cache read', numFmt(s.cacheReadTokensTotal)) +
    tr('cache hit (by tokens)', hitRateTok) +
    tr('cache hit (by events)', hitRateEv) +
    tr('original chars', numFmt(s.origCharsTotal)) +
    tr('image bytes', numFmt(s.imageBytesTotal)) +
    tr('bytes / char', charRatio) +
    (s.pinEvents
      ? tr(
          'pin footer (uncached)',
          `${numFmt(s.pinCharsTotal ?? 0)} chars / ${numFmt(s.pinEvents)} req`,
        )
      : '') +
    tr('latency p50 / p95', `${numFmt(s.durationP50)} / ${numFmt(s.durationP95)} ms`) +
    tr('first-byte p50 / p95', `${numFmt(s.firstByteP50)} / ${numFmt(s.firstByteP95)} ms`) +
    `</tbody></table>`
  );
}

// ---- page shell -------------------------------------------------------------

// The mark: the f of fastpipe drawn as a bent pipe, with a flange at its open end and the crossbar as a second
// length of pipe. One colour, so in the page it takes the accent from CSS (currentColor) in both themes.
// assets/logo.svg carries the same shapes for the README: change both together.
const logoShapes = (colour: string): string =>
  `<path d="M44 112V52A26 26 0 0 1 70 26H90" fill="none" stroke="${colour}" stroke-width="24" stroke-linejoin="round"/>` +
  `<rect x="87" y="8" width="13" height="36" rx="3.5" fill="${colour}"/>` +
  `<rect x="18" y="58" width="58" height="14" rx="3.5" fill="${colour}"/>`;

const LOGO =
  `<svg class="logo" viewBox="0 0 120 120" role="img" aria-label="fastpipe">${logoShapes('currentColor')}</svg>`;

// Favicon: the same mark in white on the accent blue. Inlined as an SVG data URI so the dashboard stays
// self-contained (no extra route or static asset). Keep the blue in sync with --accent in the CSS below.
const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="27" fill="#1f6feb"/>` +
      `<g transform="translate(16.5 15) scale(.75)">${logoShapes('#fff')}</g></svg>`,
  );

// No web fonts and no images: the page stays one small self-contained document. Red is only for a
// loss or a failure.
const CSS = `
  /* One screen, read from left to right. A bar of buttons, then a strip that opens with the saving
     and continues with the numbers, then the view picked in the bar. Blue is fastpipe's own colour
     and marks the saving. */
  :root {
    --canvas: #e9ecf1; --pane: #ffffff; --inset: #f3f5f8; --raise: #eef0f4; --hover: #e4e7ed;
    --ink: #14151a; --muted: #555966; --faint: #646977;
    --line-soft: #eceef2; --line: #e1e4ea; --line-strong: #cdd1d9;
    --accent: #1f6feb; --accent-ink: #1558c9;
    --red: #b02016; --green: #1a7f37; --amber: #8a6100;
    --tint-a: rgba(31, 111, 235, .10); --tint-b: rgba(47, 111, 224, .07);
    --band: linear-gradient(120deg, #c9daf8, #e3eafa);
    --band-loss: linear-gradient(120deg, #f8d3cd, #f6e2e6);
    --tile-saved: linear-gradient(160deg, #2872e4, #1b54c2);
    --tile-quiet: linear-gradient(160deg, #69738a, #4b5469);
    --tile-over: linear-gradient(160deg, #c8402f, #a01246);
    --pipe-quiet: #5d6880; --pipe-saved: #2468d8; --pipe-over: #b4283c; --switch-on: #34c759;
    --float: 0 1rem 3rem rgba(20, 21, 26, .18);
    --radius: .625rem; --radius-pane: 1rem; --radius-small: .4375rem;
    --sans: 'Geist Variable', 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    --mono: 'Geist Mono Variable', 'Geist Mono', ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
    color-scheme: light;
  }
  /* Dark theme. Set before first paint by the <head> script (localStorage 'pp-theme' else system
     pref); toggled by ppTheme(). */
  :root[data-theme="dark"] {
    --canvas: #090a0c; --pane: #141619; --inset: #1d2024; --raise: #202327; --hover: #272a2f;
    --ink: #f5f6f3; --muted: #a9ada6; --faint: #8f948d;
    --line-soft: #23262a; --line: #2c2f34; --line-strong: #3b3f45;
    --accent: #4c8dff; --accent-ink: #8fb8ff;
    --red: #ff7b6e; --green: #86e59a; --amber: #efc04a;
    --tint-a: rgba(76, 141, 255, .13); --tint-b: rgba(47, 111, 224, .09);
    --band: linear-gradient(120deg, #4b5a78, #2a3145);
    --band-loss: linear-gradient(120deg, #7c2a22, #4d1424);
    --tile-quiet: linear-gradient(160deg, #56607a, #2f3545);
    --pipe-quiet: #414a5e; --switch-on: #30d158;
    --float: 0 1rem 3rem rgba(0, 0, 0, .55);
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  /* a colour never jumps: it fades, on hover, on a switch and on the change of theme */
  *, *::before, *::after { transition: background-color .25s ease, border-color .25s ease, color .25s ease; }
  html { -webkit-text-size-adjust: 100%; background: var(--canvas); }
  body {
    display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: .75rem;
    margin: 0 auto; max-width: 120rem; min-height: 100vh; padding: 0 .75rem .75rem;
    background:
      radial-gradient(68.75rem 38.75rem at 12% -12%, var(--tint-a), transparent 62%),
      radial-gradient(56.25rem 35rem at 104% -6%, var(--tint-b), transparent 60%);
    background-repeat: no-repeat;
    color: var(--ink); font: .875rem/1.5 var(--sans); -webkit-font-smoothing: antialiased;
  }
  strong, b { font-weight: 600; }
  a { color: var(--accent-ink); }
  button { font: inherit; }
  code { font-family: var(--mono); font-size: .92em; color: var(--ink); }
  pre {
    margin: .5rem 0; padding: .625rem .75rem; overflow-x: auto;
    background: var(--inset); border: 1px solid var(--line); border-radius: var(--radius);
    font: .75rem/1.55 var(--mono); color: var(--ink);
  }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .good { color: var(--green); }
  .bad { color: var(--red); }
  .muted { color: var(--faint); }

  /* the bar: the only row of buttons that is always on screen */
  .bar {
    display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto auto auto auto; align-items: center;
    gap: .5rem .625rem; padding: .625rem .25rem 0;
  }
  .brand { grid-column: 1; grid-row: 1; display: flex; align-items: center; gap: .625rem; min-width: 0; margin-right: .75rem; }
  .logo { width: 1.5rem; height: 1.5rem; flex: none; color: var(--accent); }
  .wordmark { margin: 0; font-size: .8125rem; font-weight: 600; letter-spacing: .16em; text-transform: uppercase; color: var(--ink); }
  /* Which machine is this? Two dashboards from two hosts look identical otherwise. */
  .hostchip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .8125rem; color: var(--faint); }
  .adv-btn { grid-column: 2; grid-row: 1; }
  .adv-btn::after { content: ""; display: inline-block; width: .375rem; height: .375rem; margin: 0 0 .125rem .5rem; border: solid currentColor; border-width: 0 1.5px 1.5px 0; transform: rotate(45deg); transition: transform .2s ease; }
  .adv-btn[aria-expanded="true"]::after { margin-bottom: -.125rem; transform: rotate(-135deg); }
  .tabs[hidden] { display: none; }
  .tabs { grid-column: 3; grid-row: 1; display: flex; gap: .25rem; min-width: 0; padding: 2px; overflow-x: auto; scrollbar-width: none; }
  .tab {
    flex: none; padding: .3125rem .875rem; background: transparent; color: var(--muted);
    border: 1px solid transparent; border-radius: var(--radius);
    font-size: .875rem; font-weight: 500; line-height: 1.4; cursor: pointer; transition: background-color .11s, color .11s;
  }
  .tab:hover { background: var(--raise); color: var(--ink); }
  .tab[aria-pressed="true"] { background: var(--pane); border-color: var(--line); color: var(--ink); font-weight: 600; }
  /* on/off: the state and its button are items of the bar; the notice takes a line under it */
  #frag-toggle, .switch { display: contents; }
  .switch-state, .theme-label { grid-row: 1; margin-right: -.125rem; font-size: .8125rem; white-space: nowrap; color: var(--muted); }
  .switch-state { grid-column: 4; }
  .switch-state.off { color: var(--red); font-weight: 600; }
  .theme-label { grid-column: 6; margin-left: .375rem; }
  /* the two switches: a track and a knob that slides across it */
  .switch-btn, .theme-btn {
    grid-row: 1; position: relative; flex: none; width: 2.75rem; height: 1.625rem; padding: 0;
    border: 0; border-radius: 999px; background: var(--line-strong); cursor: pointer;
  }
  .switch-btn { grid-column: 5; }
  .theme-btn { grid-column: 7; }
  .switch-btn::after, .theme-btn::after {
    content: ""; position: absolute; top: .125rem; left: .125rem; width: 1.375rem; height: 1.375rem;
    border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .28);
    transition: transform .22s ease, background-color .22s ease, box-shadow .22s ease;
  }
  .switch-btn[aria-checked="true"] { background: var(--switch-on); }
  .switch-btn[aria-checked="true"]::after, .theme-btn[aria-checked="true"]::after { transform: translateX(1.125rem); }
  /* day and night: the knob is a sun on a pale track, then a crescent on a dark one */
  .theme-btn { background: #cfe0fb; }
  .theme-btn::after { background: #f5b301; box-shadow: 0 0 0 .125rem rgba(245, 179, 1, .28); }
  .theme-btn[aria-checked="true"] { background: #283350; }
  .theme-btn[aria-checked="true"]::after { background: transparent; box-shadow: inset -.4375rem -.125rem 0 0 #f2f4f8; }
  .switch-btn:focus-visible, .theme-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* the note on which models are validated opens from the mark next to the name */
  .brand-tip {
    position: relative; flex: none; display: inline-grid; place-items: center; width: 1.125rem; height: 1.125rem;
    border-radius: 50%; background: var(--raise); border: 1px solid var(--line); text-decoration: none;
    font-size: .6875rem; font-weight: 600; color: var(--muted);
  }
  .brand-tip::after { left: 0; right: auto; top: calc(100% + .375rem); width: min(21rem, 80vw); }
  .banner { grid-column: 1 / -1; grid-row: 2; padding: .5rem .75rem; border-radius: var(--radius); background: color-mix(in srgb, var(--red) 12%, transparent); font-size: .8125rem; color: var(--muted); }
  .banner strong { color: var(--red); }
  .hint { margin: 0; font-size: .75rem; color: var(--faint); }

  /* one button everywhere: a raised key */
  .mini-btn, .chip {
    flex: none; padding: .3125rem .75rem; background: var(--raise); color: var(--ink);
    border: 1px solid var(--line); border-radius: var(--radius);
    font-size: .8125rem; font-weight: 500; line-height: 1.4; white-space: nowrap; cursor: pointer;
    transition: background-color .11s, border-color .11s;
  }
  .mini-btn:hover, .chip:hover { background: var(--hover); border-color: var(--line-strong); }

  /* the strip: the saving on the left, the numbers after it, the pipe under both */
  .strip {
    display: grid; grid-template-columns: minmax(24rem, 34%) minmax(0, 1fr); grid-template-areas: "head nums" "pipe pipe";
    background: var(--pane); border: 1px solid var(--line-soft); border-radius: var(--radius-pane);
  }
  #frag-session, .gauge { display: contents; }
  .head {
    grid-area: head; min-width: 0; padding: 1.5rem 1.75rem 1.75rem;
    border-radius: calc(var(--radius-pane) - 1px) 0 0 0;
    background: linear-gradient(to bottom, transparent 45%, var(--pane)), linear-gradient(to right, transparent 30%, var(--pane)), var(--band);
  }
  .gauge-loss .head { background: linear-gradient(to bottom, transparent 45%, var(--pane)), linear-gradient(to right, transparent 30%, var(--pane)), var(--band-loss); }
  .head-title { margin: 0; font-size: 1.125rem; font-weight: 600; line-height: 1.25; color: var(--muted); }
  .gauge-num { display: block; margin-bottom: .375rem; font-size: clamp(4rem, 8vw, 6.5rem); font-weight: 700; line-height: 1; letter-spacing: -.04em; font-variant-numeric: tabular-nums; color: var(--ink); }
  .gauge-empty .head-title { font-size: 1.5rem; color: var(--ink); }
  .head-sub { margin: .375rem 0 0; font-size: .75rem; color: var(--muted); }

  /* the numbers: one column each, in order of weight */
  #frag-header { grid-area: nums; min-width: 0; }
  .numbers { height: 100%; }
  .list-head { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .ledger { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); height: 100%; margin: 0; }
  .ledger-row { position: relative; display: flex; flex-direction: column; gap: .125rem; min-width: 0; padding: 2.25rem 1.125rem 1rem; border-left: 1px solid var(--line-soft); }
  .ledger dt { font-size: .75rem; font-weight: 500; color: var(--muted); }
  .ledger dd { margin: 0; }
  .ledger-val { font: 600 clamp(1.0625rem, 1.5vw, 1.375rem)/1.2 var(--mono); white-space: nowrap; letter-spacing: -.02em; font-variant-numeric: tabular-nums; color: var(--ink); }
  .ledger-note { font-size: .75rem; line-height: 1.35; color: var(--faint); }
  .ledger-val.pos { color: var(--accent-ink); }
  .ledger-val.neg, .ledger-val.neg + .ledger-note { color: var(--red); }
  .ledger-val.muted-val { font-family: var(--sans); font-size: 1rem; font-weight: 400; letter-spacing: 0; color: var(--faint); }
  /* a label that explains itself on hover or keyboard focus */
  .q { cursor: help; text-decoration: underline dotted var(--line-strong); text-underline-offset: 3px; }
  .q::after {
    content: attr(data-tip); position: absolute; z-index: 50; left: .5rem; right: .5rem; top: calc(100% - .5rem);
    padding: .5rem .625rem; border-radius: var(--radius);
    background: var(--ink); color: var(--canvas); box-shadow: var(--float);
    font-size: .75rem; font-weight: 400; line-height: 1.4; text-align: left;
    pointer-events: none; opacity: 0; visibility: hidden; transform: translateY(-4px);
    transition: opacity .11s, transform .11s, visibility .11s;
  }
  .q:hover::after, .q:focus-visible::after { opacity: 1; visibility: visible; transform: translateY(0); }

  /* the pipe: the whole on the left, then one tile for each part of it */
  .record { grid-area: pipe; display: flex; align-items: center; gap: 1rem; min-width: 0; padding: .25rem .75rem .75rem 1.75rem; }
  .rec-head { flex: none; display: flex; align-items: baseline; gap: .5rem; white-space: nowrap; }
  .rec-name { font-size: .8125rem; font-weight: 600; color: var(--ink); }
  .rec-num { font: 600 .8125rem var(--mono); font-variant-numeric: tabular-nums; color: var(--muted); }
  .gauge-track {
    flex: 1 1 auto; display: flex; min-width: 0; height: 2.75rem; overflow: hidden; border-radius: var(--radius);
    background: linear-gradient(to right, var(--pipe-quiet) calc(var(--cut, 200%) - 4.5rem), var(--pipe-saved) calc(var(--cut, 200%) + 4.5rem));
  }
  .gauge-loss .gauge-track { background: linear-gradient(to right, var(--pipe-quiet) calc(var(--cut, 200%) - 4.5rem), var(--pipe-over) calc(var(--cut, 200%) + 4.5rem)); }
  .gauge-track:empty { background: none; }
  .gauge-track:empty { border: 1px dashed var(--line-strong); border-radius: var(--radius); }
  .gauge-seg {
    display: flex; align-items: center; justify-content: space-between; gap: .75rem;
    flex: 0 1 auto; min-width: .5rem; overflow: hidden; padding: 0 .875rem;
    color: #fff; white-space: nowrap; container-type: inline-size;
  }
  .seg-name { font-size: .8125rem; font-weight: 600; }
  .seg-num { font: 600 .9375rem var(--mono); font-variant-numeric: tabular-nums; }
  /* a tile too narrow for its words keeps the amount, then only its colour */
  @container (max-width: 7.5rem) { .seg-name { display: none; } }
  @container (max-width: 3.5rem) { .seg-num { display: none; } }

  /* the view: records side by side, the one that matters most on the left */
  .views { display: grid; min-width: 0; min-height: 0; }
  .view { display: grid; grid-template-columns: minmax(0, 1fr); gap: .75rem; align-content: start; min-width: 0; min-height: 0; }
  .view[hidden] { display: none; }
  .card {
    display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: 1rem 1.125rem;
    background: var(--pane); border: 1px solid var(--line-soft); border-radius: var(--radius-pane);
  }
  .card-head { flex: none; margin: 0 0 .75rem; font-size: .9375rem; font-weight: 600; color: var(--ink); }
  .card { container-type: inline-size; }
  .card > [id^="frag-"] { flex: 1 1 auto; min-height: 0; overflow: auto; scrollbar-width: thin; }
  .card.help { display: block; overflow: auto; scrollbar-width: thin; }
  #frag-recent { max-height: 23.25rem; }
  @media (min-width: 1100px) {
    #v-images { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr); }
    #v-sessions { grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr); }
    #v-setup { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    #v-setup > .card:first-child { grid-column: 1 / -1; }
  }
  /* On a screen large enough the page never scrolls: each record scrolls on its own. */
  @media (min-width: 1100px) and (min-height: 640px) {
    body { height: 100vh; overflow: hidden; }
    .view { grid-template-rows: minmax(0, 1fr); align-content: stretch; }
    #v-setup { grid-template-rows: auto minmax(0, 1fr); }
    #frag-recent { max-height: none; }
  }
  @media (max-width: 1099px) {
    .ledger { grid-auto-flow: row; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); }
    .ledger-row { padding: .75rem 1.125rem; }
  }
  @media (max-width: 760px) {
    .wordmark, .switch-state, .theme-label, .hostchip { display: none; }
    .brand-tip::after { position: fixed; left: .5rem; right: .5rem; top: 3rem; width: auto; }
    .bar { grid-template-columns: max-content max-content max-content auto auto auto auto; padding-bottom: 2px; overflow-x: auto; scrollbar-width: none; }
    .brand { margin-right: 0; }
    .tabs { overflow: visible; }
    .banner { position: sticky; left: 0; max-width: calc(100vw - 2rem); }
    .strip { grid-template-columns: minmax(0, 1fr); grid-template-areas: "head" "pipe" "nums"; }
    .head { border-radius: calc(var(--radius-pane) - 1px) calc(var(--radius-pane) - 1px) 0 0; }
    .record { flex-direction: column; align-items: stretch; gap: .375rem; padding: .625rem .75rem .75rem; }
    .gauge-track { flex: none; }
    .ledger-row { border-left: 0; }
  }

  /* formulas */
  .drawer-intro { max-width: 45rem; margin: 0 0 1rem; font-size: .8125rem; color: var(--muted); }
  .drawer-intro em { font-style: normal; font-weight: 600; color: var(--ink); }
  .math-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 1.25rem 2rem; }
  .math-block { min-width: 0; }
  .math-block h4 { margin: 0 0 .375rem; font-size: .8125rem; font-weight: 600; color: var(--ink); }
  .formula { padding-top: .5rem; border-top: 1px solid var(--line); font: .71875rem/1.6 var(--mono); color: var(--muted); white-space: pre-wrap; word-break: break-word; }
  .formula .k { color: var(--faint); }
  .formula .v { color: var(--ink); }
  .formula .op { color: var(--accent-ink); }
  .formula .sp { height: .375rem; }
  .formula .src { display: block; margin-top: .4375rem; font-size: .6875rem; color: var(--faint); }

  /* image vs text breakdown */
  .ctxmap { font-size: .8125rem; }
  .empty-note, .evicted { font-size: .8125rem; color: var(--faint); }
  .ctx-headline { margin-bottom: .75rem; color: var(--muted); }
  .ctx-title { display: inline-block; margin-right: .375rem; font-weight: 600; color: var(--ink); }
  .ctx-big { font: 600 .9375rem var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); }
  .ctx-subnote { font-size: .71875rem; color: var(--faint); }
  .legend { display: flex; gap: 1rem; margin: .75rem 0; }
  .tag { position: relative; padding-left: 1rem; font-size: .75rem; color: var(--muted); }
  .tag::before { content: ''; position: absolute; left: 0; top: 50%; transform: translateY(-50%); width: .5625rem; height: .5625rem; border-radius: .1875rem; }
  .tag-img::before { background: var(--tile-saved); }
  .tag-txt::before { background: var(--tile-quiet); }
  /* two blocks, each under a filled head in the colour of its tag */
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; }
  @container (max-width: 30rem) { .split { grid-template-columns: 1fr; } }
  .split-col { min-width: 0; overflow: hidden; padding-bottom: .625rem; background: var(--inset); border-radius: var(--radius); }
  .split-col > :not(.split-head) { margin-left: .875rem; margin-right: .875rem; }
  .split-head { display: flex; flex-direction: column; gap: .125rem; margin-bottom: 0; padding: .75rem .875rem 1.75rem; font-size: .875rem; font-weight: 600; color: #fff; }
  .split-img .split-head { background: linear-gradient(to bottom, transparent 62%, var(--inset)), var(--tile-saved); }
  .split-txt .split-head { background: linear-gradient(to bottom, transparent 62%, var(--inset)), var(--tile-quiet); }
  .split-sum { font: .71875rem var(--mono); font-weight: 400; color: rgba(255, 255, 255, .88); }
  .ctx-row { display: flex; justify-content: space-between; gap: .625rem; padding: .3125rem 0; border-bottom: 1px solid var(--line); font-size: .8125rem; }
  .ctx-row:last-of-type { border-bottom: none; }
  .ctx-lbl { color: var(--muted); }
  .ctx-val { font-family: var(--mono); font-size: .75rem; font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--ink); }
  .muted-row { color: var(--faint); }
  .split-note { margin-top: .5rem; font-size: .71875rem; color: var(--faint); }
  /* Cap notes explain a turn that compressed less than the user expects, so they must read as a
     reason, not as fine print. */
  .cap-note { padding-left: .5rem; border-left: 2px solid var(--accent); color: var(--ink); }
  .pages-title { margin: .875rem 0 .375rem; font-size: .75rem; color: var(--muted); }
  .pages { display: flex; flex-wrap: wrap; gap: .375rem; }
  .page {
    height: 130px; width: auto; max-width: 230px; object-fit: contain; object-position: top left; image-rendering: pixelated;
    background: #fff; border: 1px solid var(--line-strong); border-radius: var(--radius-small); cursor: pointer; transition: border-color .11s;
  }
  .page:hover { border-color: var(--accent); }
  .page.page-gone { width: 150px; height: 56px; background: transparent; border: 1px dashed var(--line-strong); color: var(--faint); font-size: .6875rem; cursor: default; }

  /* tables */
  .row-view { color: var(--accent-ink); text-decoration: none; cursor: pointer; white-space: nowrap; }
  .row-view:hover { text-decoration: underline; }
  table.rtable, table.dtable { width: 100%; border-collapse: collapse; font-size: .8125rem; }
  .rtable th, .dtable th { padding: .4375rem .5rem; text-align: left; white-space: nowrap; font-size: .75rem; font-weight: 500; color: var(--faint); border-bottom: 1px solid var(--line); }
  .rtable td, .dtable td { padding: .4375rem .5rem; vertical-align: middle; font-variant-numeric: tabular-nums; color: var(--muted); border-bottom: 1px solid var(--line-soft); }
  .rtable th:first-child, .dtable th:first-child, .rtable td:first-child, .dtable td:first-child { padding-left: 0; }
  .rtable tr:last-child td, .dtable tr:last-child td { border-bottom: none; }
  .rtable tbody tr:hover { background: var(--hover); }
  /* The request table scrolls inside its record, under a header that stays put. */
  #frag-recent table { min-width: max-content; }
  #frag-recent th { position: sticky; top: 0; z-index: 1; background: var(--pane); }
  #frag-recent th:last-child, #frag-recent td:last-child {
    position: sticky; right: 0; padding-right: 0; background: var(--cell, var(--pane));
  }
  /* columns that scroll under the link fade out instead of being sliced mid-letter */
  #frag-recent th:last-child::before, #frag-recent td:last-child::before {
    content: ""; position: absolute; top: 0; bottom: 0; right: 100%; width: 2rem; pointer-events: none;
    background: linear-gradient(to right, transparent, var(--cell, var(--pane)) 80%);
  }
  #frag-recent th:last-child { z-index: 2; }
  #frag-recent tbody tr:hover td:last-child { --cell: var(--hover); }
  /* the history is a list of label and value pairs: run it in as many columns as fit, top to
     bottom, so each value stays next to its label and the width of the record gets used */
  table.dtable, .dtable tbody { display: block; }
  .dtable tbody { columns: 3 15rem; column-gap: 2.5rem; }
  .dtable tr { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; break-inside: avoid; border-bottom: 1px solid var(--line-soft); }
  .dtable td, .dtable tr:last-child td { padding: .4375rem 0; border-bottom: none; }
  .dtable td.num { white-space: nowrap; color: var(--ink); font-family: var(--mono); }
  th.num, td.num { text-align: right; }
  td.num { font-family: var(--mono); font-size: .75rem; color: var(--ink); }
  td.pos { font-weight: 600; }
  td.neg { color: var(--red); font-weight: 600; }
  .endp { font: .75rem var(--mono); color: var(--ink); }
  .empty-cell { padding: 1.125rem 0; color: var(--faint); }
  /* status and "sent as" are plain words: only a failure gets colour */
  .pill { font: 600 .75rem var(--mono); font-variant-numeric: tabular-nums; }
  .pill-good { color: var(--muted); }
  .pill-warn { color: var(--amber); }
  .pill-bad { color: var(--red); }
  .badge { font-size: .75rem; }
  .badge-img { color: var(--accent-ink); }
  .badge-txt { color: var(--faint); }
  .mk-create { margin-left: .3125rem; font-size: .6875rem; color: var(--faint); border-bottom: 1px dotted var(--faint); cursor: help; white-space: nowrap; }

  /* image and source: its buttons share one row with the caption */
  .viewer-bar { display: flex; align-items: center; gap: .5rem; margin-bottom: .5rem; }
  .mini-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .75rem; color: var(--faint); }
  .viewer-caption { margin-bottom: .5rem; font-size: .75rem; color: var(--faint); }
  .frame { max-height: 22.5rem; overflow: auto; padding: .25rem; background: #fff; border: 1px solid var(--line-strong); border-radius: var(--radius); scrollbar-width: thin; }
  .frame img { display: block; width: auto; height: auto; max-width: none; image-rendering: pixelated; }
  .frame-sm { max-height: 16.25rem; }
  .pairing { display: grid; grid-template-columns: 1fr; gap: .625rem; }
  .pair-col { min-width: 0; }
  .pair-head { display: inline-block; margin-bottom: .375rem; font-size: .75rem; font-weight: 600; }
  .pair-img { color: var(--accent-ink); }
  .pair-txt { color: var(--muted); }
  .pair-mid { font-size: .75rem; color: var(--faint); text-align: center; }
  .src-pane {
    margin: 0; max-height: 17.5rem; overflow: auto; padding: .5625rem .625rem;
    background: var(--inset); border: 1px solid var(--line); border-radius: var(--radius);
    font: .71875rem/1.45 var(--mono); color: var(--muted); white-space: pre-wrap; word-break: break-word;
  }

  /* sessions: a row per session, a bar for its share */
  .status { margin-bottom: .5rem; font-size: .8125rem; color: var(--faint); }
  .bars { display: flex; flex-direction: column; }
  .bar-row { display: flex; align-items: center; gap: .875rem; padding: .4375rem 0; border-bottom: 1px solid var(--line-soft); font-size: .8125rem; }
  .bar-row:last-child { border-bottom: 0; }
  .bar-label { flex: none; width: 9.5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: .75rem var(--mono); color: var(--muted); }
  .bar-track { flex: 1; min-width: 0; height: .5rem; border-radius: .25rem; background: var(--inset); }
  .bar-fill { height: 100%; border-radius: .25rem; background: var(--tile-saved); }
  .bar-val { flex: none; width: 6rem; text-align: right; font: 600 .75rem var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); }
  .bar-val.neg { color: var(--red); }
  .axis { margin-top: .625rem; font-size: .75rem; color: var(--faint); }
  .empty { padding: .875rem 0; font-size: .8125rem; color: var(--faint); }

  /* setup: every model is a key in one row that scrolls sideways when it runs out of width */
  .chips {
    display: flex; align-items: center; gap: .5rem; padding: 2px 2rem .625rem 2px; overflow-x: auto; scrollbar-width: thin;
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 2rem), transparent);
    mask-image: linear-gradient(to right, #000 calc(100% - 2rem), transparent);
  }
  .chip-group { display: contents; }
  .chip-group + .chip-group .models-label { margin-left: 1rem; }
  .chip { padding: .5625rem 1rem; font-size: .9375rem; }
  .chip.on { color: #fff; background: var(--tile-saved); border-color: transparent; }
  .models { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin: .75rem 0 0; }
  .models-label { flex: none; font-size: .9375rem; font-weight: 600; white-space: nowrap; color: var(--ink); }
  .models-csv { flex: 1 1 16rem; min-width: 13.75rem; padding: .3125rem .625rem; background: var(--inset); color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius); font: .8125rem/1.4 var(--mono); }
  .models-csv:focus { outline: none; border-color: var(--accent); }
  .models-routing { margin-top: .75rem; }
  .help p, .help li { max-width: 45rem; margin: .5rem 0; font-size: .8125rem; line-height: 1.55; color: var(--muted); }
  .help ul { margin: .375rem 0; padding-left: 1.125rem; }

  /* toast tray */
  .tray { position: fixed; bottom: 1rem; right: 1rem; z-index: 1000; display: flex; flex-direction: column; gap: .5rem; pointer-events: none; }
  .toast { display: flex; align-items: center; gap: .75rem; max-width: 22.5rem; padding: .625rem .875rem; background: var(--raise); color: var(--red); border: 1px solid var(--line-strong); border-radius: var(--radius); box-shadow: var(--float); font-size: .8125rem; pointer-events: auto; }
  .toast button { padding: 0; background: transparent; color: inherit; border: 0; font-size: 1rem; line-height: 1; cursor: pointer; }
  .toast[hidden] { display: none; }
  body.pp-offline > :not(.tray) { opacity: .45; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

// Client glue: window.pp (pin+source state) → hx-vals; preserves <details> open state across swaps; routes htmx errors to toast tray.
const GLUE_JS = `
  window.pp = { pin: null, src: false };
  function ppPin(id) {
    window.pp.pin = id;
    htmx.trigger('#frag-latest', 'pp-refresh');
  }
  function ppSource(on) {
    window.pp.src = on;
    htmx.trigger('#frag-latest', 'pp-refresh');
  }
  document.body.addEventListener('htmx:beforeSwap', function (ev) {
    const open = [];
    ev.detail.target.querySelectorAll('details[open][id]').forEach(function (d) { open.push(d.id); });
    ev.detail.target.__ppOpen = open;
  });
  document.body.addEventListener('htmx:afterSwap', function (ev) {
    (ev.detail.target.__ppOpen || []).forEach(function (id) {
      const d = document.getElementById(id);
      if (d) d.setAttribute('open', '');
    });
  });
  document.body.addEventListener('htmx:responseError', function (ev) {
    window.dispatchEvent(new CustomEvent('pp-toast', {
      detail: { text: ev.detail.xhr.status + ' ' + ev.detail.requestConfig.path }
    }));
  });
  // Proxy down: one persistent banner instead of a toast per failed poll. Polls are cancelled while offline; a single probe retries every 3s and reloads the page once the proxy answers again (a restart may have shipped a new build).
  window.ppOffline = false;
  function ppProbe() {
    fetch('/api/compression', { cache: 'no-store' }).then(function () {
      location.reload();
    }, function () { setTimeout(ppProbe, 3000); });
  }
  document.body.addEventListener('htmx:beforeRequest', function (ev) {
    if (window.ppOffline) ev.preventDefault();
  });
  document.body.addEventListener('htmx:sendError', function () {
    if (window.ppOffline) return;
    window.ppOffline = true;
    document.body.classList.add('pp-offline');
    const b = document.getElementById('pp-offline');
    if (b) b.hidden = false;
    setTimeout(ppProbe, 3000);
  });
  // One view at a time. The choice survives reloads (the offline probe reloads the page when the proxy returns).
  var ppViewName = 'images';
  var ppAdvOpen = false;
  function ppView(name) {
    ppViewName = name;
    document.querySelectorAll('.view').forEach(function (v) { v.hidden = !ppAdvOpen || v.id !== 'v-' + name; });
    document.querySelectorAll('.tab').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.view === name ? 'true' : 'false');
    });
    try { localStorage.setItem('pp-view', name); } catch (e) {}
  }
  // Everything under the saving is Advanced: closed until asked for, and a closed view does not poll.
  function ppAdvanced(open) {
    ppAdvOpen = open === undefined ? !ppAdvOpen : open;
    document.querySelector('.tabs').hidden = !ppAdvOpen;
    document.getElementById('adv-btn').setAttribute('aria-expanded', ppAdvOpen ? 'true' : 'false');
    try { localStorage.setItem('pp-adv', ppAdvOpen ? '1' : '0'); } catch (e) {}
    ppView(ppViewName);
  }
  (function () {
    var saved = null, adv = null;
    try { saved = localStorage.getItem('pp-view'); adv = localStorage.getItem('pp-adv'); } catch (e) {}
    if (saved && document.getElementById('v-' + saved)) ppViewName = saved;
    if (adv === '1') ppAdvanced(true);
  })();
`;

// Theme: light/dark via data-theme on <html>; saved in localStorage, defaults to system pref.
const THEME_JS = `
  (function () {
    function apply(t) {
      document.documentElement.dataset.theme = t;
      var b = document.getElementById('theme-btn');
      if (b) {
        b.setAttribute('aria-checked', t === 'dark' ? 'true' : 'false');
      }
    }
    window.ppTheme = function () {
      var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('pp-theme', next); } catch (e) {}
      apply(next);
    };
    apply(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  })();
`;

/** `hostLabel` names the machine this proxy runs on. The dashboard is otherwise
 *  byte-identical across hosts, so a tab opened against a remote host through
 *  the tailnet front is indistinguishable from the local one - which is how a
 *  session gets read on the wrong box. Empty label = render as before. */
export function renderPage(port: number, hostLabel = ''): string {
  const host = escapeHtml(hostLabel.trim());
  // hx-trigger="load, every Ns": paint on load then poll (2s live, 5s aggregates).
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${host ? `${host} · fastpipe dashboard` : 'fastpipe — live dashboard'}</title>
<link rel="icon" href="${FAVICON}" />
<style>${CSS}</style>
<script>
  // Set theme before first paint (no flash): saved choice wins, else system preference.
  (function () {
    try {
      var s = localStorage.getItem('pp-theme');
      var dark = s ? s === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    } catch (e) { document.documentElement.dataset.theme = 'light'; }
  })();
</script>
</head>
<body>

<header class="bar">
  <div class="brand">
    ${LOGO}
    <h1 class="wordmark">fastpipe</h1>
    <span class="q brand-tip" tabindex="0" role="note" aria-label="Which models image compression is validated for" data-tip="Image compression is validated for Fable 5, Gemini 3.6 Flash and Gemini 3.7 Flash. Other families can use more tokens. Opt in only for deliberate experiments.">?</span>
    ${host ? `<span class="hostchip" title="proxy host">${host}</span>` : ''}
  </div>
  <button class="mini-btn adv-btn" type="button" id="adv-btn" aria-expanded="false" aria-controls="advanced" onclick="ppAdvanced()">Advanced</button>
  <nav class="tabs" aria-label="Views" hidden>
    <button class="tab" type="button" data-view="images" aria-pressed="true" onclick="ppView('images')">Images</button>
    <button class="tab" type="button" data-view="sessions" aria-pressed="false" onclick="ppView('sessions')">Sessions</button>
    <button class="tab" type="button" data-view="setup" aria-pressed="false" onclick="ppView('setup')">Setup</button>
    <button class="tab" type="button" data-view="math" aria-pressed="false" onclick="ppView('math')">Math</button>
  </nav>
  <div id="frag-toggle" hx-get="/fragments/toggle" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>
  <span class="theme-label">Dark</span>
  <button type="button" id="theme-btn" class="theme-btn" role="switch" aria-checked="false" aria-label="Dark theme" title="Dark theme" onclick="ppTheme()"></button>
</header>

<div class="strip">
  <div id="frag-session" hx-get="/fragments/session-summary" hx-trigger="load, every 2s" hx-swap="innerHTML">
    <div class="gauge gauge-empty"><header class="head"><h2 class="head-title">Connecting…</h2></header><div class="record"><div class="gauge-track"></div></div></div>
  </div>
  <div id="frag-header" hx-get="/fragments/header" hx-select=".numbers" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>
</div><!-- /strip -->

<!-- Advanced: closed until its button is pressed. One view at a time, picked in the bar; a view that is not showing loads once and then stops polling. -->
<main class="views" id="advanced">
<section class="view" id="v-images" hidden>
  <div class="card">
    <h3 class="card-head">Recent requests</h3>
    <div id="frag-recent" hx-get="/fragments/recent" hx-trigger="load, every 2s [!document.getElementById('v-images').hidden]" hx-swap="innerHTML"></div>
  </div>
  <div class="card">
    <h3 class="card-head">Image vs text breakdown</h3>
    <div id="frag-context-map" hx-get="/fragments/context-map" hx-trigger="load" hx-swap="innerHTML"></div>
  </div>
  <div class="card">
    <h3 class="card-head">Image and source</h3>
    <div id="frag-latest" hx-get="/fragments/latest" hx-trigger="load, every 2s [!document.getElementById('v-images').hidden], pp-refresh" hx-swap="innerHTML"
         hx-vals='js:{pin: window.pp.pin == null ? "" : window.pp.pin, source: window.pp.src ? "1" : ""}'></div>
  </div>
</section><!-- /v-images -->

<section class="view" id="v-sessions" hidden>
  <div class="card">
    <h3 class="card-head">Top sessions</h3>
    <div id="frag-sessions" hx-get="/fragments/sessions" hx-trigger="load, every 5s [!document.getElementById('v-sessions').hidden]" hx-swap="innerHTML"></div>
  </div>
  <div class="card">
    <h3 class="card-head">Full history</h3>
    <div id="frag-stats" hx-get="/fragments/stats" hx-trigger="load, every 5s [!document.getElementById('v-sessions').hidden]" hx-swap="innerHTML"></div>
  </div>
</section><!-- /v-sessions -->

<section class="view" id="v-setup" hidden>
  <div class="card">
    <h3 class="card-head">Image model scope</h3>
    <div id="frag-models" hx-get="/fragments/models" hx-trigger="load, every 2s [!document.getElementById('v-setup').hidden && (!document.activeElement || document.activeElement.id !== 'models-csv')]" hx-swap="innerHTML"></div>
    <p class="hint models-routing">This list only decides which models get images. Non-Anthropic IDs also need the routing settings described below.</p>
  </div>
  <div class="card help">
    <h3 class="card-head">Connect an agent</h3>
    <p>Warp starts the agent with the proxy already wired, no env or config edits:</p>
    <pre>fastpipe warp -- claude
fastpipe warp -- codex
fastpipe warp -- cursor-agent</pre>
    <p>Aliases work too (<code>fastpipe warp -- pp</code>), and <code>--route PATTERN=http://host:port</code> adds routes beyond <code>api.anthropic.com</code> (a PATTERN that names a port matches only that port, e.g. <code>--route '127.0.0.1:9090/v1/*=http://127.0.0.1:${port}'</code> warps an agent pointed at another local proxy). Without warp, point the agent at <code>ANTHROPIC_BASE_URL=http://127.0.0.1:${port}</code> yourself.</p>
    <p>Pin instructions from inside the session — they get moved to the end of every request, where the model actually reads them:</p>
    <pre>@pxpipe pin be concise, no walls of text
@pxpipe unpin 2
@pxpipe unpin all</pre>
    <p><code>@pxpipe pin</code> with no text lists what is pinned.</p>
    <p>A <code>@pxpipe pin …</code> line in your global or project <code>CLAUDE.md</code> (<code>AGENTS.md</code> under Codex / OpenCode) is relocated the same way, on every session, with no typing. Those are file-backed, so <code>unpin</code> and <code>unpin all</code> never touch them — edit the file to remove one.</p>
  </div>
  <div class="card help">
    <h3 class="card-head">Routing Claude Code to OpenAI / Cloudflare models</h3>
    <p>Claude models use Anthropic by default. Two optional routes can run together — set on the <strong>fastpipe process</strong> (keep provider credentials out of Claude Code):</p>
    <ul>
      <li><code>OPENAI_MODELS</code> — exact model IDs routed to OpenAI Responses (<code>OPENAI_UPSTREAM</code> + <code>OPENAI_API_KEY</code>)</li>
      <li><code>CLOUDFLARE_MODELS</code> — exact model IDs routed to Cloudflare's OpenAI-compatible endpoint (<code>CLOUDFLARE_ACCOUNT_ID</code> + <code>CLOUDFLARE_API_TOKEN</code>)</li>
    </ul>
    <p>If a model appears in both lists: <code>CLOUDFLARE_MODELS &gt; OPENAI_MODELS &gt; default routing</code>.</p>
    <pre>OPENAI_UPSTREAM=https://api.openai.com \\
OPENAI_API_KEY=your-openai-key \\
OPENAI_MODELS=gpt-5.6-sol \\
CLOUDFLARE_ACCOUNT_ID=your-account-id \\
CLOUDFLARE_API_TOKEN=your-cloudflare-token \\
CLOUDFLARE_MODELS=moonshotai/kimi-k3 \\
npx pxpipe-proxy</pre>
    <p>Non-Anthropic IDs are advertised with a <code>claude-</code> prefix because Claude Code needs a Claude-shaped ID; fastpipe strips it before forwarding. Switch to one inside Claude Code with <code>/model claude-&lt;model&gt;</code> — e.g. <code>/model claude-moonshotai/kimi-k3</code> — or launch with <code>claude --model claude-moonshotai/kimi-k3</code>. Verify discovery with <code>curl …/v1/models</code>.</p>
    <p><code>PXPIPE_MODELS</code> above is separate: it controls image compression, not routing. Kimi K3 on Cloudflare is the only non-Anthropic model tested end to end — see <code>docs/CLAUDE_CODE_PROVIDER_ROUTING.md</code>.</p>
  </div>
</section><!-- /v-setup -->

<section class="view" id="v-math" hidden>
  <div class="card">
    <h3 class="card-head">How each number is computed</h3>
    <div id="frag-math" hx-get="/fragments/header" hx-select=".math" hx-trigger="load, every 2s [!document.getElementById('v-math').hidden]" hx-swap="innerHTML"></div>
  </div>
</section><!-- /v-math -->
</main>

<div class="tray" x-data="{ toasts: [], next: 1 }"
     @pp-toast.window="if (toasts.some(t => t.text === $event.detail.text)) return; const id = next++; toasts.push({ id, text: $event.detail.text }); setTimeout(() => toasts = toasts.filter(t => t.id !== id), 5000)">
  <div id="pp-offline" class="toast" role="status" hidden>proxy offline - retrying every 3s, the page reloads when it is back</div>
  <template x-for="t in toasts" :key="t.id">
    <div class="toast"><span x-text="t.text"></span><button type="button" @click="toasts = toasts.filter(x => x.id !== t.id)" aria-label="dismiss">&times;</button></div>
  </template>
</div>

<script>${HTMX_JS}</script>
<script>${GLUE_JS}</script>
<script>${THEME_JS}</script>
<script>${ALPINE_JS}</script>
</body>
</html>`;
}
