import { CONDITIONS } from '@caliper/core';
import type { ConditionId } from '@caliper/core';
import { SAMPLES, SYMPTOM_CHIPS, type SampleCase } from '../samples.js';

export interface IntakeDraft {
  symptomsText: string;
  symptomIds: string[];
  suspectedConditionId: ConditionId | '';
  bodySite: string;
  durationDays: string;
  evolving: boolean;
}

export const EMPTY_INTAKE: IntakeDraft = {
  symptomsText: '', symptomIds: [], suspectedConditionId: '', bodySite: '', durationDays: '', evolving: false,
};

interface Props {
  draft: IntakeDraft;
  onChange: (draft: IntakeDraft) => void;
  onSample: (sample: SampleCase) => void;
  onRun: () => void;
  onReset: () => void;
  canRun: boolean;
  running: boolean;
  hasMedia: boolean;
}

export function IntakePanel({ draft, onChange, onSample, onRun, onReset, canRun, running, hasMedia }: Props) {
  const set = <K extends keyof IntakeDraft>(key: K, value: IntakeDraft[K]) =>
    onChange({ ...draft, [key]: value });

  const toggleChip = (chip: string) =>
    set('symptomIds', draft.symptomIds.includes(chip)
      ? draft.symptomIds.filter((c) => c !== chip)
      : [...draft.symptomIds, chip]);

  return (
    <>
      <div className="field">
        <span className="label">Sample cases</span>
        <div className="samples">
          {SAMPLES.map((sample) => (
            <button
              key={sample.id}
              type="button"
              className="samples__button"
              title={sample.purpose}
              onClick={() => onSample(sample)}
            >
              {sample.label}
            </button>
          ))}
        </div>
        <span className="field__hint">
          Loads a real clinical photograph and a plausible history. Credits in the repository.
        </span>
      </div>

      <div className="field">
        <label className="label" htmlFor="symptoms">Symptoms</label>
        <textarea
          id="symptoms"
          className="textarea"
          value={draft.symptomsText}
          placeholder="Describe what the patient reports. Negations are understood — “no fever, but it is spreading” scores the way you would expect."
          onChange={(e) => set('symptomsText', e.target.value)}
        />
      </div>

      <div className="field">
        <span className="label">Reported findings</span>
        <div className="chips">
          {SYMPTOM_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              className="chip"
              aria-pressed={draft.symptomIds.includes(chip)}
              onClick={() => toggleChip(chip)}
            >
              {chip}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label className="label" htmlFor="suspected">Suspected condition (optional)</label>
        <select
          id="suspected"
          className="select"
          value={draft.suspectedConditionId}
          onChange={(e) => set('suspectedConditionId', e.target.value as ConditionId | '')}
        >
          <option value="">No suspicion recorded</option>
          {CONDITIONS.filter((c) => c.id !== 'insufficient_evidence').map((c) => (
            <option key={c.id} value={c.id}>{c.displayName}</option>
          ))}
        </select>
        <span className="field__hint">
          Counted as one piece of evidence among several. It cannot decide the differential on its own.
        </span>
      </div>

      <div className="row">
        <div className="field">
          <label className="label" htmlFor="site">Body site</label>
          <input
            id="site"
            className="input"
            value={draft.bodySite}
            placeholder="upper back"
            onChange={(e) => set('bodySite', e.target.value)}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="duration">Duration (days)</label>
          <input
            id="duration"
            className="input num"
            inputMode="numeric"
            value={draft.durationDays}
            placeholder="120"
            onChange={(e) => set('durationDays', e.target.value.replace(/[^0-9]/g, ''))}
          />
        </div>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={draft.evolving}
          onChange={(e) => set('evolving', e.target.checked)}
        />
        <span>The lesion has changed recently — in size, shape, colour or sensation.</span>
      </label>

      <div className="actions">
        <button type="button" className="button" onClick={onRun} disabled={!canRun}>
          {running ? 'Assessing…' : 'Run assessment'}
        </button>
        {!hasMedia && (
          <span className="field__hint">An image or clip is required before an assessment can run.</span>
        )}
        <button type="button" className="button button--quiet" onClick={onReset} disabled={running}>
          Clear case
        </button>
      </div>
    </>
  );
}
