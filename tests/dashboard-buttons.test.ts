/**
 * The screen never shows more than two rows of buttons: the bar at the top and,
 * at most, one row inside the view. So each fragment that has buttons keeps all
 * of them in a single row.
 */

import { describe, expect, it } from 'vitest';
import { renderLatestFragment, renderModelsFragment, renderRecentFragment } from '../src/dashboard/fragments.js';
import type { RecentPayload } from '../src/dashboard/types.js';

/** The markup left once the one row that may hold buttons is taken out. */
function outside(html: string, rowClass: string): string {
  const start = html.indexOf(`<div class="${rowClass}">`);
  if (start < 0) throw new Error(`no ${rowClass} row`);
  const end = html.indexOf(`<!-- /${rowClass} -->`, start);
  if (end < 0) throw new Error(`${rowClass} row is not closed`);
  return html.slice(0, start) + html.slice(end);
}

describe('image viewer buttons', () => {
  const payload = { has_preview: true, preview_meta: '1568x728', image_ids: [3, 4] } as RecentPayload;

  it('keeps "back to latest" and the source switch in the same row', () => {
    const html = renderLatestFragment({ payload, pin: 3, showSource: false, sourceText: null });
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(outside(html, 'viewer-bar')).not.toContain('<button');
    expect(html.indexOf('viewer-bar')).toBeLessThan(html.indexOf('class="frame"'));
  });

  it('puts the row above the image when following the latest one', () => {
    const html = renderLatestFragment({ payload, pin: null, showSource: false, sourceText: null });
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(outside(html, 'viewer-bar')).not.toContain('<button');
    expect(html).toContain('1568x728');
  });

  it('draws no row when there is nothing to switch', () => {
    const html = renderLatestFragment({
      payload: { has_preview: false, preview_meta: '' } as RecentPayload,
      pin: null,
      showSource: false,
      sourceText: null,
    });
    expect(html).not.toContain('<button');
    expect(html).not.toContain('viewer-bar');
  });
});

describe('model chips', () => {
  const html = renderModelsFragment(['claude-fable-5', 'gemini'], [], true);

  it('lays every chip out in one row, family after family', () => {
    expect(html.match(/<button class="chip/g)!.length).toBeGreaterThan(8);
    expect(outside(html, 'chips')).not.toContain('<button');
    // A short name in the row, the full one on hover: three long labels would not leave room for the chips.
    const families = [
      ...html.matchAll(/<span class="chip-group"><span class="models-label" title="([^"]+)">([^<]+)<\/span>/g),
    ].map((m) => [m[1], m[2]]);
    expect(families).toEqual([
      ['Image Claude models', 'Claude'],
      ['Image Gemini models', 'Gemini'],
      ['Image OpenAI Responses models', 'OpenAI Responses'],
    ]);
  });

  it('keeps what each family does by default, as a line of text under the row', () => {
    const notes = outside(html, 'chips');
    expect(notes).toContain('unlisted models get plain text');
    expect(notes).toContain('toggle off to opt out');
    expect(notes).toContain('no Anthropic cache_control');
  });
});

describe('recent requests table', () => {
  const payload = {
    recent: [
      {
        status: 200,
        path: '/v1/messages',
        model: 'claude-fable-5-2',
        cc_added: 1,
        cache_read: 174524,
        baseline_input: 70829,
        actual_input: 19371,
        session_saved_so_far_delta: 51458,
        img_id: 7,
      },
    ],
  } as unknown as RecentPayload;
  const html = renderRecentFragment(payload);

  it('orders its columns by weight, the saving first and the link last', () => {
    const heads = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(heads).toEqual(['Saved/lost', 'Model', 'Sent as', 'As text', 'Sent', 'Cache hits', 'Result', 'Endpoint', '']);
  });

  it('fills each row in the same order', () => {
    const cells = [...html.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
    expect(cells).toEqual(['51,458', 'claude-fable-5-2', 'image', '70,829', '19,371', '174,524', '200', 'messages', 'Details →']);
  });

  it('spans the empty state over every column', () => {
    expect(renderRecentFragment({ recent: [] } as unknown as RecentPayload)).toContain('<td colspan="9" class="empty-cell">');
  });
});
