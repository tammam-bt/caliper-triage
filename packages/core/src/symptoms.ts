/**
 * Intake text -> symptom evidence.
 *
 * Deliberately not an LLM call. The lexicon is small, the domain is closed, and a rule that can be
 * unit-tested beats a model that cannot be for this particular job. The one thing a naive keyword
 * matcher gets catastrophically wrong is negation — "no bleeding, no itching" scoring as bleeding
 * and itching — so that is handled explicitly and tested.
 */
import type { ConditionId } from './schemas.js';
import type { EvidenceItem } from './schemas.js';
import { RANKABLE } from './catalogue.js';

/**
 * Words that flip the polarity of everything up to the next clause boundary.
 * Contractions are expanded in `normalise`, so "n't" never has to appear here.
 */
const NEGATORS = [
  'no', 'not', 'never', 'without', 'denies', 'denied', 'negative for', 'absent', 'free of',
];

/** Boundaries that end a negation's scope. Without these, "no fever, skin is spreading" mis-scores. */
const CLAUSE_BREAKS = /[,.;:!?]|\b(?:but|however|although|though|and then|whereas)\b/g;

export interface SymptomMatch {
  token: string;
  conditionId: ConditionId;
  weight: number;
  negated: boolean;
}

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    // Expand contracted negations so the negator is a free-standing word: "hasn't" -> "has not".
    // Matching "n't" as a substring instead would fail the whole-word test in `clauseIsNegated`.
    .replace(/n't\b/g, ' not')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word (or whole-phrase) search. Substring matching is not merely sloppy here, it inverts
 * meaning: "unchanged" contains "changed", so an `indexOf` would score a stable mole as a changing
 * one — evidence for melanoma extracted from a statement that it is benign.
 */
function findToken(clause: string, needle: string): number {
  const m = new RegExp(`\\b${escapeRegExp(needle)}\\b`).exec(clause);
  return m ? m.index : -1;
}

/** Split into clauses so a negation cannot leak past a comma or a conjunction. */
export function toClauses(text: string): string[] {
  return normalise(text)
    .split(CLAUSE_BREAKS)
    .map((c) => (c ?? '').trim())
    .filter((c) => c.length > 0);
}

function clauseIsNegated(clause: string, tokenIndex: number): boolean {
  const before = clause.slice(0, tokenIndex);
  return NEGATORS.some((neg) => {
    const idx = before.lastIndexOf(neg);
    if (idx < 0) return false;
    // The negator must be a whole word, and reasonably close to what it negates.
    const charBefore = idx === 0 ? ' ' : before[idx - 1]!;
    const charAfter = before[idx + neg.length] ?? ' ';
    const isWord = /[\s'"(]/.test(charBefore) && /[\s'"),]/.test(charAfter);
    return isWord && before.length - (idx + neg.length) <= 30;
  });
}

/**
 * Find every catalogue symptom token in the text, tagging each with whether it was negated.
 * Chip ids are treated as their own clause: a ticked box cannot be negated by prose.
 */
export function matchSymptoms(symptomsText: string, symptomIds: readonly string[] = []): SymptomMatch[] {
  const matches: SymptomMatch[] = [];
  const clauses = toClauses(symptomsText);
  const chips = new Set(symptomIds.map((s) => normalise(s)));

  for (const condition of RANKABLE) {
    for (const { token, weight } of condition.symptomTokens) {
      const needle = normalise(token);

      if (chips.has(needle)) {
        matches.push({ token, conditionId: condition.id, weight, negated: false });
        continue;
      }

      for (const clause of clauses) {
        const idx = findToken(clause, needle);
        if (idx < 0) continue;
        matches.push({
          token,
          conditionId: condition.id,
          weight,
          negated: clauseIsNegated(clause, idx),
        });
        break; // one hit per token per condition; repetition is not stronger evidence
      }
    }
  }
  return matches;
}

/**
 * Per-condition log-odds from the intake, plus the evidence trace the readout renders.
 * A negated token subtracts at 60% of its positive weight: "it has not changed" is real evidence
 * against melanoma, but weaker than "it is changing" is evidence for it.
 */
export const NEGATION_DISCOUNT = 0.6;

export interface SymptomScore {
  logOdds: Partial<Record<ConditionId, number>>;
  evidence: Partial<Record<ConditionId, EvidenceItem[]>>;
}

export function scoreSymptoms(symptomsText: string, symptomIds: readonly string[] = []): SymptomScore {
  const logOdds: Partial<Record<ConditionId, number>> = {};
  const evidence: Partial<Record<ConditionId, EvidenceItem[]>> = {};

  for (const m of matchSymptoms(symptomsText, symptomIds)) {
    const contribution = m.negated ? -m.weight * NEGATION_DISCOUNT : m.weight;
    logOdds[m.conditionId] = (logOdds[m.conditionId] ?? 0) + contribution;
    (evidence[m.conditionId] ??= []).push({
      source: 'symptom',
      label: m.negated ? `Reported absent: ${m.token}` : `Reported: ${m.token}`,
      detail: m.negated ? 'negated in intake' : 'stated in intake',
      contribution: round(contribution, 3),
    });
  }
  return { logOdds, evidence };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
