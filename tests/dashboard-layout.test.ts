/**
 * The dashboard reads top to bottom: three containers (tokens, money, cost per
 * request), the saving bar, the model switches, then the recent requests with the
 * images beside them. Advanced sits under all that, reached by scrolling: one view
 * at a time, picked by its tabs, and only the view on screen polls the server.
 */

import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/dashboard/fragments.js';

const html = renderPage(47821);

const VIEWS = ['images', 'sessions', 'setup', 'math'];

/** The markup of the button bar. */
function barMarkup(): string {
  const start = html.indexOf('<header class="bar">');
  const end = html.indexOf('</header>', start);
  if (start < 0 || end < 0) throw new Error('no button bar in the page');
  return html.slice(start, end);
}

/** The markup of one view, from its opening tag to its closing comment. */
function viewMarkup(name: string): string {
  const start = html.search(new RegExp(`<section class="view" id="v-${name}"( hidden)?>`));
  const end = html.indexOf(`<!-- /v-${name} -->`);
  if (start < 0 || end < 0) throw new Error(`no view ${name} in the page`);
  return html.slice(start, end);
}

/** The opening tag of a live panel, with its htmx attributes. */
function panelTag(id: string): string {
  const m = html.match(new RegExp(`<div id="${id}"[^>]*>`));
  if (!m) throw new Error(`no panel #${id} in the page`);
  return m[0];
}

describe('dashboard screen', () => {
  it('reads top to bottom: the figures, the models, the requests and images, then Advanced', () => {
    const order = ['id="frag-session"', 'id="frag-picker"', 'id="frag-recent"', 'id="frag-latest"', 'id="advanced"'].map((s) =>
      html.indexOf(s),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('puts the recent requests and the images sent side by side', () => {
    const pair = html.slice(html.indexOf('<div class="pair">'), html.indexOf('<section class="advanced"'));
    expect(pair).toContain('id="frag-recent"');
    expect(pair).toContain('id="frag-latest"');
  });

  it('keeps the page buttons in one bar, with no Advanced button', () => {
    const bar = barMarkup();
    expect(bar).toContain('id="frag-toggle"');
    expect(bar).toContain('id="theme-btn"');
    expect(bar).not.toContain('adv-btn');
    expect(html).not.toContain('ppAdvanced');
  });

  it('offers one tab per Advanced view, with the breakdown picked first', () => {
    const tabs = [
      ...html.matchAll(
        /<button class="tab" type="button" data-view="([a-z]+)" aria-pressed="(true|false)" onclick="ppView\('([a-z]+)'\)">([^<]+)<\/button>/g,
      ),
    ].map((m) => [m[1], m[2], m[4]]);
    expect(tabs).toEqual([
      ['breakdown', 'true', 'Breakdown'],
      ['sessions', 'false', 'Sessions'],
      ['setup', 'false', 'Setup'],
      ['math', 'false', 'Math'],
    ]);
    const views = [...html.matchAll(/<section class="view" id="v-([a-z]+)"( hidden)?>/g)].map((m) => [
      m[1],
      m[2] === undefined ? 'showing' : 'hidden',
    ]);
    expect(views).toEqual([
      ['breakdown', 'showing'],
      ['sessions', 'hidden'],
      ['setup', 'hidden'],
      ['math', 'hidden'],
    ]);
  });

  it('says which models are validated from the logo, with no question mark', () => {
    const tip = barMarkup().match(/<span class="q brand-tip" tabindex="0"[^>]*data-tip="([^"]+)"><svg /);
    expect(barMarkup()).not.toMatch(/>\?<\/span>/);
    expect(tip?.[1]).toContain('Image compression is validated for Fable 5, Gemini 3.6 Flash and Gemini 3.7 Flash.');
  });

  it('puts each Advanced panel inside its view', () => {
    expect(viewMarkup('breakdown')).toContain('id="frag-context-map"');
    for (const id of ['frag-sessions', 'frag-stats']) expect(viewMarkup('sessions')).toContain(`id="${id}"`);
    expect(viewMarkup('setup')).toContain('id="frag-models"');
    expect(viewMarkup('math')).toContain('id="frag-math"');
  });

  it('polls an Advanced panel only while its view is showing', () => {
    const owner: Record<string, string> = { 'frag-sessions': 'sessions', 'frag-stats': 'sessions', 'frag-models': 'setup', 'frag-math': 'math' };
    for (const [panel, view] of Object.entries(owner)) {
      expect(panelTag(panel)).toContain(`!document.getElementById('v-${view}').hidden`);
    }
  });

  it('never stops polling the figures, the requests, the images and the on/off switch', () => {
    for (const id of ['frag-session', 'frag-toggle', 'frag-recent', 'frag-latest']) {
      expect(panelTag(id)).toContain('hx-trigger="load, every 2s');
    }
  });

  it('takes the formulas from the header fragment, and nothing else', () => {
    expect(panelTag('frag-math')).toContain('hx-get="/fragments/header"');
    expect(html).not.toContain('id="frag-header"');
  });

  it('puts the model switches between the saving bar and the recent requests', () => {
    expect(panelTag('frag-picker')).toContain('hx-get="/fragments/models?part=picker"');
  });

  it('does not refresh the model list while its text box is being edited', () => {
    expect(panelTag('frag-models')).toContain("document.activeElement.id !== 'models-csv'");
  });

  it('explains routing inside the setup view, without a dialog and its buttons', () => {
    expect(viewMarkup('setup')).toContain('Routing Claude Code to OpenAI / Cloudflare models');
    expect(html).not.toContain('<dialog');
    expect(html).not.toContain('showModal');
  });

  it('remembers the chosen view across reloads', () => {
    expect(html).toContain("localStorage.setItem('pp-view', name)");
    expect(html).toContain("localStorage.getItem('pp-view')");
  });

  it('draws the logo inline, with a name for screen readers', () => {
    expect(html).toMatch(/<svg class="logo"[^>]*role="img"[^>]*aria-label="fastpipe"/);
  });

  it('switches day and night with a labelled switch', () => {
    const bar = barMarkup();
    expect(bar).toContain('<span class="seg-off" aria-hidden="true">Light</span><span class="seg-on" aria-hidden="true">Dark</span>');
    const btn = bar.match(/<button[^>]*id="theme-btn"[^>]*>/);
    expect(btn?.[0]).toContain('role="switch"');
    expect(btn?.[0]).toContain('aria-checked="false"');
    expect(btn?.[0]).toContain('aria-label="Dark theme"');
    expect(html).toContain("b.setAttribute('aria-checked', t === 'dark' ? 'true' : 'false');");
  });
});
