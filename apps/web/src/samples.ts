/**
 * Sample cases.
 *
 * A reviewer opening a link does not have a clinical photograph to hand, and a demo that cannot be
 * tried is a demo that does not count. Each sample pairs a real image with the intake text a
 * clinician might plausibly have written, so the fusion step has something to fuse.
 *
 * Attribution and licences: `public/samples/ATTRIBUTION.md`.
 */
import type { ConditionId } from '@caliper/core';

export interface SampleCase {
  id: string;
  label: string;
  /** What this sample is here to demonstrate — shown as the button's title. */
  purpose: string;
  src: string;
  symptomsText: string;
  symptomIds: string[];
  suspectedConditionId?: ConditionId;
  evolving?: boolean;
  durationDays?: number;
  credit: string;
}

export const SAMPLES: SampleCase[] = [
  {
    id: 'melanoma',
    label: 'Pigmented lesion, changing',
    purpose: 'Varied colour and pigment with a changing history — expect an urgent band.',
    src: 'samples/melanoma.jpg',
    symptomsText:
      'Pigmented lesion on the upper back. Changing over the past four months, the border has become irregular and it bled once after catching on clothing.',
    symptomIds: ['changing', 'bleeding'],
    evolving: true,
    durationDays: 120,
    credit: 'US National Cancer Institute — public domain',
  },
  {
    id: 'bcc',
    label: 'Pearly nodule, non-healing',
    purpose: 'A non-healing history against a bright, low-pigment surface — expect a prompt band.',
    src: 'samples/bcc.jpg',
    symptomsText:
      'A shiny raised area on sun-exposed skin. It is a sore that will not heal, crusting over and then breaking down again over several months.',
    symptomIds: ['non-healing'],
    durationDays: 180,
    credit: 'James Heilman, MD — CC BY 3.0',
  },
  {
    id: 'dermatitis',
    label: 'Itchy, dry patch',
    purpose: 'Erythema without pigment, stable history — expect a routine disposition.',
    src: 'samples/dermatitis.jpg',
    symptomsText:
      'Itchy, dry, flaking skin that has been coming and going for months. No fever, no bleeding, and it has not changed in shape.',
    symptomIds: ['itching', 'dry'],
    durationDays: 240,
    credit: 'James Heilman, MD — CC BY-SA 4.0',
  },
  {
    id: 'cellulitis',
    label: 'Hot, spreading redness',
    purpose: 'Erythema plus systemic symptoms — the case a brightness threshold would miss.',
    src: 'samples/cellulitis.jpg',
    symptomsText:
      'The lower leg is hot, swollen and painful. It has been spreading since yesterday and there is a fever. No itching.',
    symptomIds: ['fever', 'spreading'],
    durationDays: 2,
    credit: 'Pshawnoah — CC BY-SA 3.0',
  },
];

/** Symptom chips offered at intake. Each maps to a token the catalogue scores. */
export const SYMPTOM_CHIPS = [
  'changing', 'growing', 'bleeding', 'itching', 'painful', 'non-healing',
  'spreading', 'fever', 'swollen', 'hot', 'dry', 'unchanged',
] as const;
