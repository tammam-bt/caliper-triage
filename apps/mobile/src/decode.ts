/**
 * Turning a picked image into RGBA on React Native.
 *
 * There is no canvas here, so the route is: downscale with `expo-image-manipulator` (native, fast),
 * read the result as base64 PNG, and decode the PNG in JavaScript. Decoding in JS is the part that
 * would not survive production — it belongs in a native module or, better, on the server, which is
 * exactly what the `HttpTransport` path does. For a prototype running on a 512px thumbnail it is
 * fine, and it keeps the shared core untouched.
 */
import * as ImageManipulator from 'expo-image-manipulator';
import type { RgbaImage } from '@caliper/core';
// pako rather than a hand-rolled DEFLATE reader: PNG's compression is zlib, this is the standard
// JavaScript port of it, and reimplementing it would be reinvention with a bug budget.
import { inflate } from 'pako';

export const WORK_SIZE = 512;

export interface DecodedAsset {
  frame: RgbaImage;
  uri: string;
  width: number;
  height: number;
}

export async function decodeAsset(uri: string): Promise<DecodedAsset> {
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: WORK_SIZE } }],
    { compress: 1, format: ImageManipulator.SaveFormat.PNG, base64: true },
  );
  if (!result.base64) throw new Error('The image could not be re-encoded for analysis.');

  const bytes = base64ToBytes(result.base64);
  const frame = decodePng(bytes);
  return { frame, uri: result.uri, width: result.width, height: result.height };
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = globalThis.atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Minimal PNG reader: 8-bit RGB/RGBA, non-interlaced, which is what `manipulateAsync` emits.
 * Anything else throws rather than producing quietly wrong pixels.
 */
export function decodePng(bytes: Uint8Array): RgbaImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('Not a PNG.');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  let bitDepth = 0;
  const idat: Uint8Array[] = [];

  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      bitDepth = bytes[offset + 16]!;
      colourType = bytes[offset + 17]!;
      if (bytes[offset + 20] !== 0) throw new Error('Interlaced PNGs are not supported.');
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8 || (colourType !== 2 && colourType !== 6)) {
    throw new Error(`Unsupported PNG: bit depth ${bitDepth}, colour type ${colourType}.`);
  }

  const channels = colourType === 6 ? 4 : 3;
  const raw = inflate(concat(idat));
  const stride = width * channels;
  const out = new Uint8ClampedArray(width * height * 4);
  const line = new Uint8Array(stride);
  const prior = new Uint8Array(stride);

  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++]!;
    for (let i = 0; i < stride; i++) line[i] = raw[src + i]!;
    src += stride;
    unfilter(filter, line, prior, channels, stride);
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s]!;
      out[d + 1] = line[s + 1]!;
      out[d + 2] = line[s + 2]!;
      out[d + 3] = channels === 4 ? line[s + 3]! : 255;
    }
    prior.set(line);
  }

  return { data: out, width, height };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** The five PNG scanline filters, per RFC 2083 §6. */
function unfilter(filter: number, line: Uint8Array, prior: Uint8Array, bpp: number, stride: number): void {
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < stride; i++) line[i] = (line[i]! + line[i - bpp]!) & 0xff;
      return;
    case 2:
      for (let i = 0; i < stride; i++) line[i] = (line[i]! + prior[i]!) & 0xff;
      return;
    case 3:
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? line[i - bpp]! : 0;
        line[i] = (line[i]! + ((left + prior[i]!) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp]! : 0;
        const b = prior[i]!;
        const c = i >= bpp ? prior[i - bpp]! : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i]! + pred) & 0xff;
      }
      return;
    default:
      throw new Error(`Unknown PNG filter type ${filter}.`);
  }
}
