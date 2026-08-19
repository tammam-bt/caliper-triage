/**
 * Turning uploaded bytes into RGBA frames, server side.
 *
 * Stills go through sharp. Video goes through ffmpeg, which is a separate binary this project
 * does not vendor — so `FfmpegFrameExtractor` announces its absence rather than failing obscurely,
 * and its tests skip loudly. See `docs/AUDIT.md`: ffmpeg was not installed in the environment this
 * was built in, and that is recorded rather than papered over.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { RgbaImage } from '@caliper/core';
import type { FrameExtractor, StoredMedia } from '@caliper/service';

export class SharpImageDecoder {
  async decode(bytes: Uint8Array): Promise<RgbaImage> {
    const { data, info } = await sharp(Buffer.from(bytes))
      .rotate() // honour the EXIF orientation, or every portrait phone photo is measured sideways
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
  }
}

export class ImageFrameExtractor implements FrameExtractor {
  private readonly decoder = new SharpImageDecoder();
  async extract(media: StoredMedia): Promise<RgbaImage[]> {
    return [await this.decoder.decode(media.bytes)];
  }
}

export async function ffmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-version']);
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Samples frames at fixed intervals across the clip.
 *
 * Interval sampling rather than scene-change detection, because a hand-held clip of one lesion has
 * no scene changes — it has camera shake. The sharpness weighting in
 * `aggregateFrameFeatures` then discards the motion-blurred samples, which is the part that
 * actually matters for measurement quality.
 */
export class FfmpegFrameExtractor implements FrameExtractor {
  private readonly decoder = new SharpImageDecoder();

  async extract(media: StoredMedia, { maxFrames = 12 }: { maxFrames?: number } = {}): Promise<RgbaImage[]> {
    if (!(await ffmpegAvailable())) {
      throw new Error(
        'ffmpeg is not installed. Video analysis requires an ffmpeg binary on PATH; ' +
          'the container image in docker-compose.yml provides one.',
      );
    }
    const dir = await mkdtemp(join(tmpdir(), 'caliper-'));
    try {
      const input = join(dir, 'input');
      await writeFile(input, Buffer.from(media.bytes));
      const fps = media.ref.durationMs ? Math.max(0.2, maxFrames / (media.ref.durationMs / 1000)) : 1;

      await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', input,
        '-vf', `fps=${fps.toFixed(3)},scale=512:-1`,
        '-frames:v', String(maxFrames),
        join(dir, 'frame-%03d.png'),
      ]);

      const frames: RgbaImage[] = [];
      for (let i = 1; i <= maxFrames; i++) {
        const path = join(dir, `frame-${String(i).padStart(3, '0')}.png`);
        const bytes = await readFile(path).catch(() => null);
        if (!bytes) break;
        frames.push(await this.decoder.decode(new Uint8Array(bytes)));
      }
      return frames;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Dispatches on media kind, so the pipeline never has to know which decoder it got. */
export class CompositeFrameExtractor implements FrameExtractor {
  constructor(
    private readonly image: FrameExtractor = new ImageFrameExtractor(),
    private readonly video: FrameExtractor = new FfmpegFrameExtractor(),
  ) {}

  async extract(media: StoredMedia, options?: { maxFrames?: number }): Promise<RgbaImage[]> {
    return media.ref.kind === 'video'
      ? this.video.extract(media, options)
      : this.image.extract(media, options);
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 400)}`)),
    );
  });
}
