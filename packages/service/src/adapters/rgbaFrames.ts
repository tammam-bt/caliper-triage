/**
 * A `FrameExtractor` for callers that already hold decoded pixels.
 *
 * Decoding is inherently platform-specific — the browser has `createImageBitmap`, Node has `sharp`,
 * and neither belongs in this package. Both of those adapters end up producing RGBA, so this small
 * extractor covers the common case and keeps the platform-specific part at the edges.
 */
import type { RgbaImage } from '@caliper/core';
import type { FrameExtractor, StoredMedia } from '../ports.js';

export type Decoder = (media: StoredMedia, maxFrames: number) => Promise<RgbaImage[]>;

export class DecoderFrameExtractor implements FrameExtractor {
  constructor(private readonly decode: Decoder) {}

  async extract(media: StoredMedia, options: { maxFrames?: number } = {}): Promise<RgbaImage[]> {
    return this.decode(media, options.maxFrames ?? 12);
  }
}

/** Serves pre-decoded frames keyed by media id. Used by the tests and by the sample cases. */
export class StaticFrameExtractor implements FrameExtractor {
  constructor(private readonly frames: Map<string, RgbaImage[]>) {}

  async extract(media: StoredMedia): Promise<RgbaImage[]> {
    return this.frames.get(media.ref.id) ?? [];
  }
}
