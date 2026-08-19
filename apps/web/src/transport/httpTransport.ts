/**
 * The same interface, against a real `apps/api`.
 *
 * Selected by setting `VITE_API_URL` at build time. Unused by the GitHub Pages deployment — which
 * has no server to talk to — and present so that "point it at the backend" is configuration rather
 * than a rewrite. Exercised by running the API locally and building the web app against it.
 */
import { AnalysisSchema, PipelineEventSchema, SubmitAnalysisResponseSchema } from '@caliper/core';
import type { Analysis, PipelineEvent, SubmitAnalysisResponse } from '@caliper/core';
import { io, type Socket } from 'socket.io-client';
import { ExchangeLog, type Exchange, type SubmitArgs, type Transport } from './types.js';

export class HttpTransport implements Transport {
  readonly mode = 'http' as const;
  readonly description: string;

  private readonly log = new ExchangeLog();
  private socket: Socket | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => string | null,
  ) {
    this.description = `HTTP → ${baseUrl}`;
  }

  async submit(args: SubmitArgs): Promise<SubmitAnalysisResponse> {
    const form = new FormData();
    form.append('width', String(args.media.width));
    form.append('height', String(args.media.height));
    if (args.media.durationMs !== undefined) form.append('durationMs', String(args.media.durationMs));
    form.append('intake', JSON.stringify(args.intake));
    form.append('media', new Blob([args.bytes as BufferSource], { type: args.media.mimeType }), 'upload');

    const headers: Record<string, string> = this.authHeader();
    if (args.idempotencyKey) headers['Idempotency-Key'] = args.idempotencyKey;

    const response = await fetch(`${this.baseUrl}/api/v1/analyses`, { method: 'POST', body: form, headers });
    const body = await response.json();
    this.log.record({ verb: 'POST', path: '/api/v1/analyses', status: response.status, response: body });
    if (!response.ok) throw new Error(body?.error?.message ?? `Upload failed (${response.status})`);
    return SubmitAnalysisResponseSchema.parse(body);
  }

  async get(analysisId: string): Promise<Analysis> {
    const response = await fetch(`${this.baseUrl}/api/v1/analyses/${analysisId}`, { headers: this.authHeader() });
    const body = await response.json();
    this.log.record({ verb: 'GET', path: `/api/v1/analyses/${analysisId}`, status: response.status, response: body });
    if (!response.ok) throw new Error(body?.error?.message ?? `Fetch failed (${response.status})`);
    return AnalysisSchema.parse(body);
  }

  subscribe(analysisId: string, onEvent: (event: PipelineEvent) => void): () => void {
    this.socket ??= io(this.baseUrl, { auth: { token: this.getToken() ?? '' } });
    const socket = this.socket;
    socket.emit('analysis:subscribe', analysisId);

    const handler = (raw: unknown) => {
      const parsed = PipelineEventSchema.safeParse(raw);
      if (!parsed.success || parsed.data.analysisId !== analysisId) return;
      this.log.record({
        verb: 'WS',
        path: `analysis:${analysisId}`,
        status: parsed.data.stage,
        response: { stage: parsed.data.stage, status: parsed.data.status, progress: parsed.data.progress },
      });
      onEvent(parsed.data);
    };

    socket.on('analysis:event', handler);
    return () => {
      socket.off('analysis:event', handler);
      socket.emit('analysis:unsubscribe', analysisId);
    };
  }

  exchanges(): Exchange[] {
    return this.log.all();
  }

  onExchange(fn: (rows: Exchange[]) => void): () => void {
    return this.log.subscribe(fn);
  }

  private authHeader(): Record<string, string> {
    const token = this.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
}
