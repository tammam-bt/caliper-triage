import { describe, expect, it } from 'vitest';
import { extractFeatures } from './features.js';
import { assessQuality, BLUR_THRESHOLD, otsuThreshold, segment } from './image/index.js';
import {
  blank, blur, crescent, disc, erythematousPatch, lobedBlob, scaleBrightness, twoToneDisc,
} from './testing/fixtures.js';

describe('quality gate', () => {
  it('accepts a sharp, well-exposed frame', () => {
    const q = assessQuality(disc(70));
    expect(q.report.usable).toBe(true);
    expect(q.blurScore).toBeGreaterThan(BLUR_THRESHOLD);
  });

  it('rejects a blurred frame and says what to do about it', () => {
    const q = assessQuality(blur(disc(70), 8));
    expect(q.report.usable).toBe(false);
    const issue = q.report.issues.find((i) => i.code === 'blur');
    expect(issue).toBeDefined();
    expect(issue!.measured).toBeLessThan(BLUR_THRESHOLD);
    expect(issue!.message).toMatch(/retake/i);
  });

  it('rejects an underexposed frame', () => {
    const q = assessQuality(scaleBrightness(disc(70), 0.12));
    expect(q.report.usable).toBe(false);
    expect(q.report.issues.map((i) => i.code)).toContain('underexposed');
  });

  it('rejects a frame that is too small to measure', () => {
    const q = assessQuality(disc(20, [72, 48, 40], { width: 64, height: 64 }));
    expect(q.report.issues.map((i) => i.code)).toContain('too_small');
  });
});

describe('otsu', () => {
  it('lands between two separated modes', () => {
    const v = new Float32Array(1000);
    for (let i = 0; i < 500; i++) v[i] = 10;
    for (let i = 500; i < 1000; i++) v[i] = 90;
    const t = otsuThreshold(v, 100);
    expect(t).toBeGreaterThan(10);
    expect(t).toBeLessThan(90);
  });
});

describe('segmentation', () => {
  it('finds a disc of roughly the right area', () => {
    const radius = 60;
    const mask = segment(disc(radius));
    const expected = Math.PI * radius * radius;
    // Working copy is 256px, below the 512 downsample cap, so areas are directly comparable.
    expect(mask.area).toBeGreaterThan(expected * 0.85);
    expect(mask.area).toBeLessThan(expected * 1.15);
  });

  it('finds an erythematous patch that a brightness threshold would miss', () => {
    // This is the case that motivates segmenting on colour distance rather than luminance:
    // the patch is *redder* than skin, not darker.
    const img = erythematousPatch(60);
    const mask = segment(img);
    expect(mask.area).toBeGreaterThan(Math.PI * 60 * 60 * 0.7);
  });

  it('reports no subject rather than segmenting an entire uniform frame', () => {
    // A perfectly uniform frame drives the Otsu threshold to zero, at which point floating-point
    // dust in the Lab conversion flips every pixel into the foreground. The guard catches it.
    const mask = segment(blank({ noise: 0 }));
    expect(mask.area).toBe(0);
  });

  it('surfaces no_subject in the quality report when segmentation finds nothing', () => {
    const { quality } = extractFeatures(blank({ noise: 0 }));
    expect(quality.usable).toBe(false);
    expect(quality.issues.map((i) => i.code)).toContain('no_subject');
  });
});

describe('shape features', () => {
  it('scores a disc as near-circular and near-symmetric', () => {
    const { features } = extractFeatures(disc(70));
    expect(features.borderIrregularity).toBeGreaterThan(0.9);
    expect(features.borderIrregularity).toBeLessThan(1.1);
    expect(features.asymmetry).toBeLessThan(0.05);
  });

  it('measures the same disc the same way with and without sensor noise', () => {
    // Regression guard. Before Kulpa correction and mask smoothing this pair differed by 0.35,
    // which made border irregularity a measure of camera noise rather than lesion shape.
    const noisy = extractFeatures(disc(70, [72, 48, 40], { noise: 10 })).features;
    const clean = extractFeatures(disc(70, [72, 48, 40], { noise: 0 })).features;
    expect(Math.abs(noisy.borderIrregularity - clean.borderIrregularity)).toBeLessThan(0.12);
  });

  it('scores a lobed blob as far more border-irregular than a disc', () => {
    const round = extractFeatures(disc(70)).features;
    const lobed = extractFeatures(lobedBlob(70)).features;
    expect(lobed.borderIrregularity).toBeGreaterThan(round.borderIrregularity * 2.5);
  });

  it('scores a crescent as far more asymmetric than a disc', () => {
    const round = extractFeatures(disc(70)).features;
    const bitten = extractFeatures(crescent(70)).features;
    expect(bitten.asymmetry).toBeGreaterThan(round.asymmetry + 0.15);
  });

  it('reports a contour that closes and stays inside the frame', () => {
    const { features } = extractFeatures(disc(70));
    expect(features.contour.length).toBeGreaterThan(20);
    expect(features.contour.length).toBeLessThanOrEqual(240);
    for (const [x, y] of features.contour) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(256);
      expect(y).toBeLessThanOrEqual(256);
    }
  });

  it('measures diameter in source-image pixels, not working-copy pixels', () => {
    // A 1024px frame is downsampled to 512 internally; the reported diameter must still be
    // in the caller's coordinate system or the mm conversion would be silently wrong.
    const big = disc(240, [72, 48, 40], { width: 1024, height: 1024 });
    const { features } = extractFeatures(big);
    expect(features.diameterPx).toBeGreaterThan(420);
    expect(features.diameterPx).toBeLessThan(540);
  });

  it('converts to millimetres when a scale reference is supplied', () => {
    const { features } = extractFeatures(disc(70), { pixelsPerMm: 10 });
    expect(features.diameterMm).toBeCloseTo(features.diameterPx / 10, 1);
  });
});

describe('colour features', () => {
  it('scores a two-tone lesion as more variegated than a single-tone one', () => {
    const plain = extractFeatures(disc(70)).features;
    const twoTone = extractFeatures(twoToneDisc(70)).features;
    expect(plain.colourHeterogeneity).toBeLessThan(1.3);
    expect(twoTone.colourHeterogeneity).toBeGreaterThan(1.8);
  });

  it('does not count sensor noise as colour variegation', () => {
    // Regression guard. Perplexity over raw k-means clusters scored a uniformly brown noisy disc
    // at 5.2 "colours" — higher than a genuinely two-toned lesion. Perceptual merging fixed it.
    const noisy = extractFeatures(disc(70, [72, 48, 40], { noise: 14 })).features;
    expect(noisy.colourHeterogeneity).toBeLessThan(1.5);
  });

  it('reports mean colour inside the mask, not the whole frame', () => {
    const { features } = extractFeatures(disc(70, [40, 30, 25]));
    const [r, g, b] = features.meanColour;
    expect(r).toBeLessThan(90);
    expect(g).toBeLessThan(80);
    expect(b).toBeLessThan(80);
  });
});

describe('determinism', () => {
  it('produces identical output for identical input', () => {
    const img = twoToneDisc(70);
    const a = extractFeatures(img).features;
    const b = extractFeatures(img).features;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces different output for visibly different input', () => {
    const a = extractFeatures(disc(70)).features;
    const b = extractFeatures(lobedBlob(70)).features;
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});
