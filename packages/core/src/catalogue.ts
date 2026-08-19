/**
 * The condition catalogue.
 *
 * IMPORTANT, and repeated in the UI: the coefficients below are *illustrative* mappings written to
 * make a prototype's reasoning legible and testable. They are not fitted parameters and carry no
 * clinical validity. In the real system this table is replaced by a model trained on a labelled
 * dataset (ISIC, HAM10000, or the client's own corpus), and this file becomes the label taxonomy
 * plus the priors — nothing more.
 *
 * What the table *does* give us, honestly, is a differential that responds to the actual pixels and
 * the actual symptoms, with every contribution attributable to a named cue. That is what makes the
 * readout explainable, and it is the property the production model must preserve.
 */
import type { Acuity, ConditionId } from './schemas.js';

/**
 * A cue is a normalised 0..1 activation derived from image features or intake text.
 * Conditions are scored as a weighted sum of cue activations in log-odds space.
 */
export type CueId =
  | 'asymmetry'
  | 'borderIrregularity'
  | 'colourVariegation'
  | 'diameter'
  | 'textureRoughness'
  | 'erythema'
  | 'pigmentation'
  | 'pearlySheen'
  | 'scaling';

export const CUE_LABELS: Record<CueId, string> = {
  asymmetry: 'Asymmetry',
  borderIrregularity: 'Border irregularity',
  colourVariegation: 'Colour variegation',
  diameter: 'Diameter',
  textureRoughness: 'Surface texture',
  erythema: 'Erythema',
  pigmentation: 'Pigmentation',
  pearlySheen: 'Pearly sheen',
  scaling: 'Scale / flaking',
};

export interface SymptomToken {
  /** Matched case-insensitively against the tokenised intake text, and against symptom chip ids. */
  token: string;
  /** Log-odds added when present and not negated. */
  weight: number;
}

export interface ConditionDef {
  id: ConditionId;
  displayName: string;
  icd10: string;
  /** Rough relative frequency in a primary-care photographed-lesion population. Sums to 1.0. */
  prior: number;
  /** Baseline urgency when this condition leads the differential. */
  urgency: Acuity;
  /** Log-odds added per unit of cue activation. */
  cueWeights: Partial<Record<CueId, number>>;
  symptomTokens: SymptomToken[];
  /** Natural-language prompts for zero-shot CLIP. Averaged into one label embedding. */
  labelPrompts: string[];
  /** What the readout advises. Written as an action, not a diagnosis. */
  guidance: string;
}

