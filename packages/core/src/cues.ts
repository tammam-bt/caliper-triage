/**
 * Features -> cue activations.
 *
 * Raw features are in incomparable units: an entropy in bits, a ratio, a pixel count. Conditions
 * are scored as a weighted sum, so each feature is first mapped through a documented response
 * curve into a common 0..1 activation. Keeping this mapping in one small file means the answer to
 * "why did it say that?" is always two lookups away: this table, then the catalogue's weights.
 *
 * The breakpoints are chosen to put ordinary lesions near the middle of each range. They are
 * illustrative, not fitted — see the header of `catalogue.ts`.
 */
import type { CueId } from './catalogue.js';
import type { ImageFeatures } from './schemas.js';
import { luma } from './image/pixels.js';

/** Linear ramp from `lo` (0) to `hi` (1), clamped at both ends. */
export function ramp(value: number, lo: number, hi: number): number {
  if (hi === lo) return value >= hi ? 1 : 0;
  return Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
}

/**
 * Border irregularity of a digitised perfect disc, measured across the fixtures in
 * `testing/fixtures.ts` (1.019 noisy, 0.978 clean, 0.985 small) and asserted by `features.test.ts`.
 *
 * Getting this to sit at the theoretical 1.0 took two corrections — Kulpa's chain-code factor and
 * a majority filter on the mask. Before them the same disc measured anywhere from 0.98 to 1.48
 * depending on sensor noise, which would have made the cue a noise detector.
 */
export const BORDER_IRREGULARITY_DISC_BASELINE = 1.05;

export type CueActivations = Record<CueId, number>;

export function featuresToCues(f: ImageFeatures): CueActivations {
  const [r, g, b] = f.meanColour;
  const l = luma(r, g, b) / 255;
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const saturation = maxC > 0 ? (maxC - minC) / maxC : 0;
  // Redness relative to the other two channels. Erythema raises red without raising luminance.
  const redness = (r - (g + b) / 2) / 255;

  return {
    // A rasterised disc measures 0.008; a bitten crescent 0.19, a 7-lobed star 0.28.
    asymmetry: ramp(f.asymmetry, 0.03, 0.3),
    // Floor at the measured disc baseline so a circle activates at zero; a bitten crescent
    // reaches 0.43 and a lobed star saturates.
    borderIrregularity: ramp(f.borderIrregularity, BORDER_IRREGULARITY_DISC_BASELINE, 3),
    // Perplexity of the perceptually-merged Lab clusters: 1 = one colour, 6 = six distinct ones.
    colourVariegation: ramp(f.colourHeterogeneity, 1.3, 4),
    // Relative to the frame, since absolute pixels depend on how close the camera was.
    diameter: ramp(f.maskAreaRatio, 0.02, 0.35),
    textureRoughness: ramp(f.textureEntropy, 2.6, 4.6),
    erythema: ramp(redness, 0.04, 0.22),
    // Dark *and* saturated: pigment, not shadow.
    pigmentation: ramp(1 - l, 0.35, 0.72) * ramp(saturation, 0.1, 0.45),
    // Bright, desaturated and glossy — the pearly translucency of a BCC.
    pearlySheen: ramp(l, 0.5, 0.82) * ramp(1 - saturation, 0.62, 0.9) * ramp(f.brightSpeckleRatio, 0.02, 0.14),
    scaling: ramp(f.brightSpeckleRatio, 0.04, 0.2),
  };
}
