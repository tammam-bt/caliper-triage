/**
 * The readout.
 *
 * Set in the serif, because this half of the app is a document rather than a control surface, and
 * every machine-produced number is in the mono. The evidence trace is the part that matters: a
 * percentage on its own is not something a clinician can act on or disagree with, and a differential
 * that cannot be argued with is one that will either be trusted blindly or ignored entirely.
 */
import { useState } from 'react';
import type { Analysis, Candidate, InferenceResult } from '@caliper/core';
import { getCondition } from '@caliper/core';

interface Props {
  analysis: Analysis | null;
  running: boolean;
  error: string | null;
}

const BAND_TEXT: Record<string, string> = {
  urgent: 'Urgent — same-day review',
  prompt: 'Prompt — review within two weeks',
  routine: 'Routine',
  indeterminate: 'Indeterminate',
};

export function AssessmentPanel({ analysis, running, error }: Props) {
  const [openCandidate, setOpenCandidate] = useState<string | null>(null);
  const result = analysis?.result ?? null;

  if (error) {
    return (
      <div className="assessment">
        <div className="notice notice--stop">
          <strong>The analysis did not complete.</strong>
          <br />
          {error}
        </div>
        <Disclaimer />
      </div>
    );
  }

  if (!result) {
    return (
      <div className="assessment">
        <div className="empty">
          <p className="empty__title">{running ? 'Assessment in progress.' : 'No case yet.'}</p>
          <p>
            {running
              ? 'Stages are shown along the bottom of the console.'
              : 'Add a photograph and any symptoms, then run the assessment.'}
          </p>
        </div>
        <Disclaimer />
      </div>
    );
  }

  const top = result.candidates[0]!;
  const shown = result.candidates.filter((c) => c.probability >= 0.01).slice(0, 6);

  return (
    <div className="assessment">
      <section className="acuity" data-band={result.acuity}>
        <span className="acuity__band">{BAND_TEXT[result.acuity] ?? result.acuity}</span>
        <p className="acuity__guidance">
          {result.abstained
            ? getCondition('insufficient_evidence').guidance
            : getCondition(top.conditionId).guidance}
        </p>
      </section>

      {result.abstained && (
        <div className="notice notice--warn">
          <strong>Withheld.</strong> {result.abstainReason}
          <span className="notice__measure">
            The differential below is shown for transparency, not as a conclusion.
          </span>
        </div>
      )}

      {!result.quality.usable && (
        <div className="notice notice--warn">
          <strong>Image quality.</strong>
          {result.quality.issues.map((issue) => (
            <span key={issue.code} className="notice__measure">
              {issue.message} (measured {issue.measured}, threshold {issue.threshold})
            </span>
          ))}
        </div>
      )}

      {!result.abstained && (
        <div className="headline">
          <h2 className="headline__name">{top.displayName}</h2>
          <div className="headline__confidence">
            <div className="headline__value">{(result.confidence * 100).toFixed(0)}%</div>
            <span className="label">confidence</span>
          </div>
        </div>
      )}

      <section className="differential" aria-label="Differential">
        <h3 className="label">Differential</h3>
        {shown.map((candidate) => (
          <CandidateRow
            key={candidate.conditionId}
            candidate={candidate}
            open={openCandidate === candidate.conditionId}
            onToggle={() =>
              setOpenCandidate(openCandidate === candidate.conditionId ? null : candidate.conditionId)
            }
          />
        ))}
      </section>

      <Provenance result={result} />
      <Disclaimer />
    </div>
  );
}

function CandidateRow({ candidate, open, onToggle }: {
  candidate: Candidate;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="candidate"
        data-acuity={candidate.acuity}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="candidate__name">{candidate.displayName}</span>
        <span className="candidate__value">{(candidate.probability * 100).toFixed(1)}%</span>
        <span className="candidate__bar">
          <span className="candidate__fill" style={{ width: `${Math.max(1, candidate.probability * 100)}%` }} />
        </span>
      </button>

      {open && (
        <div className="evidence">
          <span className="label">Why</span>
          {candidate.evidence.map((item, i) => (
            <div className="evidence__row" key={`${item.label}-${i}`}>
              <span className="evidence__label">{item.label}</span>
              <span className="evidence__value" data-sign={item.contribution >= 0 ? '+' : '-'}>
                {item.contribution >= 0 ? '+' : ''}
                {item.contribution.toFixed(2)}
              </span>
              <span className="evidence__detail">{item.detail}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Provenance({ result }: { result: InferenceResult }) {
  return (
    <section className="evidence" aria-label="Provenance">
      <span className="label">Provenance</span>
      <div className="evidence__row">
        <span className="evidence__label">Provider</span>
        <span className="evidence__value">{result.provider}</span>
      </div>
      <div className="evidence__row">
        <span className="evidence__label">Model</span>
        <span className="evidence__value">{result.modelId}</span>
      </div>
      <div className="evidence__row">
        <span className="evidence__label">Compute</span>
        <span className="evidence__value">{result.computeMs} ms</span>
      </div>
      {result.frameFeatures && (
        <div className="evidence__row">
          <span className="evidence__label">Frames measured</span>
          <span className="evidence__value">{result.frameFeatures.length}</span>
        </div>
      )}
    </section>
  );
}

export function Disclaimer() {
  return (
    <aside className="disclaimer">
      <strong>Not a medical device.</strong> Caliper is an engineering prototype. It is not
      clinically validated, has not been trained on a labelled dataset, and must not be used to
      make a care decision. Its coefficients are illustrative. Seek assessment from a qualified
      clinician.
    </aside>
  );
}
