// Checks that two source trees turn the same request into the same thing: the JSON around the
// images must be identical and every image must decode to the same pixels. Only the PNG bytes
// may differ.
//
//   npx tsx bench/equivalence.mts <upstream tree> [this tree]
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { buildRequest, encode } from './request.mts';

if (!process.argv[2]) {
  console.error('usage: npx tsx bench/equivalence.mts <upstream tree> [this tree]');
  process.exit(2);
}
const load = async (tree: string) =>
  (await import(pathToFileURL(path.join(path.resolve(tree), 'src/core/transform.ts')).href)).transformRequest;
const upstream = await load(process.argv[2]);
const ours = await load(process.argv[3] ?? '.');

async function pixels(b64: string): Promise<{ w: number; h: number; d: Buffer }> {
  const img = await loadImage(Buffer.from(b64, 'base64'));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, d: Buffer.from(ctx.getImageData(0, 0, img.width, img.height).data) };
}

function split(body: Uint8Array): { json: string; images: string[] } {
  const images: string[] = [];
  const json = JSON.stringify(JSON.parse(new TextDecoder().decode(body)), (_k, v) => {
    if (v && v.type === 'base64' && typeof v.data === 'string') {
      images.push(v.data);
      return { ...v, data: '<image>' };
    }
    return v;
  });
  return { json, images };
}

let failed = false;
for (const model of ['claude-fable-5-2', 'claude-fable-5', 'claude-opus-5-5', 'gemini-4-argon', 'gpt-5.6-sol']) {
  const body = encode(buildRequest(model, 200));
  const a = await upstream(body, { model });
  const z = await ours(body, { model });
  const sa = split(a.body);
  const sz = split(z.body);
  let mismatched = 0;
  for (let i = 0; i < Math.min(sa.images.length, sz.images.length); i++) {
    const [pa, pz] = await Promise.all([pixels(sa.images[i]), pixels(sz.images[i])]);
    if (pa.w !== pz.w || pa.h !== pz.h || !pa.d.equals(pz.d)) mismatched++;
  }
  const same = sa.json === sz.json && sa.images.length === sz.images.length && mismatched === 0;
  if (!same) failed = true;
  console.log(
    `${model.padEnd(18)} json equal ${sa.json === sz.json}  images ${sa.images.length}/${sz.images.length}  ` +
      `pixel mismatches ${mismatched}  body ${(a.body.length / 1e6).toFixed(2)} MB -> ${(z.body.length / 1e6).toFixed(2)} MB`,
  );
}
process.exit(failed ? 1 : 0);
