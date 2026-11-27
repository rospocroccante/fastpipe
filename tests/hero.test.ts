import { describe, expect, it } from 'vitest';
import { renderSessionSummaryFragment } from '../src/dashboard/fragments.js';
import type { StatsPayload } from '../src/dashboard/types.js';

/**
 * The top of the dashboard: three containers (input tokens, money, cost per request)
 * and the saving bar under them. They read the same cache-weighted lifetime pair as
 * the Math view (serveStats), so they cannot disagree with it. The old bug divided
 * raw count_tokens (cache-blind) by sent tokens and could claim a saving on a net
 * loss; these pin the direction to baseline_input_weighted vs actual_input_weighted.
 */
function payload(p: Partial<StatsPayload>): StatsPayload {
  return {
    requests: 1,
    compressed_requests: 1,
    output_weighted: 695,
    pricing_assumptions: { output_multiplier: 5 },
    ...p,
  } as StatsPayload;
}

/** Each container as [label, figure, what it says], markup stripped. */
function kpis(html: string): string[][] {
  const text = (s: string): string => s.replace(/<[^>]+>/g, '');
  return [
    ...html.matchAll(
      /<section class="kpi kpi-[a-z]+"><h2 class="kpi-label">(.*?)<\/h2><p class="kpi-fig"><span class="kpi-num">(.*?)<\/span><span class="kpi-says">(.*?)<\/span>/g,
    ),
  ].map((m) => [text(m[1]!), text(m[2]!), text(m[3]!)]);
}

/** The parts of the bar from left to right, each as [class, width in percent]. */
function segments(html: string): Array<[string, string]> {
  return [...html.matchAll(/class="gauge-seg (gauge-[a-z]+)" style="width:([\d.]+)%"/g)].map((m) => [m[1]!, m[2]!]);
}

const SAVING = { baseline_input_weighted: 7000, actual_input_weighted: 1800 };
const LOSS = { baseline_input_weighted: 1546, actual_input_weighted: 1863 };

describe('the three containers', () => {
  it('shows tokens, money and cost per request, in that order', () => {
    const html = renderSessionSummaryFragment(
      payload({ ...SAVING, compressed_paid_requests: 1, saved_usd: 1844.62, compressed_actual_usd: 155.38, compressed_avg_usd_per_request: 155.38 }),
    );
    expect(kpis(html)).toEqual([
      ['Input tokens', '74%', 'fewer than as text'],
      ['Money', '$1,845', 'saved'],
      ['Cost per request', '$155.38', '−92% vs text'],
    ]);
  });

  it('compares the money with what the same requests would have cost', () => {
    const html = renderSessionSummaryFragment(
      payload({ ...SAVING, compressed_paid_requests: 1, saved_usd: 15.6, compressed_actual_usd: 22.96, compressed_avg_usd_per_request: 0.3763 }),
    );
    expect(html).toContain('<b>$22.96</b> spent vs <b>$38.56</b> without fastpipe');
  });

  it('turns red on a net loss, in tokens and in dollars', () => {
    const html = renderSessionSummaryFragment(
      payload({ ...LOSS, compressed_paid_requests: 1, saved_usd: -3.5, compressed_actual_usd: 10, compressed_avg_usd_per_request: 10 }),
    );
    expect(kpis(html)).toEqual([
      ['Input tokens', '21%', 'more than as text'],
      ['Money', '$3.50', 'wasted'],
      ['Cost per request', '$10.00', '+54% vs text'],
    ]);
    expect(html).toContain('<section class="kpi kpi-neg"><h2 class="kpi-label">Input tokens</h2>');
    expect(html).toContain('<section class="kpi kpi-neg"><h2 class="kpi-label">Money</h2>');
  });

  it('never lumps output into the percentage', () => {
    const a = renderSessionSummaryFragment(payload({ baseline_input_weighted: 2000, actual_input_weighted: 1000, output_weighted: 50 }));
    const b = renderSessionSummaryFragment(payload({ baseline_input_weighted: 2000, actual_input_weighted: 1000, output_weighted: 45000 }));
    expect(kpis(a)[0]![1]).toBe('50%');
    expect(kpis(b)[0]![1]).toBe('50%');
  });

  it('says how many requests the dollars leave out', () => {
    const html = renderSessionSummaryFragment(
      payload({ ...SAVING, requests: 3, compressed_requests: 3, compressed_paid_requests: 1, saved_usd: 2 }),
    );
    expect(html).toContain('2 without pricing left out');
  });

  it('prints no dollars when no request has pricing', () => {
    const html = renderSessionSummaryFragment(payload(SAVING));
    expect(kpis(html).slice(1)).toEqual([
      ['Money', '—', 'no dollars'],
      ['Cost per request', '—', 'no dollars'],
    ]);
  });

  it('prints each number once', () => {
    const html = renderSessionSummaryFragment(
      payload({ ...SAVING, compressed_paid_requests: 1, saved_usd: 15.6, compressed_actual_usd: 22.96, compressed_avg_usd_per_request: 0.3763 }),
    );
    expect(html.match(/\$22\.96/g)).toHaveLength(1);
    expect(html.match(/74%/g)).toHaveLength(1);
  });

  it('says warming up before the first measured request', () => {
    const html = renderSessionSummaryFragment(payload({ compressed_requests: 0 }));
    expect(html).toContain('Warming up');
    expect(html).toContain('class="gauge-track"');
    expect(segments(html)).toEqual([]);
  });
});

