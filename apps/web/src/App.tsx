import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IntakeSchema, type ConditionId, type ImageFeatures, type MediaUpload, type RgbaImage } from '@caliper/core';
import { CvHeuristicProvider } from '@caliper/service';
import { TopBar } from './components/TopBar.js';
import { IntakePanel, EMPTY_INTAKE, type IntakeDraft } from './components/IntakePanel.js';
import { SpecimenViewport } from './components/SpecimenViewport.js';
import { AssessmentPanel } from './components/AssessmentPanel.js';
import { PipelineRail } from './components/PipelineRail.js';
import { ApiInspector } from './components/ApiInspector.js';
import { ModelLoader } from './components/ModelLoader.js';
import { useAnalysis } from './hooks/useAnalysis.js';
import { decodeImage, decodeMedia, releasePreviews, type DecodedMedia } from './adapters/decode.js';
import { InBrowserTransport } from './transport/inBrowserTransport.js';
import { HttpTransport } from './transport/httpTransport.js';
import { OnDeviceClipProvider, CLIP_DOWNLOAD_BYTES, type LoadProgress } from './providers/onDeviceClip.js';
import type { Exchange, Transport } from './transport/types.js';
import type { SampleCase } from './samples.js';

const REPO_URL = 'https://github.com/tammam-bt/caliper-triage';
const API_URL = import.meta.env.VITE_API_URL as string | undefined;

