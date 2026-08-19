/**
 * Upload validation.
 *
 * The `Content-Type` header on a multipart part is supplied by the client and means nothing: it is
 * trivially set to `image/png` on an arbitrary file. So the type is determined from the leading
 * bytes, and anything not on the allowlist is rejected before it reaches a decoder.
 */
import { z } from 'zod';
import type { MediaKind } from '@caliper/core';

export interface SniffResult {
  mimeType: string;
  kind: MediaKind;
}

const SIGNATURES: Array<{ mimeType: string; kind: MediaKind; test: (b: Uint8Array) => boolean }> = [
  { mimeType: 'image/jpeg', kind: 'image', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mimeType: 'image/png', kind: 'image',
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    mimeType: 'image/webp', kind: 'image',
    test: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  },
  {
    mimeType: 'video/mp4', kind: 'video',
    test: (b) => ascii(b, 4, 8) === 'ftyp',
  },
  {
    mimeType: 'video/webm', kind: 'video',
    test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
  },
];

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to && i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/** Returns null when the leading bytes match nothing on the allowlist. */
export function sniffMediaType(bytes: Uint8Array): SniffResult | null {
  if (bytes.length < 12) return null;
  for (const sig of SIGNATURES) {
    if (sig.test(bytes)) return { mimeType: sig.mimeType, kind: sig.kind };
  }
  return null;
}

/** The client-declared dimensions, which are checked against the decoded frame downstream. */
export const UploadMetaSchema = z.object({
  width: z.coerce.number().int().positive().max(20000),
  height: z.coerce.number().int().positive().max(20000),
  durationMs: z.coerce.number().nonnegative().optional(),
  pixelsPerMm: z.coerce.number().positive().optional(),
});
