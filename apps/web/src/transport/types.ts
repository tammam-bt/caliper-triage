/**
 * One interface, two implementations.
 *
 * `HttpTransport` talks to `apps/api` over HTTP and Socket.IO. `InBrowserTransport` runs the same
 * `@caliper/service` use-cases against in-memory adapters, in this tab. The components above this
 * line cannot tell which they were handed, which is the point: the deployed demo exercises the
 * real handlers and the real schemas, and pointing it at a server is a one-line change.
 */
import type { Analysis, Intake, MediaUpload, PipelineEvent, SubmitAnalysisResponse } from '@caliper/core';
import type { RgbaImage } from '@caliper/core';

export interface SubmitArgs {
  intake: Intake;
  media: MediaUpload;
  bytes: Uint8Array;
  /** Already decoded by the UI for preview; handed over so nothing is decoded twice. */
  frames: RgbaImage[];
  idempotencyKey?: string;
}

/**
 * A recorded request/response pair. The inspector panel renders these so a reviewer can read the
 * actual API contract, in both transports.
 */
export interface Exchange {
  id: string;
  at: string;
  verb: string;
  path: string;
  status: number | string;
  request?: unknown;
  response?: unknown;
}

export interface Transport {
  readonly mode: 'in-browser' | 'http';
  readonly description: string;
  submit(args: SubmitArgs): Promise<SubmitAnalysisResponse>;
  get(analysisId: string): Promise<Analysis>;
  subscribe(analysisId: string, onEvent: (event: PipelineEvent) => void): () => void;
  /** Newest last. */
  exchanges(): Exchange[];
  onExchange(fn: (exchanges: Exchange[]) => void): () => void;
}

export class ExchangeLog {
  private readonly rows: Exchange[] = [];
  private readonly listeners = new Set<(rows: Exchange[]) => void>();
  private n = 0;

  record(entry: Omit<Exchange, 'id' | 'at'>): void {
    this.n += 1;
    this.rows.push({ ...entry, id: `x${this.n}`, at: new Date().toISOString() });
    // Keep the panel bounded; a long session should not grow without limit.
    if (this.rows.length > 40) this.rows.splice(0, this.rows.length - 40);
    for (const fn of this.listeners) fn([...this.rows]);
  }

  all(): Exchange[] {
    return [...this.rows];
  }

  subscribe(fn: (rows: Exchange[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
