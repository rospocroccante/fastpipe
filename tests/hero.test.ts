import { describe, expect, it } from 'vitest';
import { renderSessionSummaryFragment } from '../src/dashboard/fragments.js';
import type { StatsPayload } from '../src/dashboard/types.js';

/**
 * The picture at the top reads the same cache-weighted lifetime pair as the
 * rows under it (serveStats), not the per-session payload, so it cannot
 * disagree with the "Input tokens saved" row and it stops swinging on tiny
 * samples. The old bug divided raw count_tokens (cache-blind) by sent tokens
 * and could claim a saving on a session the Saved column showed as a net loss.
 * These pin the direction to baseline_input_weighted vs actual_input_weighted.
 */
function payload(p: Partial<StatsPayload>): StatsPayload {
  return {
    compressed_requests: 1,
    output_weighted: 695, // 139 raw × 5 output_multiplier
    pricing_assumptions: { output_multiplier: 5 },
    ...p,
  } as StatsPayload;
}

describe('renderSessionSummaryFragment figure', () => {
  it('says "fewer input tokens" when the weighted image beat the weighted text', () => {
    const html = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 7000, actual_input_weighted: 1800 }),
    );
    expect(html).toContain('fewer input tokens');
    expect(html).not.toContain('more input tokens');
    expect(html).toContain('74%'); // 1 - 1800/7000
  });

  it('flips to "more input tokens" on a warm net-loss session', () => {
    // The exact trap: raw text (e.g. 7.2k) would look like a huge win, but the
    // cache-weighted text baseline (1,546) is below what imaging actually sent (1,863).
    const html = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 1546, actual_input_weighted: 1863 }),
    );
    expect(html).toContain('more input tokens');
    expect(html).not.toContain('fewer input tokens');
    expect(html).toContain('gauge-loss'); // red styling on a loss
  });

  it('never lumps output into the figure', () => {
    // Same input pair, wildly different output: the figure must not move.
    const a = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 2000, actual_input_weighted: 1000, output_weighted: 50 }),
    );
    const b = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 2000, actual_input_weighted: 1000, output_weighted: 45000 }),
    );
    expect(a).toContain('50%');
    expect(b).toContain('50%');
  });

  it('renders the warming-up state with no measured requests', () => {
    const html = renderSessionSummaryFragment(payload({ compressed_requests: 0 }));
    expect(html).toContain('Warming up');
    expect(html).not.toContain('fewer input tokens');
  });
});

/** The parts of the pipe from left to right, each as [class, width in percent]. */
function segments(html: string): Array<[string, string]> {
  return [...html.matchAll(/class="gauge-seg (gauge-[a-z]+)" style="width:([\d.]+)%"/g)].map(
    (m) => [m[1]!, m[2]!],
  );
}

