import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { encodeIndexedPng } from '../src/core/png.js';

/**
 * Rendered pages use a handful of colours (paper, ink, a few antialiasing
 * levels, role tints), so a palette PNG at 1/2/4 bits per pixel carries the
 * same pixels in a fraction of the bytes. Image tokens are billed by pixel
 * dimensions, so this only changes upload size and encode time. It must decode
 * to exactly the pixels the renderer drew; skia does the decoding here so an
 * encoder bug cannot be hidden by the same bug in a hand-rolled decoder.
 */
async function decode(png: Uint8Array): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const img = await loadImage(Buffer.from(png));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { data: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height };
}

// Not a multiple of 8, so the last partial byte of each packed row is exercised.
const W = 259;
const H = 131;

function firstDiff(out: Uint8ClampedArray, pixels: Uint8Array, channels: 1 | 3): number {
  for (let i = 0; i < W * H; i++) {
    for (let c = 0; c < 3; c++) {
      const want = channels === 3 ? pixels[i * 3 + c]! : pixels[i]!;
      if (out[i * 4 + c] !== want) return i;
    }
  }
  return -1;
}

function bitDepth(png: Uint8Array): number {
  return png[24]!;
}

describe('indexed PNG encoder', () => {
  for (const colours of [2, 3, 4, 11, 16, 17, 256]) {
    it(`round-trips ${colours} RGB colours bit-for-bit`, async () => {
      const palette = Array.from({ length: colours }, (_, k) => [(k * 97) & 255, (k * 41 + 7) & 255, (k * 13 + 200) & 255]);
      const pixels = new Uint8Array(W * H * 3);
      for (let i = 0; i < W * H; i++) {
        // runs plus noise, like glyph rows on paper
        const k = (i % 7 === 0 ? (i * 31) % colours : (Math.floor(i / 9) % colours));
        pixels.set(palette[k]!, i * 3);
      }
      const png = await encodeIndexedPng(pixels, W, H, 3);
      expect(png).not.toBeNull();
      expect(png![25]).toBe(3); // colour type 3 = palette
      expect(bitDepth(png!)).toBe(colours <= 2 ? 1 : colours <= 4 ? 2 : colours <= 16 ? 4 : 8);
      const out = await decode(png!);
      expect([out.w, out.h]).toEqual([W, H]);
      expect(firstDiff(out.data, pixels, 3)).toBe(-1);
    });
  }

  for (const filter of [0, 2, 3] as const) {
    it(`round-trips with scanline filter ${filter}`, async () => {
      const pixels = new Uint8Array(W * H * 3);
      for (let i = 0; i < W * H; i++) pixels.set([(i * 7) % 5 * 50, 0, (i % 3) * 90], i * 3);
      const png = await encodeIndexedPng(pixels, W, H, 3, filter);
      expect(firstDiff((await decode(png!)).data, pixels, 3)).toBe(-1);
    });
  }

  it('round-trips greyscale with few levels', async () => {
    const levels = [255, 0, 68, 119, 200];
    const pixels = new Uint8Array(W * H);
    for (let i = 0; i < pixels.length; i++) pixels[i] = levels[Math.floor(i / 5) % levels.length]!;
    const png = await encodeIndexedPng(pixels, W, H, 1);
    expect(png).not.toBeNull();
    expect(bitDepth(png!)).toBe(4);
    expect(firstDiff((await decode(png!)).data, pixels, 1)).toBe(-1);
  });

  it('declines when a palette would not be smaller than the direct encoding', async () => {
    const rgb = new Uint8Array(W * H * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 37 + (i % 5)) & 255;
    expect(await encodeIndexedPng(rgb, W, H, 3)).toBeNull(); // > 256 colours

    const gray = new Uint8Array(W * H);
    for (let i = 0; i < gray.length; i++) gray[i] = i % 40; // 40 levels: 8-bit palette = no gain over gray
    expect(await encodeIndexedPng(gray, W, H, 1)).toBeNull();
  });

  it('handles a single pixel and a solid image', async () => {
    const one = await encodeIndexedPng(new Uint8Array([10, 20, 30]), 1, 1, 3);
    const d = await decode(one!);
    expect([d.data[0], d.data[1], d.data[2]]).toEqual([10, 20, 30]);

    const solid = new Uint8Array(64 * 4).fill(200);
    const s = await decode((await encodeIndexedPng(solid, 64, 4, 1))!);
    expect(new Set(Array.from({ length: 64 * 4 }, (_, i) => s.data[i * 4]))).toEqual(new Set([200]));
  });
});
