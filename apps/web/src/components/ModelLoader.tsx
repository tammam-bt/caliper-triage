import type { LoadProgress } from '../providers/onDeviceClip.js';

interface Props {
  state: LoadProgress;
  sizeBytes: number;
  onLoad: () => void;
}

/**
 * The neural model is opt-in and says its own size before it costs anything. A 22 MB download that
 * starts on page load is a page that appears broken on a slow connection.
 */
export function ModelLoader({ state, sizeBytes, onLoad }: Props) {
  const mb = (sizeBytes / 1e6).toFixed(1);

  return (
    <section className="model">
      <div className="model__row">
        <span className="model__name">On-device neural model</span>
        <span className="model__size num">{mb} MB</span>
      </div>

      <p className="model__note">
        MobileCLIP S0, run locally in this browser. It is a general-purpose image model standing in
        for a fine-tuned diagnostic network — real inference on your pixels, not a clinical
        classifier. Without it, assessment uses the measured features alone.
      </p>

      {state.phase === 'idle' && (
        <button type="button" className="button button--quiet" onClick={onLoad}>
          Load model ({mb} MB)
        </button>
      )}

      {state.phase === 'loading' && (
        <>
          <span className="model__size num">{state.message}</span>
          <span className="progressbar">
            <span className="progressbar__fill" style={{ width: `${Math.round(state.progress * 100)}%` }} />
          </span>
        </>
      )}

      {state.phase === 'ready' && <span className="model__size num">{state.message}</span>}

      {state.phase === 'failed' && (
        <>
          <span className="model__size num">{state.message}</span>
          <button type="button" className="button button--quiet" onClick={onLoad}>
            Try again
          </button>
        </>
      )}
    </section>
  );
}
