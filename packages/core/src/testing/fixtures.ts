/**
 * Synthetic images with analytically known properties.
 *
 * Testing computer vision against real photographs tells you the pipeline ran; it does not tell
 * you the numbers are right. A disc of known radius has a known circularity and a known asymmetry,
 * so these fixtures can assert values rather than merely assert "no exception was thrown".
 */
import type { RgbaImage } from '../image/pixels.js';

export type Rgb = [number, number, number];

/** Seeded noise, so every fixture is byte-identical across runs. */
function prng(seed: number): () => number {
  let s = seed | 0 || 7;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 0xffffff) / 0xffffff;
  };
}

export interface CanvasOptions {
  width?: number;
  height?: number;
  background?: Rgb;
  /** Peak-to-peak amplitude of seeded per-channel noise. Keeps clustering out of degenerate cases. */
  noise?: number;
  seed?: number;
}

export function blank(options: CanvasOptions = {}): RgbaImage {
  const { width = 256, height = 256, background = [214, 178, 156], noise = 6, seed = 11 } = options;
  const data = new Uint8ClampedArray(width * height * 4);
  const rand = prng(seed);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const n = (rand() - 0.5) * noise;
    data[o] = background[0] + n;
    data[o + 1] = background[1] + n;
    data[o + 2] = background[2] + n;
    data[o + 3] = 255;
  }
  return { data, width, height };
}

function put(img: RgbaImage, x: number, y: number, c: Rgb): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const o = (y * img.width + x) * 4;
  img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
}

/** A filled disc. Circularity 1.0, asymmetry ~0. The control case for every shape measure. */
export function disc(radius: number, colour: Rgb = [72, 48, 40], options: CanvasOptions = {}): RgbaImage {
  const img = blank(options);
  const cx = img.width / 2;
  const cy = img.height / 2;
  const rand = prng((options.seed ?? 11) + 1);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) {
        const n = (rand() - 0.5) * (options.noise ?? 6);
        put(img, x, y, [colour[0] + n, colour[1] + n, colour[2] + n]);
      }
    }
  }
  return img;
}

/** A disc split into two clearly different colours. Doubles the colour-cluster count. */
export function twoToneDisc(radius: number, a: Rgb = [92, 60, 48], b: Rgb = [30, 22, 60], options: CanvasOptions = {}): RgbaImage {
  const img = blank(options);
  const cx = img.width / 2;
  const cy = img.height / 2;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) put(img, x, y, x < cx ? a : b);
    }
  }
  return img;
}

/**
 * A star-shaped blob: radius modulated by a sinusoid in theta. Its perimeter is much longer than
 * a disc of the same area, so circularity drops and border irregularity rises — by construction.
 */
export function lobedBlob(
  baseRadius: number,
  lobes = 7,
  amplitude = 0.42,
  colour: Rgb = [70, 46, 38],
  options: CanvasOptions = {},
): RgbaImage {
  const img = blank(options);
  const cx = img.width / 2;
  const cy = img.height / 2;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const theta = Math.atan2(dy, dx);
      const r = baseRadius * (1 + amplitude * Math.sin(lobes * theta));
      if (dx * dx + dy * dy <= r * r) put(img, x, y, colour);
    }
  }
  return img;
}

/** An off-centre half-disc: strongly asymmetric about one principal axis. */
export function crescent(radius: number, colour: Rgb = [70, 46, 38], options: CanvasOptions = {}): RgbaImage {
  const img = blank(options);
  const cx = img.width / 2;
  const cy = img.height / 2;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const inOuter = (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
      const inBite = (x - cx - radius * 0.75) ** 2 + (y - cy) ** 2 <= (radius * 0.85) ** 2;
      if (inOuter && !inBite) put(img, x, y, colour);
    }
  }
  return img;
}

/** Separable box blur — used to prove the quality gate rejects what it should. */
export function blur(img: RgbaImage, radius: number): RgbaImage {
  let src = img;
  for (const horizontal of [true, false]) {
    const out = new Uint8ClampedArray(src.data.length);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = horizontal ? Math.min(src.width - 1, Math.max(0, x + k)) : x;
          const sy = horizontal ? y : Math.min(src.height - 1, Math.max(0, y + k));
          const o = (sy * src.width + sx) * 4;
          r += src.data[o]!; g += src.data[o + 1]!; b += src.data[o + 2]!; n++;
        }
        const o = (y * src.width + x) * 4;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
      }
    }
    src = { data: out, width: src.width, height: src.height };
  }
  return src;
}

/** Uniformly darkens, for the underexposure test. */
export function scaleBrightness(img: RgbaImage, factor: number): RgbaImage {
  const data = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    data[i] = img.data[i]! * factor;
    data[i + 1] = img.data[i + 1]! * factor;
    data[i + 2] = img.data[i + 2]! * factor;
    data[i + 3] = 255;
  }
  return { data, width: img.width, height: img.height };
}

/** A red, poorly-defined patch: the erythema case that a brightness threshold would miss. */
export function erythematousPatch(radius: number, options: CanvasOptions = {}): RgbaImage {
  const img = blank(options);
  const cx = img.width / 2;
  const cy = img.height / 2;
  const rand = prng(99);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= radius) {
        const n = (rand() - 0.5) * 8;
        // Raise red, hold luminance near the background's: invisible to a brightness threshold.
        put(img, x, y, [232 + n, 132 + n, 118 + n]);
      }
    }
  }
  return img;
}
