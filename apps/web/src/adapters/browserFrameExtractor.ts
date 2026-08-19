/**
 * `FrameExtractor` for the browser.
 *
 * The pipeline hands it stored bytes; decoding those again would be wasteful when the UI has
 * already decoded them to show a preview. So the decoded frames are registered against the media
 * id at submit time and looked up here. That keeps the port contract intact without decoding the
 * same video twice.
 */
import type { RgbaImage } from '@caliper/core';
import type { FrameExtractor, StoredMedia } from '@caliper/service';

export class BrowserFrameExtractor implements FrameExtractor {
  private readonly registry = new Map<string, RgbaImage[]>();

  register(mediaId: string, frames: RgbaImage[]): void {
    this.registry.set(mediaId, frames);
  }

  release(mediaId: string): void {
    this.registry.delete(mediaId);
  }

  async extract(media: StoredMedia, options: { maxFrames?: number } = {}): Promise<RgbaImage[]> {
    const frames = this.registry.get(media.ref.id);
    if (!frames) throw new Error(`No decoded frames registered for media ${media.ref.id}`);
    const max = options.maxFrames ?? frames.length;
    return frames.slice(0, max);
  }
}
