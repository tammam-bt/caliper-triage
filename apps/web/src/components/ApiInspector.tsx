/**
 * A reader for the request/response envelopes the transport actually exchanged.
 *
 * It exists because the deployed demo runs its API handlers in the browser, and a claim like
 * "these are the real handlers" is worth nothing if a reviewer cannot check it. The panel shows
 * the same envelopes in either transport, so the contract is legible whether or not a server is
 * on the other end.
 */
import type { Exchange } from '../transport/types.js';

interface Props {
  exchanges: Exchange[];
  mode: string;
  open: boolean;
  onToggle: () => void;
}

/** Opened from the top bar. A floating trigger sat on top of the assessment's own content. */
export function ApiInspector({ exchanges, mode, open, onToggle }: Props) {
  if (!open) return null;

  return (
    <aside className="inspector" aria-label="API inspector">
      <div className="inspector__head">
        <span className="inspector__title">API</span>
        <span className="inspector__note">{mode}</span>
        <button type="button" className="inspector__close" onClick={onToggle}>
          close
        </button>
      </div>
      <div className="inspector__body">
        {exchanges.length === 0 && (
          <p className="inspector__note">Nothing yet. Run an assessment to see the exchange.</p>
        )}
        {[...exchanges].reverse().map((exchange) => (
          <div className="exchange" key={exchange.id}>
            <div className="exchange__line">
              <span className="exchange__verb">{exchange.verb}</span>
              <span>{exchange.path}</span>
              <span className="exchange__status">{exchange.status}</span>
            </div>
            {exchange.request !== undefined && (
              <pre>{'→ '}{JSON.stringify(exchange.request, null, 1)}</pre>
            )}
            {exchange.response !== undefined && (
              <pre>{'← '}{JSON.stringify(exchange.response, null, 1)}</pre>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
