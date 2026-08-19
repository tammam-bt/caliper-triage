/**
 * Evidence fusion and calibration.
 *
 * Everything upstream produces log-odds contributions from independent sources: the prevalence
 * prior, the image cues, the intake text, and optionally an external model. This module adds them
 * up, converts to probabilities, decides whether the result is worth reporting at all, and keeps
 * the receipts.
 *
 * Three deliberate choices, in order of how much they matter:
 *
 * 1. **Temperature scaling.** A raw softmax over hand-weighted log-odds is wildly overconfident.
 *    Dividing the logits by T > 1 before the softmax flattens the distribution. It cannot make the
 *    numbers *correct* — only a validation set can do that — but it stops the prototype from
 *    printing "94%" next to a guess.
 *
 * 2. **Abstention.** If the top two candidates are within a small margin, or the image failed the
 *    quality gate, the system returns `insufficient_evidence` rather than committing. A triage aid
 *    that always answers trains its users to trust it uniformly, which is the failure mode that
 *    actually hurts people.
 *
 * 3. **Acuity from the worst plausible candidate, not the most likely one.** If melanoma sits at
 *    22% behind a benign naevus at 40%, the correct action is still an urgent referral. Triage
 *    ranks by consequence; only the differential ranks by likelihood.
 */
import type {
  Acuity,
  Candidate,
  ConditionId,
  EvidenceItem,
  ImageFeatures,
  Intake,
  QualityReport,
} from './schemas.js';
import { CUE_LABELS, RANKABLE, getCondition } from './catalogue.js';
import type { CueId } from './catalogue.js';
import { featuresToCues } from './cues.js';
import { scoreSymptoms } from './symptoms.js';

export interface FusionWeights {
  prior: number;
  image: number;
  symptom: number;
  model: number;
  history: number;
  /** Softmax temperature. Above 1 flattens; this is the calibration knob. */
  temperature: number;
  /** Minimum top-1 minus top-2 probability required to commit to an answer. */
  abstainMargin: number;
  /** Probability at or above which a candidate's urgency counts toward the overall acuity. */
  acuityFloor: number;
}

export const DEFAULT_WEIGHTS: FusionWeights = {
  prior: 1,
  image: 1,
  symptom: 0.8,
  model: 1.5,
  history: 1,
  // Swept against the fixtures: at 1.8 the strongest case reported 95% confidence, which no
  // hand-weighted, never-validated model has any business printing. At 3.0 the same case reports
  // 74%, an unremarkable benign lesion 38%, and an uninformative one 20%.
  temperature: 3,
  abstainMargin: 0.06,
  acuityFloor: 0.2,
};

export interface FuseInput {
  intake: Intake;
  quality: QualityReport;
  features?: ImageFeatures;
  /** Posterior from an external model (zero-shot CLIP, vision LLM). Values need not sum to 1. */
  modelPosterior?: Partial<Record<ConditionId, number>>;
  /** Shown in the evidence trace, e.g. "MobileCLIP S0 (zero-shot)". */
  modelLabel?: string;
  weights?: Partial<FusionWeights>;
}

export interface FuseOutput {
  candidates: Candidate[];
  abstained: boolean;
  abstainReason?: string;
  confidence: number;
  acuity: Acuity;
}

const ACUITY_RANK: Record<Acuity, number> = { indeterminate: 0, routine: 1, prompt: 2, urgent: 3 };

/**
 * Hard ceiling on reported confidence.
 *
 * Temperature scaling is normally *fitted* on a held-out validation set. There is no validation set
 * here, so the temperature above is a judgement call, and a judgement call cannot license a number
 * like 0.97. The ceiling makes that limitation structural rather than incidental: no input can
 * produce a confidence this prototype has not earned. A model fitted on labelled data replaces the
 * ceiling with a real reliability curve — and only then is it honest to remove it.
 */
export const MAX_REPORTED_CONFIDENCE = 0.85;

