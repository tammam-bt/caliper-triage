/**
 * Acquisition-quality gate.
 *
 * A triage system that silently assesses an unusable photograph is worse than one that refuses,
 * because a confident answer from a blurred frame is indistinguishable to the user from a
 * confident answer from a good one. So this runs first, and it can stop the pipeline.
 */
import type { QualityIssue, QualityReport } from '../schemas.js';
import type { RgbaImage } from './pixels.js';
import { toGrayscale } from './pixels.js';

/** Below this variance-of-Laplacian, the image is too soft to measure a border from. */
export const BLUR_THRESHOLD = 40;
export const MIN_SIDE_PX = 128;
export const EXPOSURE_MIN = 0.35;

/**
 * Variance of the Laplacian — the standard no-reference sharpness estimate. A sharp image has
 * strong second derivatives at edges and therefore a wide response distribution; a blurred one
 * has a narrow response distribution regardless of its content.
 */
export function laplacianVariance(gray: Float32Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      // 4-neighbour Laplacian kernel [[0,1,0],[1,-4,1],[0,1,0]]
      const v =
        gray[i - width]! + gray[i + width]! + gray[i - 1]! + gray[i + 1]! - 4 * gray[i]!;
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * 0..1, peaking when the mean sits mid-range and little of the frame is clipped.
 * Clipped highlights destroy the colour information the variegation cue depends on.
 */
export function exposureScore(gray: Float32Array): number {
  if (gray.length === 0) return 0;
  let sum = 0;
  let clipped = 0;
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i]!;
    sum += v;
    if (v < 6 || v > 249) clipped++;
  }
  const mean = sum / gray.length / 255;
  // Triangular response centred on 0.5: 1.0 at mid-grey, 0 at pure black or white.
  const centring = 1 - Math.min(1, Math.abs(mean - 0.5) / 0.5);
  const clipPenalty = Math.min(1, (clipped / gray.length) / 0.25);
  return Math.max(0, centring * (1 - clipPenalty));
}

export interface QualityMeasures {
  blurScore: number;
  exposure: number;
  report: QualityReport;
}

export function assessQuality(img: RgbaImage): QualityMeasures {
  const gray = toGrayscale(img);
  const blurScore = laplacianVariance(gray, img.width, img.height);
  const exposure = exposureScore(gray);
  const issues: QualityIssue[] = [];

  const minSide = Math.min(img.width, img.height);
  if (minSide < MIN_SIDE_PX) {
    issues.push({
      code: 'too_small',
      measured: minSide,
      threshold: MIN_SIDE_PX,
      message: `Image is ${img.width}x${img.height}. Capture at least ${MIN_SIDE_PX}px on the short edge.`,
    });
  }
  if (blurScore < BLUR_THRESHOLD) {
    issues.push({
      code: 'blur',
      measured: round2(blurScore),
      threshold: BLUR_THRESHOLD,
      message: `Too soft to measure a border. Retake in brighter light, holding the camera steady.`,
    });
  }
  if (exposure < EXPOSURE_MIN) {
    const meanLuma = mean(gray) / 255;
    issues.push({
      code: meanLuma < 0.5 ? 'underexposed' : 'overexposed',
      measured: round2(exposure),
      threshold: EXPOSURE_MIN,
      message:
        meanLuma < 0.5
          ? 'Too dark. Move to stronger, even light and avoid casting a shadow over the area.'
          : 'Too bright. Move out of direct light or reduce the flash.',
    });
  }

  return { blurScore, exposure, report: { usable: issues.length === 0, issues } };
}

function mean(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return a.length ? s / a.length : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
