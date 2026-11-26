/**
 * The dashboard is one screen, read from left to right: the saving first, then
 * the pipe it comes from, then the numbers. Everything else is Advanced: closed
 * until its button is pressed, then one bar of buttons picks the view shown
 * under them, and only the view on screen polls the server.
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
  const start = html.indexOf(`<section class="view" id="v-${name}" hidden>`);
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
  it('reads left to right: the saving, then the numbers, then the view', () => {
    const order = ['id="frag-session"', 'id="frag-header"', 'class="view"'].map((s) => html.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // both sit in the strip at the top of the screen
    const strip = html.slice(html.indexOf('<div class="strip">'), html.indexOf('<!-- /strip -->'));
    expect(strip).toContain('id="frag-session"');
    expect(strip).toContain('id="frag-header"');
  });

  it('keeps every button of the page shell in one bar', () => {
    const bar = barMarkup();
    expect(bar).toContain('id="frag-toggle"');
    expect(bar).toContain('id="theme-btn"');
    // the toast tray is not part of the screen until something fails
    const shell = html.slice(0, html.indexOf('<div class="tray"'));
    expect(shell.replace(bar, '')).not.toContain('<button');
  });

  it('offers one tab per view, in the bar, with the first view picked', () => {
    const tabs = [
      ...barMarkup().matchAll(
        /<button class="tab" type="button" data-view="([a-z]+)" aria-pressed="(true|false)" onclick="ppView\('([a-z]+)'\)">([^<]+)<\/button>/g,
      ),
    ].map((m) => [m[1], m[2], m[3], m[4]]);
    expect(tabs).toEqual([
      ['images', 'true', 'images', 'Images'],
      ['sessions', 'false', 'sessions', 'Sessions'],
      ['setup', 'false', 'setup', 'Setup'],
      ['math', 'false', 'math', 'Math'],
    ]);
    const views = [...html.matchAll(/<section class="view" id="v-([a-z]+)"( hidden)?>/g)].map((m) => [
      m[1],
      m[2] === undefined ? 'showing' : 'hidden',
    ]);
    // nothing under the saving is open until Advanced is pressed
    expect(views).toEqual([
      ['images', 'hidden'],
      ['sessions', 'hidden'],
      ['setup', 'hidden'],
      ['math', 'hidden'],
    ]);
  });

  it('keeps the views and their tabs closed behind one Advanced button', () => {
    const bar = barMarkup();
    expect(bar).toMatch(/<button class="mini-btn adv-btn" type="button" id="adv-btn" aria-expanded="false" aria-controls="advanced" onclick="ppAdvanced\(\)">Advanced<\/button>/);
    expect(bar).toContain('<nav class="tabs" aria-label="Views" hidden>');
    expect(html).toContain('<main class="views" id="advanced">');
    // opening it shows the tabs and the view picked last; closing it hides every view, so none polls
    expect(html).toContain("document.querySelector('.tabs').hidden = !ppAdvOpen;");
    expect(html).toContain("v.hidden = !ppAdvOpen || v.id !== 'v-' + name;");
    expect(html).toContain("localStorage.setItem('pp-adv', ppAdvOpen ? '1' : '0')");
    expect(html).toContain("localStorage.getItem('pp-adv')");
  });

  it('says which models are validated from the mark next to the name', () => {
    const tip = barMarkup().match(/<span class="q brand-tip" tabindex="0"[^>]*data-tip="([^"]+)">\?<\/span>/);
    expect(tip?.[1]).toContain('Image compression is validated for Fable 5, Gemini 3.6 Flash and Gemini 3.7 Flash.');
    expect(viewMarkup('setup')).not.toContain('validated for');
  });

  it('puts each live panel inside its view', () => {
    for (const id of ['frag-context-map', 'frag-latest']) {
      expect(viewMarkup('images')).toContain(`id="${id}"`);
    }
    for (const id of ['frag-sessions', 'frag-stats']) {
      expect(viewMarkup('sessions')).toContain(`id="${id}"`);
    }
    expect(viewMarkup('setup')).toContain('id="frag-models"');
    expect(viewMarkup('math')).toContain('id="frag-math"');
  });

  it('shows the recent requests under the strip, outside Advanced', () => {
    const html = renderPage(47821);
    const strip = html.indexOf('<!-- /strip -->');
    const recent = html.indexOf('id="frag-recent"');
    const advanced = html.indexOf('<main class="views" id="advanced">');
    expect(strip).toBeLessThan(recent);
    expect(recent).toBeLessThan(advanced);
  });

  it('keeps the name for screen readers only, not as text in the bar', () => {
    expect(barMarkup()).toContain('<h1 class="sr-only">fastpipe</h1>');
  });

  it('polls a panel only while its view is showing', () => {
    const owner: Record<string, string> = {
      'frag-latest': 'images',
      'frag-sessions': 'sessions',
      'frag-stats': 'sessions',
      'frag-models': 'setup',
      'frag-math': 'math',
    };
    for (const [panel, view] of Object.entries(owner)) {
      expect(panelTag(panel)).toContain(`!document.getElementById('v-${view}').hidden`);
    }
  });

  it('still loads every panel once, so a view opens with content in it', () => {
    for (const id of ['frag-recent', 'frag-context-map', 'frag-latest', 'frag-sessions', 'frag-stats', 'frag-models', 'frag-math']) {
      expect(panelTag(id)).toMatch(/hx-trigger="load[,"]/);
    }
  });

  it('never stops polling the picture, the numbers and the on/off switch', () => {
    for (const id of ['frag-session', 'frag-header', 'frag-toggle', 'frag-recent']) {
      expect(panelTag(id)).toContain('hx-trigger="load, every 2s');
    }
  });

  it('takes the numbers and the formulas from the same fragment', () => {
    expect(panelTag('frag-header')).toContain('hx-get="/fragments/header"');
    expect(panelTag('frag-header')).toContain('hx-select=".numbers"');
    expect(panelTag('frag-math')).toContain('hx-get="/fragments/header"');
    expect(panelTag('frag-math')).toContain('hx-select=".math"');
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
    expect(bar).toContain('<span class="theme-label">Dark</span>');
    const btn = bar.match(/<button[^>]*id="theme-btn"[^>]*>/);
    expect(btn?.[0]).toContain('role="switch"');
    expect(btn?.[0]).toContain('aria-checked="false"');
    expect(btn?.[0]).toContain('aria-label="Dark theme"');
    expect(html).toContain("b.setAttribute('aria-checked', t === 'dark' ? 'true' : 'false');");
  });
});
