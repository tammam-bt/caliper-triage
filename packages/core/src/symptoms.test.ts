import { describe, expect, it } from 'vitest';
import { matchSymptoms, normalise, scoreSymptoms, toClauses } from './symptoms.js';

const weightFor = (text: string, condition: string): number =>
  scoreSymptoms(text).logOdds[condition as never] ?? 0;

describe('clause splitting', () => {
  it('splits on punctuation and conjunctions', () => {
    expect(toClauses('no fever, but it is spreading')).toEqual(['no fever', 'it is spreading']);
  });

  it('normalises whitespace, smart quotes and contracted negations', () => {
    expect(normalise("  it  hasn’t   changed ")).toBe('it has not changed');
  });
});

describe('negation', () => {
  it('scores a plain positive mention', () => {
    expect(weightFor('the lesion is bleeding', 'melanoma')).toBeGreaterThan(0);
  });

  it('does not score a negated mention as present', () => {
    const positive = weightFor('there is bleeding', 'melanoma');
    const negated = weightFor('there is no bleeding', 'melanoma');
    expect(negated).toBeLessThan(0);
    expect(negated).toBeLessThan(positive);
  });

  it.each([
    'no bleeding',
    'not bleeding',
    'without bleeding',
    'patient denies bleeding',
    'negative for bleeding',
  ])('treats "%s" as absent', (text) => {
    const m = matchSymptoms(text).find((x) => x.token === 'bleeding');
    expect(m?.negated).toBe(true);
  });

  it('does not let a negation leak across a clause boundary', () => {
    // The dangerous failure: "no fever, spreading rapidly" must still score spreading as present.
    const matches = matchSymptoms('no fever, spreading rapidly');
    expect(matches.find((m) => m.token === 'fever')?.negated).toBe(true);
    expect(matches.find((m) => m.token === 'spreading')?.negated).toBe(false);
  });

  it('does not let a negation leak across "but"', () => {
    const matches = matchSymptoms('not painful but it is growing');
    expect(matches.find((m) => m.token === 'painful')?.negated).toBe(true);
    expect(matches.find((m) => m.token === 'growing')?.negated).toBe(false);
  });

  it('does not match a token inside a longer word that means the opposite', () => {
    // "unchanged" contains "changed". Substring matching would extract evidence *for* melanoma
    // from a phrase asserting the lesion is stable.
    const matches = matchSymptoms('the mole is unchanged since childhood');
    expect(matches.find((m) => m.token === 'changed')).toBeUndefined();
    expect(matches.find((m) => m.token === 'unchanged')?.negated).toBe(false);
  });

  it('does not fire on a substring of a longer word', () => {
    // "nother" contains "not"; the negator must be a whole word.
    const matches = matchSymptoms('another lesion is bleeding');
    expect(matches.find((m) => m.token === 'bleeding')?.negated).toBe(false);
  });
});

describe('chips', () => {
  it('scores a ticked chip even when the prose does not mention it', () => {
    expect(scoreSymptoms('', ['fever']).logOdds.cellulitis).toBeGreaterThan(0);
  });

  it('does not let prose negate a ticked chip', () => {
    // A ticked box is an explicit assertion; prose elsewhere must not silently cancel it.
    const m = matchSymptoms('no fever', ['fever']).filter((x) => x.token === 'fever');
    expect(m.every((x) => !x.negated)).toBe(true);
  });
});

describe('evidence trace', () => {
  it('records a signed contribution and a readable label for every match', () => {
    const { evidence } = scoreSymptoms('it is changing and bleeding');
    const items = evidence.melanoma ?? [];
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const item of items) {
      expect(item.source).toBe('symptom');
      expect(item.label).toMatch(/^Reported/);
      expect(Number.isFinite(item.contribution)).toBe(true);
    }
  });

  it('labels negated evidence distinctly', () => {
    const { evidence } = scoreSymptoms('the mole has not changed');
    expect((evidence.melanoma ?? []).some((i) => i.label.startsWith('Reported absent'))).toBe(true);
  });

  it('handles a contracted negation', () => {
    const m = matchSymptoms("it hasn't changed").find((x) => x.token === 'changed');
    expect(m?.negated).toBe(true);
  });

  it('counts a repeated token once', () => {
    const once = weightFor('bleeding', 'melanoma');
    const twice = weightFor('bleeding and bleeding', 'melanoma');
    expect(twice).toBeCloseTo(once, 5);
  });
});

describe('discrimination', () => {
  it('routes infection language to cellulitis, not melanoma', () => {
    const text = 'the area is hot, swollen and painful with fever and red streaks spreading';
    const s = scoreSymptoms(text).logOdds;
    expect(s.cellulitis ?? 0).toBeGreaterThan(s.melanoma ?? 0);
  });

  it('routes stability language to a benign naevus', () => {
    const s = scoreSymptoms('a stable mole, unchanged since childhood, painless').logOdds;
    expect(s.benign_nevus ?? 0).toBeGreaterThan(s.melanoma ?? 0);
  });
});