describe('renderSessionSummaryFragment pipe', () => {
  it('draws one pipe as long as the text would have been, filled up to what was sent', () => {
    const html = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 7000, actual_input_weighted: 1800 }),
    );
    expect(segments(html)).toEqual([
      ['gauge-sent', '25.7'], // 1800 / 7000
      ['gauge-saved', '74.3'],
    ]);
  });

  it('fades one colour into the other where the two parts meet', () => {
    const html = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 7000, actual_input_weighted: 1800 }),
    );
    expect(html).toMatch(/<div class="gauge-track" role="img"[^>]*style="--cut:25\.7%"/);
  });

  it('labels both parts with their token counts', () => {
    const html = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 7000, actual_input_weighted: 1800 }),
    );
    expect(html).toContain('<span class="seg-name">Sent</span><span class="seg-num">1.8k</span>');
    expect(html).toContain('<span class="seg-name">Not sent</span><span class="seg-num">5.2k</span>');
  });

  it('names the amount the whole pipe stands for', () => {
    const saving = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 7000, actual_input_weighted: 1800 }),
    );
    expect(saving).toContain('<span class="rec-name">Without fastpipe</span><span class="rec-num">7.0k</span>');
    const loss = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 1546, actual_input_weighted: 1863 }),
    );
    expect(loss).toContain('<span class="rec-name">With fastpipe</span><span class="rec-num">1.9k</span>');
  });

  it('puts the figure in the head of its pane, as the title', () => {
    const html = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 7000, actual_input_weighted: 1800 }),
    );
    expect(html).toMatch(
      /<header class="head"><div class="head-figs"><h2 class="head-title"><span class="gauge-num">74%<\/span> fewer input tokens<\/h2>/,
    );
    expect(html).toContain('<p class="head-sub">Since start, after cache discounts. 1 request imaged. No provider pricing for these requests, so no dollars.</p>');
    // the pipe sits in its own record under the head
    expect(html.indexOf('<div class="record">')).toBeGreaterThan(html.indexOf('</header>'));
  });

  it('prints the dollars saved beside the percentage, as large', () => {
    const html = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 7000, actual_input_weighted: 1800, compressed_paid_requests: 1, saved_usd: 1844.62 }),
    );
    expect(html).toContain('<p class="head-money" title="$1,844.62"><span class="gauge-num">$1,845</span> saved</p>');
    expect(html.indexOf('head-money')).toBeLessThan(html.indexOf('</header>'));
  });

  it('prints wasted dollars in red and keeps cents under $100', () => {
    const html = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 1546, actual_input_weighted: 1863, compressed_paid_requests: 1, saved_usd: -3.5 }),
    );
    expect(html).toContain('<p class="head-money neg" title="$-3.50"><span class="gauge-num">$3.50</span> wasted</p>');
  });

  it('says how many requests the dollars leave out', () => {
    const html = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 7000, actual_input_weighted: 1800, compressed_requests: 3, compressed_paid_requests: 1, saved_usd: 2 }),
    );
    expect(html).toContain('Dollars leave out 2 provider-priced requests.');
  });

  it('on a net loss makes the pipe as long as what was sent and marks the excess', () => {
    const html = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 1546, actual_input_weighted: 1863 }),
    );
    expect(segments(html)).toEqual([
      ['gauge-base', '83.0'], // 1546 / 1863
      ['gauge-over', '17.0'],
    ]);
    expect(html).toContain('<span class="seg-name">As text</span><span class="seg-num">1.5k</span>');
    expect(html).toContain('<span class="seg-name">Extra sent</span><span class="seg-num">317</span>');
    expect(html).not.toContain('Not sent');
  });

  it('keeps a part visible when it is tiny next to the other', () => {
    const html = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 1_000_000, actual_input_weighted: 1000 }),
    );
    expect(segments(html)).toEqual([
      ['gauge-sent', '0.5'],
      ['gauge-saved', '99.5'],
    ]);
  });

  it('fills the whole pipe when nothing was saved', () => {
    const html = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 5000, actual_input_weighted: 5000 }),
    );
    expect(segments(html)).toEqual([['gauge-sent', '100.0']]);
  });

  it('says the text baseline is missing instead of comparing against zero', () => {
    const html = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 0, actual_input_weighted: 1800 }),
    );
    expect(segments(html)).toEqual([['gauge-sent', '100.0']]);
    expect(html).toContain('aria-label="1.8k input tokens sent, text baseline not measured yet"');
    expect(html).toContain('<span class="rec-name">Text baseline not measured yet</span>');
    expect(html).not.toContain('Not sent');
  });

  it('reads the pipe out to a screen reader', () => {
    const html = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 7000, actual_input_weighted: 1800 }),
    );
    expect(html).toContain('role="img"');
    expect(html).toContain(
      'aria-label="1.8k input tokens sent, 5.2k not sent, out of 7.0k without fastpipe"',
    );
  });

  it('draws an empty pipe before the first measured request', () => {
    const html = renderSessionSummaryFragment(payload({ compressed_requests: 0 }));
    expect(html).toContain('class="gauge-track"');
    expect(segments(html)).toEqual([]);
    expect(html).toContain('<h2 class="head-title">Warming up…</h2>');
  });
});
