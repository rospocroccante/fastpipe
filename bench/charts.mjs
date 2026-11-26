// Draws the charts of the README from the measured figures below.
// Each chart is written twice, for a light and for a dark page:
//   assets/bench-<name>.svg and assets/bench-<name>-dark.svg
//
//   node bench/charts.mjs
//
// The latency and body figures are the medians printed by bench/latency.mts
// (7 runs per tree, claude-fable-5-2 profile). The token figures are the totals
// of the event log over the trial. Change a figure here and run the script again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');

const BASE = 'pxpipe 0.16.0';
const FORK = 'fastpipe';

const LATENCY = {
  name: 'latency',
  title: 'Time added to a request before it goes upstream',
  subtitle: 'Milliseconds, median of 7 runs. Shorter is better.',
  max: 2800,
  ticks: [0, 500, 1000, 1500, 2000, 2500],
  tick: (v) => v.toLocaleString('en-US'),
  value: (v) => `${v.toLocaleString('en-US')} ms`,
  groups: [
    { label: 'First request of a process', callout: '2.5× faster', bars: [[BASE, 2715], [FORK, 1086]] },
    { label: 'Same request again', callout: '3.8× faster', bars: [[BASE, 433], [FORK, 115]] },
    { label: 'Next turn of the session', callout: '3.9× faster', bars: [[BASE, 425], [FORK, 109]] },
  ],
};

const BODY = {
  name: 'body',
  title: 'Size of the request sent upstream',
  subtitle: 'Megabytes, same 55 images in both. Smaller uploads sooner.',
  max: 11.2,
  ticks: [0, 2, 4, 6, 8, 10],
  tick: (v) => String(v),
  value: (v) => `${v.toFixed(2)} MB`,
  groups: [{ label: 'Request body', callout: '57% smaller', bars: [[BASE, 10.57], [FORK, 4.51]] }],
};

const TOKENS = {
  name: 'tokens',
  title: 'Input tokens billed over 9,736 Claude Code requests',
  subtitle: 'Millions of tokens after cache discounts. Fewer is cheaper.',
  max: 375,
  ticks: [0, 100, 200, 300],
  tick: (v) => String(v),
  value: (v) => `${v} M`,
  groups: [
    { label: '11 to 26 November 2026', callout: '52% fewer', bars: [['Same context as text', 354], ['Through fastpipe', 169]] },
  ],
};

const THEMES = {
  light: { ink: '#1f2328', soft: '#59636e', grid: '#d1d9e0', base: '#8b949e', fork: '#1f6feb' },
  dark: { ink: '#f0f6fc', soft: '#9198a1', grid: '#3d444d', base: '#6e7681', fork: '#4c8dff' },
};

const W = 840;
const X0 = 176; // where the bars start
const X1 = 640; // where the scale ends
const BAR = 18;
const GAP = 4; // between the two bars of a pair
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const r1 = (n) => Math.round(n * 10) / 10;

/** A bar that is square on the baseline and rounded at the end that carries the value. */
function bar(x, y, w, h, fill) {
  const r = Math.min(4, w / 2);
  return `<path d="M${x} ${y}h${r1(w - r)}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h-${r1(w - r)}z" fill="${fill}"/>`;
}

function draw(chart, theme) {
  const c = THEMES[theme];
  const top = 78;
  const groupH = 26 + 2 * BAR + GAP; // label line, then the pair
  const groupGap = 22;
  const plotBottom = top + chart.groups.length * groupH + (chart.groups.length - 1) * groupGap + 10;
  const H = plotBottom + 34;
  const sx = (v) => X0 + (v / chart.max) * (X1 - X0);

  const out = [];
  const summary = chart.groups
    .map((g) => `${g.label}: ${g.bars.map(([n, v]) => `${n} ${chart.value(v)}`).join(', ')} (${g.callout})`)
    .join('. ');
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`${chart.title}. ${summary}.`)}" font-family="${FONT}">`,
  );
  out.push(`<text x="0" y="22" font-size="17" font-weight="600" fill="${c.ink}">${esc(chart.title)}</text>`);
  out.push(`<text x="0" y="44" font-size="13" fill="${c.soft}">${esc(chart.subtitle)}</text>`);

  // the scale: hairlines behind the bars, a firmer line where they start
  for (const t of chart.ticks) {
    const x = r1(sx(t));
    if (t !== 0) out.push(`<line x1="${x}" y1="${top + 18}" x2="${x}" y2="${plotBottom}" stroke="${c.grid}" stroke-width="1"/>`);
    out.push(`<text x="${x}" y="${plotBottom + 20}" font-size="12" text-anchor="middle" fill="${c.soft}">${esc(chart.tick(t))}</text>`);
  }

  chart.groups.forEach((g, i) => {
    const y = top + i * (groupH + groupGap);
    out.push(`<text x="0" y="${y + 12}" font-size="14" font-weight="600" fill="${c.ink}">${esc(g.label)}</text>`);
    out.push(`<text x="${W}" y="${y + 26 + BAR + GAP / 2 + 6}" font-size="19" font-weight="700" text-anchor="end" fill="${c.ink}">${esc(g.callout)}</text>`);
    // the line the bars grow from, kept to the pair so it never crosses the label above
    out.push(`<line x1="${X0}" y1="${y + 22}" x2="${X0}" y2="${y + 30 + 2 * BAR + GAP}" stroke="${c.soft}" stroke-width="1"/>`);
    g.bars.forEach(([name, v], j) => {
      const by = y + 26 + j * (BAR + GAP);
      const fork = j === 1;
      const w = sx(v) - X0;
      out.push(`<text x="${X0 - 12}" y="${by + 13}" font-size="13" text-anchor="end" fill="${fork ? c.ink : c.soft}"${fork ? ' font-weight="600"' : ''}>${esc(name)}</text>`);
      out.push(bar(X0, by, r1(w), BAR, fork ? c.fork : c.base));
      out.push(`<text x="${r1(X0 + w + 8)}" y="${by + 13}" font-size="13" fill="${fork ? c.ink : c.soft}"${fork ? ' font-weight="600"' : ''}>${esc(chart.value(v))}</text>`);
    });
  });

  out.push('</svg>');
  return out.join('\n') + '\n';
}

for (const chart of [LATENCY, BODY, TOKENS]) {
  for (const theme of ['light', 'dark']) {
    const file = path.join(OUT, `bench-${chart.name}${theme === 'dark' ? '-dark' : ''}.svg`);
    fs.writeFileSync(file, draw(chart, theme));
    console.log('wrote', path.relative(process.cwd(), file));
  }
}
