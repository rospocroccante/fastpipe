/**
 * Minimal PNG encoder (grayscale + RGB, 8-bit, filter=Average, single IDAT).
 * Pure Uint8Array — uses CompressionStream (Node 18+, Workers, browsers); no Buffer/node:zlib.
 */

// ---- CRC32 ---------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- Helpers -------------------------------------------------------------

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

const TYPE_BYTES = (s: string): Uint8Array => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
};

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeB = TYPE_BYTES(type);
  const crcSrc = concat([typeB, data]);
  return concat([u32be(data.length), typeB, data, u32be(crc32(crcSrc))]);
}

// ---- Deflate via Web Streams ---------------------------------------------

async function deflateZlib(input: Uint8Array): Promise<Uint8Array> {
  // 'deflate' = RFC 1950 zlib-wrapped — what PNG IDAT needs. 'deflate-raw' (RFC 1951) would be wrong.
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  // TS 5.7 narrows Uint8Array<ArrayBufferLike> away from BufferSource; safe since we never use SharedArrayBuffer.
  void writer.write(input as Uint8Array<ArrayBuffer>);
  void writer.close();

  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return concat(chunks);
}

// ---- Encode --------------------------------------------------------------

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Prepend scanline filter bytes using PNG's Average filter (type 3):
 *   Filt(x) = Orig(x) − floor((Recon(a) + Recon(b)) / 2)
 * where `a` is the same channel of the pixel to the left (x − bpp) and `b` the byte directly
 * above. Encoding may read the ORIGINAL bytes for a/b because the decoder reconstructs those
 * positions exactly before it needs them — the transform is bit-exact reversible, so decoded
 * pixels are byte-identical to `pixels`. Nothing about the image the model sees changes.
 *
 * Chosen over filter=None (the previous behavior): residuals of 5×8 bitmap glyphs on a flat
 * background collapse to mostly zeros, which deflate encodes in both less space and less time —
 * ~34% smaller IDAT at roughly half the compression cost on a representative dense page. That
 * matters because every image is re-uploaded on every turn, so IDAT size is a per-request
 * bandwidth cost. Filtering is pure JS ahead of the compressor, so it stays portable to
 * Workers unlike a deflate-level change (see the CompressionStream note above).
 */
function filterAverage(pixels: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const rowBytes = width * bpp;
  const stride = rowBytes + 1;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const src = y * rowBytes;
    const dst = y * stride;
    out[dst] = 3; // filter: Average
    for (let x = 0; x < rowBytes; x++) {
      // Off-image neighbors are defined as zero by the spec, not clamped/wrapped.
      const a = x >= bpp ? pixels[src + x - bpp]! : 0;
      const b = y > 0 ? pixels[src - rowBytes + x]! : 0;
      // a + b ≤ 510 so the shift is exact; only the result wraps to a byte.
      out[dst + 1 + x] = (pixels[src + x]! - ((a + b) >> 1)) & 0xff;
    }
  }
  return out;
}

