/**
 * Beside the picture the dashboard lists its numbers as rows: a label, the value
 * beside it and a short note. The formulas behind them are a block of their own,
 * shown in the Math view, and the kill switch explains itself on the button.
 */

import { describe, expect, it } from 'vitest';
import { renderHeaderFragment, renderToggleFragment } from '../src/dashboard/fragments.js';
import type { StatsPayload } from '../src/dashboard/types.js';

function stats(p: Partial<StatsPayload> = {}): StatsPayload {
  return {
    requests: 120,
    compressed_requests: 100,
    compressed_paid_requests: 100,
    compressed_avg_usd_per_request: 0.2,
    saved_input_tokens: 345678,
    saved_usd: 30,
    uptime_sec: 3723,
    pricing_assumptions: { input_per_mtok: 10, output_multiplier: 5 },
    ...p,
  } as StatsPayload;
}

/** Each row as [label, value, note], with the markup stripped. */
function rows(html: string): string[][] {
  const text = (s: string): string => s.replace(/<[^>]+>/g, '');
  const row =
    /<div class="ledger-row(?: quiet)?"><dt>(.*?)<\/dt><dd class="ledger-val[^"]*">(.*?)<\/dd><dd class="ledger-note">(.*?)<\/dd><\/div>/g;
  return [...html.matchAll(row)].map((m) => [text(m[1]!), text(m[2]!), text(m[3]!)]);
}

describe('dashboard numbers', () => {
  it('lists each number as a row with its value and a note', () => {
    expect(rows(renderHeaderFragment(stats(), 47821))).toEqual([
      ['Input tokens saved', '345,678', 'vs the same context as text'],
      ['Estimated saved', '$30.00', 'at $10/M base input price'],
      ['Cost per request', '$0.2000', '−60% vs $0.5000 as text'], // 0.20 + 30 / 100
      ['Requests', '120', '100 sent as images'],
      ['Running for', '1h 2m 3s', 'on port 47821'],
    ]);
  });

  it('prints the savings large and the two context numbers quiet', () => {
    const html = renderHeaderFragment(stats(), 47821);
    const quiet = [...html.matchAll(/<div class="ledger-row quiet"><dt>(.*?)<\/dt>/g)].map((m) => m[1]);
    expect(quiet).toEqual(['Requests', 'Running for']);
  });

  it('marks in bold the figure to read first in a note', () => {
    const html = renderHeaderFragment(stats(), 47821);
    expect(html).toContain('<dd class="ledger-note"><b>−60%</b> vs $0.5000 as text</dd>');
    expect(html).toContain('<dd class="ledger-note"><b>100</b> sent as images</dd>');
  });

  it('separates the thousands of the dollars saved', () => {
    expect(renderHeaderFragment(stats({ saved_usd: 1844.62 }), 47821)).toContain(
      '<dd class="ledger-val pos">$1,844.62</dd>',
    );
  });

  it('heads the list with what the numbers cover', () => {
    const html = renderHeaderFragment(stats(), 47821);
    expect(html.startsWith('<div class="numbers"><h2 class="list-head">Since start</h2><dl class="ledger">')).toBe(true);
  });

  it('explains a row on hover or keyboard focus, from the label and not from an icon', () => {
    const html = renderHeaderFragment(stats(), 47821);
    expect(html).toMatch(/<span class="q" tabindex="0"[^>]*data-tip="[^"]+"[^>]*>Cost per request<\/span>/);
    expect(html).not.toContain('>?</span>');
  });

  it('marks the cost per request only when images cost more than the text would have', () => {
    expect(renderHeaderFragment(stats(), 47821)).not.toContain('ledger-val neg');
    // 0.20 per imaged request against 0.20 - 10 / 100 = 0.10 as text
    expect(renderHeaderFragment(stats({ saved_usd: -10 }), 47821)).toContain(
      '<dd class="ledger-val neg">$0.2000</dd>',
    );
  });

  it('keeps the formulas in a block of their own, after the numbers', () => {
    // The page picks one block or the other out of this fragment, so they must not nest.
    const html = renderHeaderFragment(stats(), 47821);
    const numbers = html.indexOf('<div class="numbers">');
    const math = html.indexOf('<section class="math">');
    expect(numbers).toBe(0);
    expect(math).toBeGreaterThan(html.indexOf('</dl></div>'));
    expect(html.slice(math)).toContain('class="math-grid"');
    expect(html).not.toContain('<details');
  });
});

describe('compression switch', () => {
  it('explains the kill switch on the button instead of beside it', () => {
    const html = renderToggleFragment(true);
    expect(html).toMatch(/<button class="switch-btn"[^>]*title="Kill switch\./);
    expect(html).not.toContain('class="hint"');
  });

  it('is a switch whose position says whether compression is on', () => {
    expect(renderToggleFragment(true)).toMatch(
      /<button class="switch-btn"[^>]*role="switch" aria-checked="true"[^>]*aria-label="Disable compression"/,
    );
    expect(renderToggleFragment(false)).toMatch(
      /<button class="switch-btn"[^>]*role="switch" aria-checked="false"[^>]*aria-label="Enable compression"/,
    );
  });
});
