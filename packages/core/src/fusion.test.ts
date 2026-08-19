import { describe, expect, it } from 'vitest';
import { DEFAULT_WEIGHTS, MAX_REPORTED_CONFIDENCE, fuse } from './fusion.js';
import { extractFeatures } from './features.js';
import { IntakeSchema } from './schemas.js';
import type { FuseInput } from './fusion.js';
import type { Intake, QualityReport } from './schemas.js';
import { crescent, disc, erythematousPatch, lobedBlob, twoToneDisc } from './testing/fixtures.js';

const OK: QualityReport = { usable: true, issues: [] };
const intake = (partial: Partial<Intake> = {}): Intake => IntakeSchema.parse(partial);

const run = (over: Partial<FuseInput> = {}) =>
  fuse({ intake: intake(), quality: OK, features: extractFeatures(disc(70)).features, ...over });

describe('output shape', () => {
  it('returns a full ranked differential that sums to one', () => {
    const out = run();
    expect(out.candidates.length).toBe(8);
    const total = out.candidates.reduce((s, c) => s + c.probability, 0);
    expect(total).toBeCloseTo(1, 2);
  });

  it('sorts candidates by descending probability', () => {
    const p = run().candidates.map((c) => c.probability);
    expect([...p].sort((a, b) => b - a)).toEqual(p);
  });

  it('attaches evidence to every candidate, ordered by magnitude', () => {
    for (const c of run().candidates) {
      expect(c.evidence.length).toBeGreaterThan(0);
      const mags = c.evidence.map((e) => Math.abs(e.contribution));
      expect([...mags].sort((a, b) => b - a)).toEqual(mags);
    }
  });
});

/** Every fixture pairing, so calibration bounds are asserted where they are actually at risk. */
const ALL_CASES: Array<[string, ReturnType<typeof extractFeatures>['features'], string]> = [
  ['plain disc, no history', extractFeatures(disc(70)).features, ''],
  ['lobed, changing', extractFeatures(lobedBlob(70)).features, 'changing, growing, bleeding, irregular'],
  ['two-tone, stable', extractFeatures(twoToneDisc(70)).features, 'unchanged since childhood, stable'],
  ['erythema, infection', extractFeatures(erythematousPatch(60)).features, 'hot swollen painful fever spreading'],
  ['crescent, itchy', extractFeatures(crescent(70)).features, 'itchy and dry and flaking'],
];

describe('calibration', () => {
  // Asserting this on the *weakest* case would pass vacuously — its confidence is 0.20 whatever
  // the temperature. The bound only means something on the strongest case the fixtures can build.
  it.each(ALL_CASES)('keeps %s under the reported-confidence ceiling', (_name, features, text) => {
    const out = fuse({ intake: intake({ symptomsText: text }), quality: OK, features });
    expect(out.confidence).toBeLessThanOrEqual(MAX_REPORTED_CONFIDENCE);
  });

  it('holds the strongest available case well below certainty', () => {
    const strongest = Math.max(
      ...ALL_CASES.map(([, features, text]) =>
        fuse({ intake: intake({ symptomsText: text }), quality: OK, features }).confidence),
    );
    expect(strongest).toBeGreaterThan(0.5);
    expect(strongest).toBeLessThan(0.8);
  });

  it('spreads probability more as temperature rises', () => {
    const sharp = run({ weights: { temperature: 1 } }).confidence;
    const flat = run({ weights: { temperature: 4 } }).confidence;
    expect(flat).toBeLessThan(sharp);
  });
});