export const CONDITIONS: readonly ConditionDef[] = [
  {
    id: 'melanoma',
    displayName: 'Melanoma',
    icd10: 'C43',
    prior: 0.04,
    urgency: 'urgent',
    // The ABCD rule: asymmetry, border, colour, diameter. The reason this catalogue is
    // dermatology-shaped at all is that these four are measurable from a photograph.
    cueWeights: {
      asymmetry: 2.4,
      borderIrregularity: 2.2,
      colourVariegation: 2.6,
      diameter: 1.4,
      pigmentation: 1.1,
      erythema: -0.5,
    },
    symptomTokens: [
      { token: 'changing', weight: 1.6 },
      // Whole-word matching keeps this from firing inside "unchanged" — see `findToken`.
      { token: 'changed', weight: 1.5 },
      { token: 'growing', weight: 1.4 },
      { token: 'bleeding', weight: 1.2 },
      { token: 'itching', weight: 0.4 },
      { token: 'irregular', weight: 1.0 },
      { token: 'dark', weight: 0.8 },
      { token: 'new mole', weight: 1.1 },
      { token: 'asymmetric', weight: 1.0 },
    ],
    labelPrompts: [
      'a close-up clinical photograph of a malignant melanoma skin lesion',
      'a dermoscopy image of melanoma with irregular borders and multiple colours',
    ],
    guidance: 'Refer for same-day or urgent dermatology assessment.',
  },
  {
    id: 'basal_cell_carcinoma',
    displayName: 'Basal cell carcinoma',
    icd10: 'C44.91',
    prior: 0.1,
    urgency: 'prompt',
    cueWeights: {
      pearlySheen: 2.5,
      borderIrregularity: 0.8,
      erythema: 0.9,
      pigmentation: -0.3,
      textureRoughness: 0.4,
    },
    symptomTokens: [
      { token: 'sore that will not heal', weight: 1.8 },
      { token: 'non-healing', weight: 1.8 },
      { token: 'bleeding', weight: 0.9 },
      { token: 'shiny', weight: 1.3 },
      { token: 'sun exposure', weight: 0.7 },
      { token: 'crusting', weight: 0.6 },
    ],
    labelPrompts: [
      'a close-up clinical photograph of a basal cell carcinoma with a pearly rolled border',
      'a shiny translucent nodule on sun-exposed skin with visible telangiectasia',
    ],
    guidance: 'Refer to dermatology within two weeks.',
  },
  {
    id: 'squamous_cell_carcinoma',
    displayName: 'Squamous cell carcinoma',
    icd10: 'C44.92',
    prior: 0.05,
    urgency: 'prompt',
    cueWeights: {
      textureRoughness: 2.1,
      erythema: 1.2,
      borderIrregularity: 1.0,
      scaling: 1.4,
      pearlySheen: -0.4,
    },
    symptomTokens: [
      { token: 'non-healing', weight: 1.6 },
      { token: 'crusting', weight: 1.2 },
      { token: 'tender', weight: 0.9 },
      { token: 'rough', weight: 1.0 },
      { token: 'growing', weight: 1.0 },
      { token: 'sun exposure', weight: 0.7 },
    ],
    labelPrompts: [
      'a close-up clinical photograph of a squamous cell carcinoma, a scaly crusted red nodule',
      'a hyperkeratotic ulcerated skin tumour on sun-damaged skin',
    ],
    guidance: 'Refer to dermatology within two weeks.',
  },
  {
    id: 'benign_nevus',
    displayName: 'Benign melanocytic naevus',
    icd10: 'D22',
    prior: 0.3,
    urgency: 'routine',
    cueWeights: {
      asymmetry: -1.8,
      borderIrregularity: -1.6,
      colourVariegation: -1.4,
      pigmentation: 1.4,
      diameter: -0.6,
    },
    symptomTokens: [
      { token: 'unchanged', weight: 1.5 },
      { token: 'stable', weight: 1.5 },
      { token: 'since childhood', weight: 1.3 },
      { token: 'painless', weight: 0.5 },
      { token: 'symmetric', weight: 0.9 },
    ],
    labelPrompts: [
      'a close-up clinical photograph of a benign symmetric brown mole on skin',
      'an ordinary melanocytic naevus with an even colour and a regular round border',
    ],
    guidance: 'No action beyond routine self-monitoring for change.',
  },
  {
    id: 'seborrheic_keratosis',
    displayName: 'Seborrhoeic keratosis',
    icd10: 'L82',
    prior: 0.18,
    urgency: 'routine',
    cueWeights: {
      textureRoughness: 1.8,
      pigmentation: 1.0,
      borderIrregularity: -0.5,
      colourVariegation: 0.3,
      scaling: 0.9,
    },
    symptomTokens: [
      { token: 'stuck on', weight: 1.7 },
      { token: 'waxy', weight: 1.5 },
      { token: 'warty', weight: 1.3 },
      { token: 'unchanged', weight: 0.8 },
      { token: 'older', weight: 0.5 },
    ],
    labelPrompts: [
      'a close-up clinical photograph of a seborrhoeic keratosis with a waxy stuck-on appearance',
      'a warty brown plaque with a rough greasy surface on adult skin',
    ],
    guidance: 'Benign. Routine review only if it becomes symptomatic.',
  },
  {
    id: 'eczema_dermatitis',
    displayName: 'Eczema / dermatitis',
    icd10: 'L20-L30',
    prior: 0.16,
    urgency: 'routine',
    cueWeights: {
      erythema: 1.9,
      scaling: 1.3,
      colourVariegation: -0.8,
      pigmentation: -1.2,
      borderIrregularity: 0.6,
      diameter: 0.5,
    },
    symptomTokens: [
      { token: 'itching', weight: 1.8 },
      { token: 'dry', weight: 1.2 },
      { token: 'flaking', weight: 1.1 },
      { token: 'flare', weight: 1.0 },
      { token: 'both sides', weight: 0.9 },
      { token: 'worse at night', weight: 0.7 },
    ],
    labelPrompts: [
      'a close-up clinical photograph of eczema, dry itchy inflamed red skin',
      'an ill-defined scaly erythematous patch of atopic dermatitis',
    ],
    guidance: 'Manage in primary care; refer if it fails to respond to treatment.',
  },
  {
    id: 'psoriasis',
    displayName: 'Psoriasis',
    icd10: 'L40',
    prior: 0.08,
    urgency: 'routine',
    cueWeights: {
      scaling: 2.4,
      erythema: 1.5,
      borderIrregularity: -0.9,
      textureRoughness: 1.0,
      pigmentation: -1.0,
    },
    symptomTokens: [
      { token: 'silvery scale', weight: 2.0 },
      { token: 'plaques', weight: 1.6 },
      { token: 'elbows', weight: 1.0 },
      { token: 'knees', weight: 1.0 },
      { token: 'scalp', weight: 0.8 },
      { token: 'nail changes', weight: 1.1 },
      { token: 'family history', weight: 0.6 },
    ],
    labelPrompts: [
      'a close-up clinical photograph of a psoriasis plaque with thick silvery white scale',
      'well-demarcated erythematous plaques with silvery scaling on skin',
    ],
    guidance: 'Manage in primary care; refer if extensive or joint symptoms are present.',
  },
  {
    id: 'cellulitis',
    displayName: 'Cellulitis',
    icd10: 'L03',
    prior: 0.09,
    urgency: 'urgent',
    cueWeights: {
      erythema: 2.8,
      diameter: 1.3,
      pigmentation: -1.4,
      borderIrregularity: 0.7,
      scaling: -0.8,
      colourVariegation: -0.6,
    },
    symptomTokens: [
      { token: 'hot', weight: 1.7 },
      { token: 'swollen', weight: 1.6 },
      { token: 'painful', weight: 1.5 },
      { token: 'fever', weight: 2.0 },
      { token: 'spreading', weight: 1.8 },
      { token: 'red streaks', weight: 2.0 },
      { token: 'unwell', weight: 1.2 },
    ],
    labelPrompts: [
      'a clinical photograph of cellulitis, a hot spreading area of red swollen skin',
      'a warm tender erythematous area of skin infection with poorly defined edges',
    ],
    guidance: 'Assess same day. Systemic symptoms warrant urgent care.',
  },
  {
    id: 'insufficient_evidence',
    displayName: 'Insufficient evidence',
    icd10: '—',
    prior: 0,
    urgency: 'indeterminate',
    cueWeights: {},
    symptomTokens: [],
    labelPrompts: [],
    guidance: 'Recapture the image or refer for in-person assessment.',
  },
];

const BY_ID = new Map<ConditionId, ConditionDef>(CONDITIONS.map((c) => [c.id, c]));

export function getCondition(id: ConditionId): ConditionDef {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`Unknown condition id: ${id}`);
  return c;
}

/** Conditions that can actually be ranked — everything except the abstention outcome. */
export const RANKABLE: readonly ConditionDef[] = CONDITIONS.filter(
  (c) => c.id !== 'insufficient_evidence',
);