describe('the saving bar', () => {
  it('is as long as the text would have been, filled up to what was sent', () => {
    expect(segments(renderSessionSummaryFragment(payload(SAVING)))).toEqual([
      ['gauge-sent', '25.7'],
      ['gauge-saved', '74.3'],
    ]);
  });

  it('names both parts with their token counts under the label', () => {
    const html = renderSessionSummaryFragment(payload(SAVING));
    expect(html).toContain('<span class="rec-name">Without fastpipe</span><span class="rec-num">7.0k</span>');
    expect(html).toContain('<span><b>1.8k</b> sent</span><span class="rec-key"><b>5.2k</b> not sent</span>');
  });

  it('on a net loss is as long as what was sent and marks the excess', () => {
    const html = renderSessionSummaryFragment(payload(LOSS));
    expect(segments(html)).toEqual([
      ['gauge-base', '83.0'],
      ['gauge-over', '17.0'],
    ]);
    expect(html).toContain('<span class="rec-name">With fastpipe</span><span class="rec-num">1.9k</span>');
    expect(html).toContain('<b>317</b> extra sent');
    expect(html).not.toContain('not sent');
  });

  it('keeps a tiny part visible', () => {
    expect(segments(renderSessionSummaryFragment(payload({ baseline_input_weighted: 1_000_000, actual_input_weighted: 1000 })))).toEqual([
      ['gauge-sent', '0.5'],
      ['gauge-saved', '99.5'],
    ]);
  });

  it('fills the whole bar when nothing was saved', () => {
    expect(segments(renderSessionSummaryFragment(payload({ baseline_input_weighted: 5000, actual_input_weighted: 5000 })))).toEqual([
      ['gauge-sent', '100.0'],
    ]);
  });

  it('says the text baseline is missing instead of comparing against zero', () => {
    const html = renderSessionSummaryFragment(payload({ baseline_input_weighted: 0, actual_input_weighted: 1800 }));
    expect(segments(html)).toEqual([['gauge-sent', '100.0']]);
    expect(html).toContain('<span class="rec-name">Text baseline not measured yet</span>');
    expect(kpis(html)[0]).toEqual(['Input tokens', '—', 'not measured yet']);
  });

  it('reads the bar out to a screen reader', () => {
    expect(renderSessionSummaryFragment(payload(SAVING))).toContain(
      'role="img" aria-label="1.8k input tokens sent, 5.2k not sent, out of 7.0k without fastpipe"',
    );
  });
});