describe('abstention', () => {
  it('abstains when the image failed the quality gate', () => {
    const out = run({
      quality: {
        usable: false,
        issues: [{ code: 'blur', measured: 12, threshold: 40, message: 'too soft' }],
      },
    });
    expect(out.abstained).toBe(true);
    expect(out.abstainReason).toMatch(/quality gate/i);
  });

  it('abstains when there is no image evidence at all', () => {
    const out = fuse({ intake: intake({ symptomsText: 'itchy' }), quality: OK });
    expect(out.abstained).toBe(true);
    expect(out.abstainReason).toMatch(/no image evidence/i);
  });

  it('abstains when the top two candidates are too close to separate', () => {
    const out = run({ weights: { abstainMargin: 0.99 } });
    expect(out.abstained).toBe(true);
    expect(out.abstainReason).toMatch(/too close/i);
  });

  it('caps reported confidence when abstaining', () => {
    const out = run({ weights: { abstainMargin: 0.99 } });
    expect(out.confidence).toBeLessThanOrEqual(0.5);
  });

  it('still escalates acuity when it abstains on a plausibly urgent case', () => {
    // The failure this guards against: refusing to answer and therefore also refusing to
    // recommend that a potentially urgent lesion be looked at.
    const out = fuse({
      intake: intake({ symptomsText: 'hot swollen painful with fever and spreading red streaks' }),
      quality: {
        usable: false,
        issues: [{ code: 'blur', measured: 9, threshold: 40, message: 'too soft' }],
      },
      features: extractFeatures(erythematousPatch(60)).features,
    });
    expect(out.abstained).toBe(true);
    expect(out.acuity).not.toBe('routine');
  });
});

describe('acuity', () => {
  it('triages on the worst plausible candidate, not the most likely one', () => {
    // A differential led by something benign but with a real chance of something urgent must
    // still recommend the urgent action.
    const out = fuse({
      intake: intake({ symptomsText: 'changing, irregular, bleeding' }),
      quality: OK,
      features: extractFeatures(lobedBlob(70)).features,
      weights: { acuityFloor: 0.05 },
    });
    const urgentCandidate = out.candidates.find((c) => c.acuity === 'urgent');
    if (urgentCandidate && urgentCandidate.probability >= 0.05) {
      expect(out.acuity).toBe('urgent');
    }
  });

  it.each(ALL_CASES)('never returns indeterminate acuity once committed (%s)', (_n, features, text) => {
    const out = fuse({ intake: intake({ symptomsText: text }), quality: OK, features });
    if (!out.abstained) expect(out.acuity).not.toBe('indeterminate');
  });

  it('abstains on a featureless lesion with no history, rather than guessing', () => {
    // A plain brown circle with nothing reported genuinely is ambiguous between a naevus and a
    // seborrhoeic keratosis. Committing here would be the system inventing certainty.
    const out = fuse({ intake: intake(), quality: OK, features: extractFeatures(disc(70)).features });
    expect(out.abstained).toBe(true);
    expect(out.confidence).toBeLessThan(0.35);
  });
});

describe('evidence routing', () => {
  it('moves an irregular, variegated lesion up the malignant end of the differential', () => {
    const benign = fuse({ intake: intake(), quality: OK, features: extractFeatures(disc(70)).features });
    const suspicious = fuse({
      intake: intake(),
      quality: OK,
      features: extractFeatures(lobedBlob(70)).features,
    });
    const melanomaOf = (o: typeof benign) =>
      o.candidates.find((c) => c.conditionId === 'melanoma')!.probability;
    expect(melanomaOf(suspicious)).toBeGreaterThan(melanomaOf(benign));
  });

  it('moves an erythematous patch with infection symptoms toward cellulitis', () => {
    const out = fuse({
      intake: intake({ symptomsText: 'hot, swollen, painful, spreading, fever' }),
      quality: OK,
      features: extractFeatures(erythematousPatch(60)).features,
    });
    expect(out.candidates[0]!.conditionId).toBe('cellulitis');
  });

  it('lets intake text change the ranking for identical pixels', () => {
    // Same photo, opposite histories. If the text did not matter, the intake form would be theatre.
    const img = extractFeatures(twoToneDisc(70)).features;
    const stable = fuse({
      intake: intake({ symptomsText: 'unchanged since childhood, stable, painless' }),
      quality: OK,
      features: img,
    });
    const changing = fuse({
      intake: intake({ symptomsText: 'changing, growing, bleeding, irregular' }),
      quality: OK,
      features: img,
    });
    const mel = (o: typeof stable) => o.candidates.find((c) => c.conditionId === 'melanoma')!.probability;
    expect(mel(changing)).toBeGreaterThan(mel(stable));
  });
});

