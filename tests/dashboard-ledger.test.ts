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

describe('the Math view', () => {
  it('is the only thing the header fragment renders: the numbers live in the containers at the top', () => {
    const html = renderHeaderFragment(stats(), 47821);
    expect(html.startsWith('<section class="math">')).toBe(true);
    expect(html).not.toContain('ledger');
    expect(html).toContain('class="math-grid"');
  });

  it('compares the cost per imaged request with the same requests as text', () => {
    // 0.20 + 30 / 100 = 0.50 per request as text
    expect(renderHeaderFragment(stats(), 47821)).toContain('$0.5000/req');
  });

  it('names the uptime and the port, which no longer have a row of their own', () => {
    expect(renderHeaderFragment(stats(), 47821)).toContain('Running for 1h 2m 3s on port 47821.');
  });
});

describe('compression switch', () => {
  it('explains the kill switch on the button instead of beside it', () => {
    const html = renderToggleFragment(true);
    expect(html).toMatch(/<button class="switch-btn seg-switch"[^>]*title="Kill switch\./);
    expect(html).not.toContain('class="hint"');
  });

  it('is a switch whose position says whether compression is on', () => {
    expect(renderToggleFragment(true)).toMatch(
      /<button class="switch-btn seg-switch"[^>]*role="switch" aria-checked="true"[^>]*aria-label="Disable compression"/,
    );
    expect(renderToggleFragment(false)).toMatch(
      /<button class="switch-btn seg-switch"[^>]*role="switch" aria-checked="false"[^>]*aria-label="Enable compression"/,
    );
  });
});
