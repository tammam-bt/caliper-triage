import { STAGES, type Stage } from '@caliper/core';

interface Props {
  current: Stage | null;
  failed: boolean;
  message: string;
  computeMs?: number;
}

const LABELS: Record<Stage, string> = {
  received: 'received',
  preprocess: 'preprocess',
  features: 'features',
  inference: 'inference',
  fusion: 'fusion',
  complete: 'complete',
};

/**
 * The pipeline stages are a genuine ordered sequence, which is the only reason they are rendered
 * as one. Ordinal markers on content that is not ordered are decoration.
 */
export function PipelineRail({ current, failed, message, computeMs }: Props) {
  const index = current ? STAGES.indexOf(current) : -1;

  return (
    <nav className="rail" aria-label="Analysis pipeline">
      {STAGES.map((stage, i) => {
        const state =
          failed && i === index ? 'failed'
            : i < index ? 'done'
            : i === index ? 'active'
            : 'pending';
        return (
          <span key={stage} className="rail__stage" data-state={state}>
            <span className="rail__tick" aria-hidden="true" />
            <span className="rail__label">{LABELS[stage]}</span>
          </span>
        );
      })}
      <span className="rail__message">
        {message}
        {computeMs !== undefined && (
          <>
            {message ? '  ·  ' : ''}
            {computeMs} ms compute
          </>
        )}
      </span>
    </nav>
  );
}