describe('external model posterior', () => {
  it('shifts the ranking toward what the model believes', () => {
    const withoutModel = run();
    const withModel = run({
      modelPosterior: { psoriasis: 0.9, benign_nevus: 0.05 },
      modelLabel: 'MobileCLIP S0 (zero-shot)',
    });
    const pso = (o: typeof withoutModel) =>
      o.candidates.find((c) => c.conditionId === 'psoriasis')!.probability;
    expect(pso(withModel)).toBeGreaterThan(pso(withoutModel));
  });

  it('credits the model by name in the evidence trace', () => {
    const out = run({ modelPosterior: { psoriasis: 0.9 }, modelLabel: 'MobileCLIP S0 (zero-shot)' });
    const pso = out.candidates.find((c) => c.conditionId === 'psoriasis')!;
    expect(pso.evidence.some((e) => e.source === 'model' && e.label.includes('MobileCLIP'))).toBe(true);
  });

  it('does not let the model alone override a failed quality gate', () => {
    const out = run({
      modelPosterior: { melanoma: 0.99 },
      quality: { usable: false, issues: [{ code: 'blur', measured: 5, threshold: 40, message: 'x' }] },
    });
    expect(out.abstained).toBe(true);
  });
});

describe('the evolving flag', () => {
  it('raises malignant candidates and lowers benign ones', () => {
    // The flag is modelled separately from the text lexicon precisely so that a user who ticks
    // the box but writes nothing still gets the benefit of the strongest historical red flag.
    const features = extractFeatures(twoToneDisc(70)).features;
    const stable = fuse({ intake: intake(), quality: OK, features });
    const evolving = fuse({ intake: intake({ evolving: true }), quality: OK, features });
    const p = (o: typeof stable, id: string) =>
      o.candidates.find((c) => c.conditionId === id)!.probability;
    expect(p(evolving, 'melanoma')).toBeGreaterThan(p(stable, 'melanoma'));
    expect(p(evolving, 'benign_nevus')).toBeLessThan(p(stable, 'benign_nevus'));
  });

  it('records itself in the evidence trace', () => {
    const out = fuse({
      intake: intake({ evolving: true }),
      quality: OK,
      features: extractFeatures(twoToneDisc(70)).features,
    });
    const mel = out.candidates.find((c) => c.conditionId === 'melanoma')!;
    expect(mel.evidence.some((e) => e.source === 'history' && e.label === 'Lesion is changing')).toBe(true);
  });
});

describe('the user’s own suspicion', () => {
  it('counts for something', () => {
    const neutral = run();
    const suspected = run({ intake: intake({ suspectedConditionId: 'psoriasis' }) });
    const pso = (o: typeof neutral) => o.candidates.find((c) => c.conditionId === 'psoriasis')!.probability;
    expect(pso(suspected)).toBeGreaterThan(pso(neutral));
  });

  it('cannot on its own dictate the answer', () => {
    // Otherwise the tool becomes a mirror: select a condition, get told you were right.
    const out = fuse({
      intake: intake({ suspectedConditionId: 'melanoma' }),
      quality: OK,
      features: extractFeatures(disc(70)).features,
    });
    expect(out.candidates[0]!.conditionId).not.toBe('melanoma');
  });
});

describe('determinism', () => {
  it('gives byte-identical output for identical input', () => {
    const f = extractFeatures(crescent(70)).features;
    const input: FuseInput = { intake: intake({ symptomsText: 'itchy and growing' }), quality: OK, features: f };
    expect(JSON.stringify(fuse(input))).toBe(JSON.stringify(fuse(input)));
  });

  it('exposes its weights so calibration is inspectable', () => {
    expect(DEFAULT_WEIGHTS.temperature).toBeGreaterThan(1);
  });
});