export default function App() {
  // The provider is swappable at run time (the user may opt into the neural model mid-session), so
  // both it and the transport are created once and mutated rather than rebuilt.
  const clip = useMemo(() => new OnDeviceClipProvider(), []);
  const heuristic = useMemo(() => new CvHeuristicProvider(), []);
  const transport = useMemo<Transport>(
    () => (API_URL ? new HttpTransport(API_URL, () => localStorage.getItem('caliper.token')) : new InBrowserTransport(heuristic)),
    [heuristic],
  );

  const [draft, setDraft] = useState<IntakeDraft>(EMPTY_INTAKE);
  const [media, setMedia] = useState<DecodedMedia | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [selectedFrame, setSelectedFrame] = useState(0);
  const [modelState, setModelState] = useState<LoadProgress>(clip.state);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const previous = useRef<DecodedMedia | null>(null);

  const { analysis, stage, running, error, message, run, reset } = useAnalysis(transport);

  useEffect(() => clip.onProgress(setModelState), [clip]);
  useEffect(() => transport.onExchange(setExchanges), [transport]);

  // Revoke the previous case's object URLs. Without this a session of a dozen videos holds every
  // frame thumbnail it ever made.
  useEffect(() => {
    if (previous.current && previous.current !== media) releasePreviews(previous.current.previews);
    previous.current = media;
  }, [media]);

  const setDecoded = useCallback((decoded: DecodedMedia) => {
    setMedia(decoded);
    setSelectedFrame(0);
    setMediaError(null);
    reset();
  }, [reset]);

  const onFiles = useCallback(async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setDecoding(true);
    setMediaError(null);
    try {
      setDecoded(await decodeMedia(file));
    } catch (e) {
      setMediaError(e instanceof Error ? e.message : 'That file could not be decoded.');
    } finally {
      setDecoding(false);
    }
  }, [setDecoded]);

  const onSample = useCallback(async (sample: SampleCase) => {
    setDecoding(true);
    setMediaError(null);
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}${sample.src}`);
      if (!response.ok) throw new Error(`Could not load the sample (${response.status}).`);
      setDecoded(await decodeImage(await response.blob()));
      setDraft({
        symptomsText: sample.symptomsText,
        symptomIds: [...sample.symptomIds],
        suspectedConditionId: sample.suspectedConditionId ?? '',
        bodySite: '',
        durationDays: sample.durationDays ? String(sample.durationDays) : '',
        evolving: sample.evolving ?? false,
      });
    } catch (e) {
      setMediaError(e instanceof Error ? e.message : 'Could not load that sample.');
    } finally {
      setDecoding(false);
    }
  }, [setDecoded]);

  const onLoadModel = useCallback(async () => {
    try {
      await clip.load();
      if (transport instanceof InBrowserTransport) transport.setProvider(clip);
    } catch {
      // The provider reports its own failure through onProgress; nothing to add here.
    }
  }, [clip, transport]);

  const onRun = useCallback(() => {
    if (!media) return;
    const intake = IntakeSchema.parse({
      symptomsText: draft.symptomsText,
      symptomIds: draft.symptomIds,
      ...(draft.suspectedConditionId ? { suspectedConditionId: draft.suspectedConditionId as ConditionId } : {}),
      ...(draft.bodySite ? { bodySite: draft.bodySite } : {}),
      ...(draft.durationDays ? { durationDays: Number(draft.durationDays) } : {}),
      ...(draft.evolving ? { evolving: true } : {}),
    });

    const upload: MediaUpload = {
      kind: media.kind,
      mimeType: media.mimeType,
      byteSize: estimateBytes(media),
      width: media.width,
      height: media.height,
      ...(media.durationMs ? { durationMs: media.durationMs, sampledFrames: media.frames.length } : {}),
    };

    void run({
      intake,
      media: upload,
      bytes: new Uint8Array(0),
      frames: media.frames as RgbaImage[],
      idempotencyKey: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    });
  }, [draft, media, run]);

  const onReset = useCallback(() => {
    setDraft(EMPTY_INTAKE);
    setMedia(null);
    setMediaError(null);
    reset();
  }, [reset]);

  const features: ImageFeatures | null =
    analysis?.result?.frameFeatures?.[selectedFrame] ?? analysis?.result?.features ?? null;

  const keyFrameIndex = useMemo(() => {
    const frames = analysis?.result?.frameFeatures;
    if (!frames || frames.length < 2) return 0;
    let best = 0;
    for (let i = 1; i < frames.length; i++) if (frames[i]!.blurScore > frames[best]!.blurScore) best = i;
    return best;
  }, [analysis]);

  const previewUrl = media?.previews[media.previews.length > 1 ? selectedFrame : 0] ?? null;

  return (
    <div className="console">
      <TopBar
        mode={transport.mode === 'in-browser' ? 'in-browser API' : 'remote API'}
        modelId={modelState.phase === 'ready' ? 'mobileclip_s0' : 'abcd-heuristic-v1'}
        repoUrl={REPO_URL}
        inspectorCount={exchanges.length}
        onToggleInspector={() => setInspectorOpen((v) => !v)}
      />

      <main className="workspace">
        <section className="panel panel--intake" aria-label="Intake">
          <header className="panel__head">
            <span className="panel__step">01</span>
            <h2 className="panel__title">Intake</h2>
          </header>
          <div className="panel__body">
            <IntakePanel
              draft={draft}
              onChange={setDraft}
              onSample={onSample}
              onRun={onRun}
              onReset={onReset}
              canRun={Boolean(media) && !running && !decoding}
              running={running}
              hasMedia={Boolean(media)}
            />
          </div>
        </section>

        <SpecimenViewport
          previewUrl={previewUrl}
          naturalWidth={media?.width ?? 0}
          naturalHeight={media?.height ?? 0}
          features={features}
          framePreviews={media && media.previews.length > 1 ? media.previews : []}
          keyFrameIndex={keyFrameIndex}
          selectedFrame={selectedFrame}
          onSelectFrame={setSelectedFrame}
          onFiles={onFiles}
          busy={running || decoding}
        />

        <section className="panel panel--assessment" aria-label="Assessment">
          <header className="panel__head">
            <span className="panel__step">02</span>
            <h2 className="panel__title">Assessment</h2>
          </header>
          <div className="panel__body">
            {mediaError && <div className="notice notice--stop">{mediaError}</div>}
            <ModelLoader state={modelState} sizeBytes={CLIP_DOWNLOAD_BYTES} onLoad={onLoadModel} />
            <AssessmentPanel analysis={analysis} running={running} error={error} />
          </div>
        </section>
      </main>

      <PipelineRail
        current={stage}
        failed={Boolean(error)}
        message={decoding ? 'decoding media…' : message}
        {...(analysis?.result ? { computeMs: analysis.result.computeMs } : {})}
      />

      <ApiInspector
        exchanges={exchanges}
        mode={transport.description}
        open={inspectorOpen}
        onToggle={() => setInspectorOpen((v) => !v)}
      />
    </div>
  );
}

/** Frames are already decoded, so the wire size is reported from the RGBA we actually hold. */
function estimateBytes(media: DecodedMedia): number {
  return media.frames.reduce((total, frame) => total + frame.data.byteLength, 0);
}
