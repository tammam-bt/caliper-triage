/**
 * Calibration regression guard, over real photographs.
 *
 * The synthetic fixtures in `@caliper/core/testing` prove the algorithms are correct: a disc is
 * circular, a crescent is asymmetric. They cannot prove the *cue mapping* is calibrated, because a
 * clean disc measures border irregularity 1.0 and a real lesion boundary measures 3.8 to 6.5.
 *
 * For a while the ramps were anchored to the fixtures, so on every real photograph both of
 * melanoma's dominant cues sat pinned at 1.0 activation and melanoma led the differential
 * regardless of what the picture contained. Every unit test still passed. This file is what would
 * have caught it: it runs the four bundled clinical samples through the real pipeline and asserts
 * the cues discriminate and the dispositions differ.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { extractFeatures, featuresToCues, fuse, IntakeSchema } from '@caliper/core';
import type { CueId } from '@caliper/core';

const SAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../web/public/samples');

interface SampleExpectation {
  file: string;
  symptoms: string;
  /** Mirrors the chips the app ticks for this sample. */
  symptomIds: string[];
  evolving?: boolean;
  /** null when the calibration layer is expected to decline to commit. */
  expectTop: string | null;
  expectAcuity: string;
}

const SAMPLES: SampleExpectation[] = [
  {
    file: 'melanoma.jpg',
    symptoms:
      'Pigmented lesion on the upper back. Changing over the past four months, the border has become irregular and it bled once after catching on clothing.',
    symptomIds: ['changing', 'bleeding'],
    evolving: true,
    expectTop: 'melanoma',
    expectAcuity: 'urgent',
  },
  {
    file: 'bcc.jpg',
    symptoms:
      'A shiny raised area on sun-exposed skin. It is a sore that will not heal, crusting over and then breaking down again over several months.',
    // The image alone is ambiguous to this heuristic: with colour measured relative to surrounding
    // skin, a BCC that is neither darker nor redder than its background gives no colour signal, and
    // melanoma and BCC tie exactly. The intake breaks the tie — which is the whole point of fusing
    // history with pixels rather than ranking on pixels alone.
    symptomIds: ['non-healing'],
    expectTop: 'basal_cell_carcinoma',
    expectAcuity: 'prompt',
  },
  {
    file: 'dermatitis.jpg',
    symptoms:
      'Itchy, dry, flaking skin that has been coming and going for months. No fever, no bleeding, and it has not changed in shape.',
    symptomIds: ['itching', 'dry'],
    expectTop: 'eczema_dermatitis',
    expectAcuity: 'routine',
  },
  {
    file: 'cellulitis.jpg',
    symptoms:
      'The lower leg is hot, swollen and painful. It has been spreading since yesterday and there is a fever. No itching.',
    symptomIds: ['fever', 'spreading'],
    expectTop: 'cellulitis',
    expectAcuity: 'urgent',
  },
];

async function assess(sample: SampleExpectation) {
  const { data, info } = await sharp(await readFile(join(SAMPLES_DIR, sample.file)))
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { features, quality } = extractFeatures({
    data: new Uint8ClampedArray(data),
    width: info.width,
    height: info.height,
  });
  const cues = featuresToCues(features);
  const out = fuse({
    intake: IntakeSchema.parse({
      symptomsText: sample.symptoms,
      symptomIds: sample.symptomIds,
      ...(sample.evolving ? { evolving: true } : {}),
    }),
    quality,
    features,
  });
  return { features, cues, out };
}

describe('bundled clinical samples', () => {
  it.each(SAMPLES)('reaches the expected disposition for $file', async (sample) => {
    const { out } = await assess(sample);
    if (sample.expectTop === null) {
      expect(out.abstained).toBe(true);
    } else {
      expect(out.abstained).toBe(false);
      expect(out.candidates[0]!.conditionId).toBe(sample.expectTop);
    }
    expect(out.acuity).toBe(sample.expectAcuity);
  });

  it.each(SAMPLES)('does not saturate its image cues on $file', async (sample) => {
    const { cues } = await assess(sample);
    const saturated = (Object.entries(cues) as Array<[CueId, number]>).filter(([, v]) => v >= 0.999);
    // Two pinned cues is tolerable on a strong example; four means the ramps no longer span the
    // input range and the differential has stopped depending on the picture.
    expect(saturated.length, `saturated: ${saturated.map(([k]) => k).join(', ')}`).toBeLessThanOrEqual(2);
  });

  it('passes the quality gate on all four', async () => {
    for (const sample of SAMPLES) {
      const { out } = await assess(sample);
      expect(out.candidates.length).toBe(8);
    }
  });

  it('measures four visibly different photographs differently', async () => {
    const results = await Promise.all(SAMPLES.map(assess));
    const signatures = results.map((r) =>
      [r.features.asymmetry, r.features.borderIrregularity, r.features.colourHeterogeneity].join('/'),
    );
    expect(new Set(signatures).size).toBe(SAMPLES.length);
  });

  it('produces four distinct top-1 conditions across the set', async () => {
    // The failure mode this guards: one condition leading every differential, which is exactly
    // what happened when the cue ramps were calibrated against synthetic fixtures.
    const results = await Promise.all(SAMPLES.map(assess));
    const tops = new Set(results.map((r) => r.out.candidates[0]!.conditionId));
    expect(tops.size).toBe(SAMPLES.length);
  });

  it('spans three acuity bands across the set', async () => {
    const results = await Promise.all(SAMPLES.map(assess));
    expect(new Set(results.map((r) => r.out.acuity)).size).toBeGreaterThanOrEqual(3);
  });
});
