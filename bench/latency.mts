// Times the local transform of one source tree on the synthetic request of request.mts.
//
//   npx tsx bench/latency.mts [tree] [model] [turns]
//
// `tree` is the root of a pxpipe or fastpipe checkout (default: this one). Each run is a fresh
// process, so "cold" includes font loading and the first render of every page. Run it once per
// tree and compare the lines. Prints one JSON line so several runs can be collected.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRequest, encode } from './request.mts';

const tree = path.resolve(process.argv[2] ?? '.');
const model = process.argv[3] ?? 'claude-fable-5-2';
const turns = Number(process.argv[4] ?? 200);
const { transformRequest } = await import(pathToFileURL(path.join(tree, 'src/core/transform.ts')).href);

const req = buildRequest(model, turns);

async function time(body: Uint8Array): Promise<{ ms: number; inMB: number; outMB: number; images: number }> {
  const t0 = performance.now();
  const { body: out } = await transformRequest(body, { model });
  const ms = performance.now() - t0;
  let images = 0;
  JSON.stringify(JSON.parse(new TextDecoder().decode(out)), (_k, v) => {
    if (v && v.type === 'image') images++;
    return v;
  });
  return { ms: Math.round(ms), inMB: +(body.length / 1e6).toFixed(2), outMB: +(out.length / 1e6).toFixed(2), images };
}

const first = encode(req);
const cold = await time(first);
const warm = await time(first);
// The next turn of the same session: one more exchange before the last user message.
req.messages.splice(
  req.messages.length - 1,
  0,
  { role: 'user', content: [{ type: 'text', text: 'next step' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
);
const next = await time(encode(req));
console.log(JSON.stringify({ model, turns, cold, warm, next }));
