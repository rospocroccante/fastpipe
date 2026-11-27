/**
 * Colour carries the verdict: green where fastpipe saves, red where it costs more,
 * blue where there is nothing to judge. Images sent is a gallery, and Advanced
 * opens and closes under the main screen.
 */

import { describe, expect, it } from 'vitest';
import {
  renderLatestFragment,
  renderPage,
  renderRecentFragment,
  renderSessionSummaryFragment,
} from '../src/dashboard/fragments.js';
import type { RecentPayload, RecentRow, StatsPayload } from '../src/dashboard/types.js';

function stats(p: Partial<StatsPayload> = {}): StatsPayload {
  return {
    requests: 10,
    compressed_requests: 10,
    compressed_paid_requests: 10,
    compressed_avg_usd_per_request: 0.1,
    compressed_actual_usd: 1,
    saved_usd: 1,
    baseline_input_weighted: 200_000,
    actual_input_weighted: 100_000,
    ...p,
  } as StatsPayload;
}

const tones = (html: string): string[] => [...html.matchAll(/class="kpi kpi-(\w+)"/g)].map((m) => m[1]!);

describe('the three containers', () => {
  it('are green on a saving', () => {
    expect(tones(renderSessionSummaryFragment(stats()))).toEqual(['pos', 'pos', 'pos']);
  });

  it('are red on a loss', () => {
    const html = renderSessionSummaryFragment(
      stats({ saved_usd: -0.5, baseline_input_weighted: 100_000, actual_input_weighted: 150_000 }),
    );
    expect(tones(html)).toEqual(['neg', 'neg', 'neg']);
  });

  it('are blue when nothing is measured or priced', () => {
    const html = renderSessionSummaryFragment(
      stats({ compressed_paid_requests: 0, baseline_input_weighted: 0, actual_input_weighted: 0 }),
    );
    expect(tones(html)).toEqual(['none', 'none', 'none']);
  });
});

describe('the recent requests', () => {
  const row = (saved: number | null, id: number): RecentRow =>
    ({ ts: 1, method: 'POST', path: '/v1/messages', status: 200, model: 'claude-fable-5', session_saved_so_far_delta: saved, img_id: id }) as unknown as RecentRow;

  it('mark each row green, red or blue by what it saved', () => {
    const html = renderRecentFragment({ recent: [row(500, 1), row(-200, 2), row(0, 3)], has_preview: false, preview_meta: '' });
    const classes = [...html.matchAll(/<tr class="(r-\w+)">/g)].map((m) => m[1]);
    // newest first
    expect(classes).toEqual(['r-even', 'r-neg', 'r-pos']);
  });
});

describe('Images sent', () => {
  const images = [5, 4, 3].map((id) => ({ id, meta: `img ${id}`, ts: 1000 + id }));
  const payload = { has_preview: true, preview_meta: 'img 5', image_ids: [3, 4, 5], images } as RecentPayload;

  it('shows every recent image as a thumbnail, the open one marked', () => {
    const html = renderLatestFragment({ payload, pin: 4, showSource: false, sourceText: null });
    const thumbs = [...html.matchAll(/<button class="thumb( on)?"[^>]*onclick="ppPin\((\d+)\)"/g)];
    expect(thumbs.map((m) => m[2])).toEqual(['5', '4', '3']);
    expect(thumbs.filter((m) => m[1]).map((m) => m[2])).toEqual(['4']);
    expect(html).toContain('src="/proxy-latest-png?id=4&t=1004000"');
  });

  it('opens the newest image when nothing is pinned', () => {
    const html = renderLatestFragment({ payload, pin: null, showSource: false, sourceText: null });
    expect(html).toMatch(/<img src="\/proxy-latest-png\?id=5&t=1005000" alt="rendered page"/);
  });
});

describe('Advanced', () => {
  const html = renderPage(47821);

  it('is a section that opens and closes', () => {
    expect(html).toContain('<details class="advanced" id="advanced"');
    expect(html).toContain('<summary class="adv-head">');
  });

  it('stops polling its views while closed', () => {
    for (const id of ['frag-sessions', 'frag-math']) {
      const tag = html.slice(html.indexOf(`id="${id}"`), html.indexOf('>', html.indexOf(`id="${id}"`)));
      expect(tag).toContain("document.getElementById('advanced').open");
    }
  });
});

describe('Recent requests — tokens saved or wasted', () => {
  const one = (saved: number | null) =>
    renderRecentFragment({
      recent: [
        { ts: 1, method: 'POST', path: '/v1/messages', status: 200, model: 'claude-fable-5', session_saved_so_far_delta: saved } as unknown as RecentRow,
      ],
      has_preview: false,
      preview_meta: '',
    } as RecentPayload);

  it('says in words which way each request went', () => {
    expect(one(2050)).toContain('+2,050<span class="tok-word">saved</span>');
    expect(one(-640)).toContain('−640<span class="tok-word">wasted</span>');
    expect(one(0)).toContain('0<span class="tok-word">not saved</span>');
    expect(one(null)).toContain('<span class="tok-word">not measured</span>');
  });
});
