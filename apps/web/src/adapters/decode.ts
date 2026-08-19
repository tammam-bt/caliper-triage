/**
 * Browser-side decoding: files in, RGBA out.
 *
 * The video path is the interesting one. There is no ffmpeg here, so frames are sampled by seeking
 * a detached `<video>` element to N evenly spaced timestamps and drawing each to a canvas. That is
 * a real frame extraction — the same pixels a server-side ffmpeg pass would produce, arrived at
 * differently — and it is what makes video work on a static host.
 *
 * The catch worth knowing: `seeked` fires before the new frame is guaranteed to be painted in some
 * browsers, so we wait for `requestVideoFrameCallback` where it exists and fall back to a rAF tick
 * where it does not. Skipping that gives you N copies of frame zero.
 */
import type { RgbaImage } from '@caliper/core';

export interface DecodedMedia {
  kind: 'image' | 'video';
  mimeType: string;
  width: number;
  height: number;
  durationMs?: number;
  frames: RgbaImage[];
  /** Object URLs for the frame strip and the viewport. Revoked by `releasePreviews`. */
  previews: string[];
}

export const MAX_VIDEO_FRAMES = 8;

function toRgba(source: CanvasImageSource, width: number, height: number): RgbaImage {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser did not provide a 2D canvas context.');
  ctx.drawImage(source, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  return { data, width, height };
}

function toPreview(source: CanvasImageSource, width: number, height: number): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(source, 0, 0, width, height);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : ''), 'image/jpeg', 0.86);
  });
}

/** Longest edge the decoded frame is capped at. Feature extraction downsamples to 512 anyway. */
const MAX_EDGE = 1280;

function fit(width: number, height: number): [number, number] {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

export async function decodeImage(file: Blob): Promise<DecodedMedia> {
  const bitmap = await createImageBitmap(file);
  try {
    const [w, h] = fit(bitmap.width, bitmap.height);
    return {
      kind: 'image',
      mimeType: file.type || 'image/png',
      width: w,
      height: h,
      frames: [toRgba(bitmap, w, h)],
      previews: [await toPreview(bitmap, w, h)],
    };
  } finally {
    bitmap.close();
  }
}

export async function decodeVideo(file: Blob, maxFrames = MAX_VIDEO_FRAMES): Promise<DecodedMedia> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  try {
    await once(video, 'loadeddata', 20000);
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const [w, h] = fit(video.videoWidth, video.videoHeight);
    if (!w || !h) throw new Error('The video reported no dimensions and cannot be sampled.');

    const count = duration > 0 ? maxFrames : 1;
    const frames: RgbaImage[] = [];
    const previews: string[] = [];

    for (let i = 0; i < count; i++) {
      // Sample strictly inside the clip: the first and last frames of a hand-held recording are
      // the ones where the camera was still being moved.
      const t = duration > 0 ? ((i + 0.5) / count) * duration : 0;
      await seekTo(video, t);
      frames.push(toRgba(video, w, h));
      previews.push(await toPreview(video, Math.round(w / 6), Math.round(h / 6)));
    }

    return {
      kind: 'video',
      mimeType: file.type || 'video/mp4',
      width: w,
      height: h,
      durationMs: duration * 1000,
      frames,
      previews,
    };
  } finally {
    video.src = '';
    URL.revokeObjectURL(url);
  }
}

export async function decodeMedia(file: File): Promise<DecodedMedia> {
  if (file.type.startsWith('video/')) return decodeVideo(file);
  return decodeImage(file);
}

export function releasePreviews(previews: string[]): void {
  for (const url of previews) if (url) URL.revokeObjectURL(url);
}

function once(target: EventTarget, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for "${event}" — the file may not be a decodable video.`));
    }, timeoutMs);
    const onError = () => { cleanup(); reject(new Error('The browser could not decode this file.')); };
    const onDone = () => { cleanup(); resolve(); };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, onDone);
      target.removeEventListener('error', onError);
    };
    target.addEventListener(event, onDone, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

/** `requestVideoFrameCallback` is well supported but still absent from some engines. */
type MaybeFrameCallback = { requestVideoFrameCallback?: (cb: () => void) => number };

async function seekTo(video: HTMLVideoElement, seconds: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onSeeked = () => {
      const withCallback = video as HTMLVideoElement & MaybeFrameCallback;
      if (typeof withCallback.requestVideoFrameCallback === 'function') {
        // Guarantees the frame at the new position has actually been composited.
        withCallback.requestVideoFrameCallback(() => resolve());
      } else {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', () => reject(new Error('Seek failed')), { once: true });
    video.currentTime = seconds;
  });
}
