/**
 * Zero-shot classification with MobileCLIP, in the browser, on the user's machine.
 *
 * What this genuinely is: a real neural network, downloaded and executed locally, producing scores
 * that depend on the actual pixels. What it is not: a diagnostic model. CLIP was trained on
 * web image-text pairs, not on a dermatology corpus, and zero-shot transfer to clinical imagery is
 * weak. The UI says so, in those words, wherever this provider's output appears.
 *
 * It is here because the honest alternative to "a trained diagnostic model we do not have" is a
 * real model doing a real thing, clearly labelled — not a random number wearing a percentage sign.
 *
 * Cost: a 21.8 MiB download, once, on explicit opt-in. Never on page load.
 * See `docs/AUDIT.md` Gate 0 for why fp16 and not one of the 11.8 MB int8 builds.
 */
import type { ConditionId, Intake, MediaRef, RgbaImage } from '@caliper/core';
import type { InferenceProvider, ProviderOutput } from '@caliper/service';
import { CvHeuristicProvider } from '@caliper/service';
import labelData from '../model/labelEmbeddings.json';

export const CLIP_MODEL_ID = 'Xenova/mobileclip_s0';
export const CLIP_DOWNLOAD_BYTES = 22_876_479;

/**
 * Temperature for the similarity softmax. CLIP's trained logit scale (~100) is calibrated for
 * ImageNet-style label sets; applied to nine clinical prompts it produces near-one-hot output,
 * which would be a confident claim this model has not earned. 25 keeps the posterior informative
 * without pretending it is decisive, and fusion re-calibrates on top of it anyway.
 */
const LOGIT_SCALE = 25;

export type LoadPhase = 'idle' | 'loading' | 'ready' | 'failed';

export interface LoadProgress {
  phase: LoadPhase;
  /** 0..1 across the model download, when the runtime reports it. */
  progress: number;
  message: string;
}

type Listener = (p: LoadProgress) => void;

interface ClipModules {
  processor: unknown;
  visionModel: unknown;
  RawImage: {
    new (data: Uint8ClampedArray, width: number, height: number, channels: number): unknown;
  };
}

export class OnDeviceClipProvider implements InferenceProvider {
  readonly id = 'on-device-clip';
  readonly modelId = 'mobileclip_s0 (zero-shot)';

  private readonly heuristic = new CvHeuristicProvider();
  private modules: ClipModules | null = null;
  private loading: Promise<ClipModules> | null = null;
  private readonly listeners = new Set<Listener>();

  state: LoadProgress = { phase: 'idle', progress: 0, message: 'Not loaded' };

  onProgress(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private emit(state: LoadProgress): void {
    this.state = state;
    for (const fn of this.listeners) fn(state);
  }

  get ready(): boolean {
    return this.modules !== null;
  }

  /** Explicit, user-initiated. Nothing here runs unless the user asks for it. */
  async load(): Promise<void> {
    if (this.modules) return;
    if (!this.loading) this.loading = this.doLoad();
    await this.loading;
  }

  private async doLoad(): Promise<ClipModules> {
    this.emit({ phase: 'loading', progress: 0, message: 'Fetching model…' });
    try {
      const transformers = await import('@huggingface/transformers');
      const { AutoProcessor, CLIPVisionModelWithProjection, RawImage } = transformers;

      const seen = new Map<string, { loaded: number; total: number }>();
      const progress_callback = (event: { status?: string; file?: string; loaded?: number; total?: number }) => {
        if (event.status !== 'progress' || !event.file || !event.total) return;
        seen.set(event.file, { loaded: event.loaded ?? 0, total: event.total });
        let loaded = 0;
        let total = 0;
        for (const v of seen.values()) { loaded += v.loaded; total += v.total; }
        const ratio = total > 0 ? Math.min(1, loaded / total) : 0;
        this.emit({
          phase: 'loading',
          progress: ratio,
          message: `Downloading model  ${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`,
        });
      };

      const [processor, visionModel] = await Promise.all([
        AutoProcessor.from_pretrained(CLIP_MODEL_ID, { progress_callback } as never),
        // fp16, not int8. Every int8 build of this model returns noise — see AUDIT Gate 0.
        CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL_ID, {
          dtype: 'fp16',
          progress_callback,
        } as never),
      ]);

      const modules: ClipModules = {
        processor,
        visionModel,
        RawImage: RawImage as unknown as ClipModules['RawImage'],
      };
      this.modules = modules;
      this.emit({ phase: 'ready', progress: 1, message: 'Model ready — running on this device' });
      return modules;
    } catch (error) {
      this.loading = null;
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ phase: 'failed', progress: 0, message: `Could not load the model: ${message}` });
      throw error;
    }
  }

  async infer(input: { frames: RgbaImage[]; intake: Intake; media: MediaRef }): Promise<ProviderOutput> {
    // The measured features and the quality gate always come from the heuristic pass, whatever the
    // network says. They are what the viewport draws and what the abstention rule reads.
    const base = await this.heuristic.infer(input);
    if (!this.modules) return base;

    const frame = input.frames[0];
    if (!frame) return base;

    try {
      const posterior = await this.classify(frame);
      return { ...base, modelPosterior: posterior, modelLabel: 'MobileCLIP S0 (zero-shot)' };
    } catch {
      // A WASM or WebGPU failure downgrades the answer; it does not remove it.
      return base;
    }
  }

  private async classify(frame: RgbaImage): Promise<Partial<Record<ConditionId, number>>> {
    const { processor, visionModel, RawImage } = this.modules!;
    const image = new RawImage(frame.data, frame.width, frame.height, 4);

    const inputs = await (processor as (i: unknown) => Promise<unknown>)(image);
    const output = await (visionModel as (i: unknown) => Promise<{ image_embeds: { tolist(): number[][] } }>)(inputs);
    const embedding = l2normalise(output.image_embeds.tolist()[0]!);

    const entries = Object.entries(labelData.embeddings) as Array<[ConditionId, number[]]>;
    const logits = entries.map(([, vector]) => dot(embedding, vector) * LOGIT_SCALE);
    const max = Math.max(...logits);
    const exps = logits.map((v) => Math.exp(v - max));
    const sum = exps.reduce((a, b) => a + b, 0);

    const posterior: Partial<Record<ConditionId, number>> = {};
    entries.forEach(([id], i) => { posterior[id] = exps[i]! / sum; });
    return posterior;
  }
}

function l2normalise(v: number[]): number[] {
  const n = Math.hypot(...v);
  return n > 0 ? v.map((x) => x / n) : v;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i]! * b[i]!;
  return s;
}