/** Encode a single-channel (grayscale) buffer as PNG bytes. pixels is row-major, length = width × height. */
export async function encodeGrayPng(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  if (pixels.length !== width * height) {
    throw new Error(`encodeGrayPng: pixels.length=${pixels.length} != ${width}×${height}=${width * height}`);
  }

  // IHDR: width(4) height(4) bitDepth=8 colorType=0(gray) compress=0 filter=0 interlace=0
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8;
  ihdr[9] = 0; // colorType 0 = grayscale; bytes 10-12 already zero

  const compressed = await deflateZlib(filterAverage(pixels, width, height, 1));

  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Encode an RGB (3 bytes/pixel, R,G,B) buffer as PNG bytes (colorType 2 = truecolor). length = width × height × 3. */
export async function encodeRgbPng(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  if (pixels.length !== width * height * 3) {
    throw new Error(`encodeRgbPng: pixels.length=${pixels.length} != ${width}×${height}×3=${width * height * 3}`);
  }

  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8; // bit depth per channel
  ihdr[9] = 2; // colorType 2 = truecolor RGB; bytes 10-12 already zero

  const compressed = await deflateZlib(filterAverage(pixels, width, height, 3));

  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Scanline filter for packed palette rows. None (0) is the default: on dense
 *  5x8 pages it deflated to 3.29 MB vs 4.24 MB (Up) and 5.35 MB (Average)
 *  across 55 pages, against 7.84 MB for the previous 8-bit RGB/gray encoding. */
export type IndexedFilter = 0 | 2 | 3;

/**
 * Encode a gray (channels=1) or RGB (channels=3) buffer as a palette PNG (colour
 * type 3) at the smallest bit depth that fits: 1, 2, 4 or 8 bits per pixel.
 *
 * Rendered pages hold only paper, ink, a few antialiasing levels and the role
 * tints, so packing pixels as palette indices cuts the bytes the compressor sees
 * (and the bytes uploaded every turn) without touching a single pixel: decoders
 * expand each index back to the exact RGB/gray value it came from. Image tokens
 * are billed on pixel dimensions, so the bill does not change.
 *
 * Returns null when the palette would not shrink the raw scanlines (more than
 * 256 colours, or a gray image that needs the full 8 bits), so the caller keeps
 * its direct encoding.
 */
export async function encodeIndexedPng(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: 1 | 3,
  filter: IndexedFilter = 0,
): Promise<Uint8Array | null> {
  const n = width * height;
  if (pixels.length !== n * channels) {
    throw new Error(`encodeIndexedPng: pixels.length=${pixels.length} != ${width}×${height}×${channels}`);
  }

  // Palette discovery. Glyph pages are long runs of one colour, so checking the
  // previous pixel first skips the map lookup for nearly every pixel.
  const index = new Uint8Array(n);
  const slot = new Map<number, number>();
  const colours: number[] = [];
  let lastKey = -1;
  let lastIdx = 0;
  for (let i = 0; i < n; i++) {
    const key = channels === 3
      ? (pixels[i * 3]! << 16) | (pixels[i * 3 + 1]! << 8) | pixels[i * 3 + 2]!
      : pixels[i]!;
    if (key !== lastKey) {
      let idx = slot.get(key);
      if (idx === undefined) {
        if (colours.length === 256) return null;
        idx = colours.length;
        slot.set(key, idx);
        colours.push(key);
      }
      lastKey = key;
      lastIdx = idx;
    }
    index[i] = lastIdx;
  }

  const count = colours.length;
  const bits = count <= 2 ? 1 : count <= 4 ? 2 : count <= 16 ? 4 : 8;
  if (channels === 1 && bits === 8) return null; // same raw size as plain gray

  // Pack indices MSB-first, one filter byte per row.
  const rowBytes = Math.ceil((width * bits) / 8);
  const stride = rowBytes + 1;
  const packed = new Uint8Array(stride * height);
  const perByte = 8 / bits;
  for (let y = 0; y < height; y++) {
    const src = y * width;
    const dst = y * stride + 1;
    for (let x = 0; x < width; x++) {
      const shift = 8 - bits * ((x % perByte) + 1);
      packed[dst + Math.floor(x / perByte)]! |= index[src + x]! << shift;
    }
  }
  // Filters run on bytes (bpp = 1 for every depth ≤ 8). Iterate bottom-up so
  // each row is filtered against the ORIGINAL row above it, as decoders expect.
  if (filter !== 0) {
    for (let y = height - 1; y >= 0; y--) {
      const row = y * stride;
      packed[row] = filter;
      for (let x = rowBytes; x >= 1; x--) {
        const up = y > 0 ? packed[row - stride + x]! : 0;
        if (filter === 2) {
          packed[row + x] = (packed[row + x]! - up) & 0xff;
        } else {
          const left = x > 1 ? packed[row + x - 1]! : 0;
          packed[row + x] = (packed[row + x]! - ((left + up) >> 1)) & 0xff;
        }
      }
    }
  }

  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = bits;
  ihdr[9] = 3; // colour type 3 = palette; compression/filter/interlace stay 0

  const plte = new Uint8Array(count * 3);
  for (let k = 0; k < count; k++) {
    const c = colours[k]!;
    if (channels === 3) {
      plte[k * 3] = (c >> 16) & 0xff;
      plte[k * 3 + 1] = (c >> 8) & 0xff;
      plte[k * 3 + 2] = c & 0xff;
    } else {
      plte[k * 3] = plte[k * 3 + 1] = plte[k * 3 + 2] = c;
    }
  }

  const compressed = await deflateZlib(packed);
  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

type NativeBase64 = { toBase64?: () => string };
type BufferLike = { from(b: Uint8Array): { toString(enc: 'base64'): string } };
const NodeBuffer = (globalThis as { Buffer?: BufferLike }).Buffer;

/** Base64-encode bytes. Uses the runtime's native encoder when there is one
 *  (Uint8Array#toBase64, or Buffer on Node), which is ~10x faster than the
 *  portable fallback; Workers without either still get the fallback. */
export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as NativeBase64).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  if (NodeBuffer) return NodeBuffer.from(bytes).toString('base64');
  return bytesToBase64Portable(bytes);
}

const renderedBase64 = new WeakMap<Uint8Array, string>();

/** Base64 of a RENDERED page, memoized per PNG buffer. Rendered PNGs are never
 *  mutated, and the render cache hands back the same buffer every turn, so a
 *  frozen history page is encoded once instead of on every request. Do not use
 *  for buffers that may change after the call. */
export function renderedPngBase64(png: Uint8Array): string {
  let b64 = renderedBase64.get(png);
  if (b64 === undefined) {
    b64 = bytesToBase64(png);
    renderedBase64.set(png, b64);
  }
  return b64;
}

/** Portable base64. Chunks to avoid call-stack blow-up from String.fromCharCode(...bigArray). */
export function bytesToBase64Portable(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