export function fuse(input: FuseInput): FuseOutput {
  const w = { ...DEFAULT_WEIGHTS, ...input.weights };
  const cues = input.features ? featuresToCues(input.features) : null;
  const symptoms = scoreSymptoms(input.intake.symptomsText, input.intake.symptomIds);

  const logOdds = new Map<ConditionId, number>();
  const trace = new Map<ConditionId, EvidenceItem[]>();

  for (const condition of RANKABLE) {
    const items: EvidenceItem[] = [];

    // --- prevalence prior -------------------------------------------------
    const priorLo = Math.log(Math.max(condition.prior, 1e-4)) * w.prior;
    items.push({
      source: 'prior',
      label: 'Base rate',
      detail: `${(condition.prior * 100).toFixed(0)}% of photographed lesions`,
      contribution: r3(priorLo),
    });
    let total = priorLo;

    // --- image cues -------------------------------------------------------
    if (cues) {
      for (const [cueId, weight] of Object.entries(condition.cueWeights) as Array<[CueId, number]>) {
        const activation = cues[cueId];
        if (activation === undefined) continue;
        const contribution = activation * weight * w.image;
        if (Math.abs(contribution) < 0.01) continue;
        items.push({
          source: 'image',
          label: CUE_LABELS[cueId],
          detail: `${activation.toFixed(2)} activation ${describe(activation)}`,
          contribution: r3(contribution),
        });
        total += contribution;
      }
    }

    // --- intake text ------------------------------------------------------
    const symLo = (symptoms.logOdds[condition.id] ?? 0) * w.symptom;
    if (symLo !== 0) {
      total += symLo;
      for (const item of symptoms.evidence[condition.id] ?? []) {
        items.push({ ...item, contribution: r3(item.contribution * w.symptom) });
      }
    }

    // --- history ----------------------------------------------------------
    // "Has it changed?" is the strongest single historical question in skin triage, so it is
    // modelled separately from the free-text lexicon rather than depending on the user's phrasing.
    if (input.intake.evolving === true && condition.cueWeights.asymmetry) {
      const contribution = Math.sign(condition.cueWeights.asymmetry) * 0.9 * w.history;
      total += contribution;
      items.push({
        source: 'history',
        label: 'Lesion is changing',
        detail: 'reported by the user',
        contribution: r3(contribution),
      });
    }

    // --- the user's own suspicion ----------------------------------------
    // Worth something — they can see the thing in person and we cannot — but deliberately small,
    // so the readout cannot be steered into agreeing with whatever was selected.
    if (input.intake.suspectedConditionId === condition.id) {
      const contribution = 0.45;
      total += contribution;
      items.push({
        source: 'history',
        label: 'User-suspected condition',
        detail: 'selected at intake',
        contribution: r3(contribution),
      });
    }

    // --- external model ---------------------------------------------------
    if (input.modelPosterior) {
      const p = input.modelPosterior[condition.id];
      if (p !== undefined && p > 0) {
        const contribution = Math.log(Math.max(p, 1e-4)) * w.model;
        total += contribution;
        items.push({
          source: 'model',
          label: input.modelLabel ?? 'Model',
          detail: `${(p * 100).toFixed(1)}% posterior`,
          contribution: r3(contribution),
        });
      }
    }

    logOdds.set(condition.id, total);
    trace.set(
      condition.id,
      items.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 6),
    );
  }

  // --- temperature-scaled softmax ------------------------------------------
  const ids = [...logOdds.keys()];
  const scaled = ids.map((id) => logOdds.get(id)! / w.temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);

  const candidates: Candidate[] = ids
    .map((id, i) => {
      const def = getCondition(id);
      return {
        conditionId: id,
        displayName: def.displayName,
        probability: exps[i]! / sum,
        logOdds: r3(logOdds.get(id)!),
        acuity: def.urgency,
        evidence: trace.get(id) ?? [],
      };
    })
    .sort((a, b) => b.probability - a.probability);

  // --- abstention -----------------------------------------------------------
  const top = candidates[0]!;
  const second = candidates[1];
  const margin = second ? top.probability - second.probability : 1;

  let abstained = false;
  let abstainReason: string | undefined;
  if (!input.quality.usable) {
    abstained = true;
    const codes = input.quality.issues.map((i) => i.code).join(', ');
    abstainReason = `Image quality gate failed (${codes}). Assessment withheld.`;
  } else if (!input.features && !input.modelPosterior) {
    abstained = true;
    abstainReason = 'No image evidence was available. Intake text alone is not sufficient.';
  } else if (margin < w.abstainMargin) {
    abstained = true;
    abstainReason = `Top two candidates are within ${(margin * 100).toFixed(1)} points. Too close to call.`;
  }

  // --- acuity ---------------------------------------------------------------
  let acuity: Acuity;
  if (abstained) {
    // Withholding an answer must not withhold the escalation. If something urgent is plausible,
    // the recommendation is still "get this looked at".
    const plausibleUrgent = candidates.find(
      (c) => c.probability >= w.acuityFloor && ACUITY_RANK[c.acuity] >= ACUITY_RANK.prompt,
    );
    acuity = plausibleUrgent ? plausibleUrgent.acuity : 'indeterminate';
  } else {
    acuity = candidates
      .filter((c) => c.probability >= w.acuityFloor)
      .reduce<Acuity>((worst, c) => (ACUITY_RANK[c.acuity] > ACUITY_RANK[worst] ? c.acuity : worst), top.acuity);
  }

  return {
    candidates: candidates.map((c) => ({ ...c, probability: r4(c.probability) })),
    abstained,
    ...(abstainReason ? { abstainReason } : {}),
    confidence: r4(
      abstained ? Math.min(top.probability, 0.5) : Math.min(top.probability, MAX_REPORTED_CONFIDENCE),
    ),
    acuity,
  };
}

function describe(activation: number): string {
  if (activation >= 0.66) return '(high)';
  if (activation >= 0.33) return '(moderate)';
  return '(low)';
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
