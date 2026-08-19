# Production architecture

The task asked for a written explanation of five things: how video uploads are handled, how frames
are processed, how the ML model is connected, how long-running AI processing is managed, and how
results get back to the user. This document answers those, in that order, in terms of what this
repository already does and what changes at production scale.

Everything below is written against the code in this repo. Where the prototype takes a shortcut,
the shortcut is named and the port it hides behind is identified, because "we would swap the
adapter" is only credible if the port exists. It does.

---

## 0. The shape of the system

```
   React web            React Native
   (apps/web)           (apps/mobile)
        │                     │
        └──────────┬──────────┘
                   │  same @caliper/core schemas, same client contract
                   ▼
        ┌──────────────────────┐        ┌──────────────────────┐
        │  API  (Express)      │───────▶│  Redis  (BullMQ)     │
        │  auth, validation,   │        └──────────┬───────────┘
        │  presign, read model │                   │
        └──────────┬───────────┘                   ▼
                   │                    ┌──────────────────────┐
                   │                    │  Ingest worker       │
                   ▼                    │  probe, transcode,   │
        ┌──────────────────────┐        │  frame extraction    │
        │  MongoDB             │◀───────┤                      │
        │  cases, analyses     │        └──────────┬───────────┘
        └──────────────────────┘                   │ frames
                   ▲                               ▼
                   │                    ┌──────────────────────┐
                   │                    │  Inference service   │
                   └────────────────────┤  GPU pool / hosted   │
                                        │  vision API          │
        ┌──────────────────────┐        └──────────────────────┘
        │  S3 / object store   │◀── browser uploads directly, presigned
        └──────────────────────┘
```

The API process does three things: authenticate, validate, and read. It does not hold media, it
does not run models, and it does not block on anything slow. Every expensive operation is a job.

---

## 1. Video upload

### The problem with the obvious approach

Posting a 200 MB clip as `multipart/form-data` to an Express route means the file transits the API
process. That process now owns a long-lived connection, buffers or spools the whole payload, and
cannot be redeployed without killing the upload. Autoscaling makes it worse: the load balancer's
idle timeout, not the user's connection, decides whether the upload survives. This is what the
prototype does — `multer.memoryStorage()` in `apps/api/src/app.ts` — and it is correct only because
a prototype's uploads are small and its API has one replica.

### Production

**Direct-to-object-storage with presigned multipart uploads.**

1. Client calls `POST /api/v1/uploads` with the declared content type, byte size and a SHA-256 of
   the file. API validates against the allowlist and quota, creates an `Upload` row in `pending`,
   and returns an upload id plus presigned part URLs (S3 multipart, 8–16 MB parts).
2. Client `PUT`s parts straight to S3. Parts retry and resume individually, which is what makes a
   large upload survive a train tunnel. This is the single biggest reliability win for the mobile
   app.
3. Client calls `POST /api/v1/uploads/:id/complete` with the ETags. API completes the multipart
   upload, verifies the reported size and checksum against what S3 actually holds, and enqueues an
   ingest job.

**Validation still happens server-side, on the bytes.** The prototype already refuses to trust a
declared `Content-Type` and sniffs magic bytes instead (`apps/api/src/upload.ts`); in production
the same check runs in the ingest worker on the first 4 KB fetched by ranged `GET`, before anything
is handed to a decoder. A file that claims to be `video/mp4` and is not never reaches ffmpeg.

**Also required at this layer:** per-user rate and quota limits; a lifecycle rule expiring
incomplete multipart uploads after 24 h (they are billable and invisible otherwise); server-side
encryption at rest; and object keys that are unguessable and namespaced by owner.

That last point is not theoretical. This repository's audit log records a bug where the media id
was supplied by the caller and the API passed a constant placeholder for it, so every upload in the
system wrote to the same storage key. Storage keys are minted server-side, always.

### PHI

The moment real patient media is involved, the object store needs a BAA (S3 and GCS both offer
one), encryption with customer-managed keys, access logging, retention and deletion policies, and
signed URLs with short expiries for reads. Presigned upload URLs should be single-use and
minutes-long, not hours.

---

## 2. Video frame processing

### What the prototype does

Two implementations of one port, `FrameExtractor` (`packages/service/src/ports.ts`):

- **Browser** (`apps/web/src/adapters/decode.ts`): loads the clip into a detached `<video>`, seeks
  to N evenly spaced timestamps, draws each to a canvas, reads back RGBA. It waits on
  `requestVideoFrameCallback` after each seek, falling back to a double `requestAnimationFrame`;
  without that wait, `seeked` can fire before the new frame is composited and you get N copies of
  frame zero. Samples are taken strictly inside the clip because the first and last frames of a
  hand-held recording are the ones where the camera was still moving.
- **Server** (`apps/api/src/adapters/frameExtractors.ts`): `ffmpeg -vf fps=…,scale=512:-1`. Interval
  sampling rather than scene-change detection, because a clip of a single lesion has no scene
  changes — it has camera shake.

### Selection is the part that matters

Extracting frames is easy; choosing which ones to trust is the work. Every frame is scored for
sharpness (variance of the Laplacian) and exposure, and the aggregate descriptor is a
quality-weighted mean rather than a flat average (`aggregateFrameFeatures` in
`packages/core/src/features.ts`). Averaging blurred frames in flat drags every measurement toward
the blur. The sharpest, best-exposed frame is designated the **key frame**: it is what the viewport
displays, what the outline is drawn on, and what a clinician would see in a report.

Geometry is deliberately *not* averaged across frames — the lesion moves between them, so the key
frame's contour is used as-is. Averaging contours across a moving subject produces a shape that
exists in no frame.

### Production

- **ffmpeg in the ingest worker**, never in the API. Containerised with a pinned ffmpeg build.
- **Probe first** (`ffprobe`): reject absurd durations, resolutions, frame counts and codecs before
  decoding. ffmpeg is a large attack surface pointed at untrusted input; the worker runs with a
  read-only root filesystem, no network egress beyond the object store, a CPU and wall-clock
  ulimit, and a hard output-size cap.
- **Adaptive sampling**: a fixed grid for short clips; for longer ones, sample densely and then
  keep the top-K by sharpness, so a 60-second clip does not cost 60× a still.
- **Cache frames** back to object storage keyed by content hash, so a re-run of an analysis (a new
  model version, a re-scored case) does not re-decode the video.
- **Deduplicate** near-identical frames by perceptual hash before paying for inference on all of
  them.

---

## 3. Connecting the ML model

### The port

```ts
interface InferenceProvider {
  readonly id: string;
  readonly modelId: string;
  infer(input: { frames: RgbaImage[]; intake: Intake; media: MediaRef }): Promise<ProviderOutput>;
}
```

A provider **reports evidence**; it does not decide the answer. Ranking, calibration and the
abstention decision happen in one place afterwards (`packages/core/src/fusion.ts`), so a new model
cannot quietly change how confidence is computed or when the system declines to answer.

Three implementations exist today:

| Provider | Where | What it is |
|---|---|---|
| `CvHeuristicProvider` | both | Classical CV over the pixels: Otsu segmentation on Lab colour distance, Moore boundary tracing, k-means colour clustering, ABCD-derived descriptors. No weights, no network. |
| `OnDeviceClipProvider` | browser | MobileCLIP S0 zero-shot via ONNX Runtime Web, 21.8 MiB fp16 vision encoder, text embeddings precomputed at build time. |
| `VisionLlmProvider` | server | OpenAI-compatible multimodal endpoint, structured JSON output, ordered model fallback, schema validation, catalogue mapping. |

### Replacing the stand-in with a real model

None of the three is a diagnostic model, and the repository says so everywhere it can. The
production path:

1. **Dataset.** ISIC Archive and HAM10000 for dermoscopy, or the client's own labelled corpus.
   Split by *patient*, not by image, or the same lesion photographed twice lands in both train and
   test and the reported accuracy is fiction.
2. **Model.** An EfficientNet or ConvNeXt backbone fine-tuned for multi-label classification is the
   sensible default; segmentation via U-Net if lesion masks are wanted from the model rather than
   from Otsu.
3. **Serving.** Export to ONNX or TorchScript, serve behind Triton or TorchServe on a GPU pool with
   dynamic batching. Frames from many jobs batch together; latency per frame drops by an order of
   magnitude against one-at-a-time inference.
4. **The provider adapter does not change shape.** It posts frames, gets a posterior, maps it to
   catalogue ids, returns `ProviderOutput`. Everything above it — fusion, calibration, abstention,
   the evidence trace, the UI — is untouched.

### Calibration is not optional

A softmax over a fine-tuned classifier is overconfident, and in this domain overconfidence is the
failure mode that reaches a patient. Fit temperature scaling on a held-out validation set, publish
a reliability diagram, and set the abstention threshold from the operating point the clinical
stakeholder chooses — sensitivity for malignant classes is worth far more than overall accuracy.

The prototype ships a `MAX_REPORTED_CONFIDENCE` ceiling precisely because it has no validation set
and therefore no right to report a high number. That ceiling is what a fitted reliability curve
replaces. Until it is replaced, it stays.

### Model governance

Version every model and record `modelId` on every stored result (the schema already does this).
Without it you cannot answer "which model produced this assessment", which is the first question
asked after any incident. Shadow-deploy a new version against live traffic and compare before
switching. Keep the heuristic provider as the fallback path: an inference service outage should
degrade the answer, not remove it. `VisionLlmProvider` already does exactly this, and it is tested.

---

## 4. Long-running AI processing

### The contract

Asynchronous from the first line, because it is the only contract that survives real model latency:

```
POST /api/v1/analyses        → 202 { analysisId, status: "queued", channel }
GET  /api/v1/analyses/:id    → 200 { status, stage, progress, result? }
WS   analysis:{id}           → stage events, then the terminal result
```

Nothing blocks an HTTP request on a model. A 30-second inference behind a synchronous endpoint is a
30-second connection, a load-balancer timeout waiting to happen, and an API process that cannot be
deployed.

### The queue

`JobQueue` is a port. The prototype implements it in-process (`ImmediateJobQueue`); production is
**BullMQ on Redis** with workers in separate containers. What changes: the constructor call in
`app.ts`. What does not change: the pipeline, the stage machine, the event contract, the UI.

Queue design that matters at scale:

- **Separate queues per stage** — ingest (CPU, ffmpeg) and inference (GPU) scale on different
  signals and should not share a worker pool.
- **Idempotency.** Submissions carry an `Idempotency-Key`; a replay returns the original analysis
  rather than starting a second one. Already implemented and tested — mobile clients retry on flaky
  networks, and without it a bad connection silently doubles the inference bill.
- **Bounded retries with exponential backoff and jitter**, and a dead-letter queue. Distinguish
  retryable (429, 503, timeout) from terminal (malformed media, unsupported codec); retrying a
  corrupt file forever is a way to spend money on nothing.
- **Visibility timeouts and heartbeats** so a worker killed mid-job releases it instead of
  stranding it in `running` forever.
- **Cancellation.** The pipeline checks a cancellation signal at every stage boundary, so a
  cancelled job stops rather than finishing invisibly. Tested.
- **Priority.** Anything the triage layer flags as potentially urgent jumps the queue.
- **Backpressure.** When the inference pool saturates, `POST /analyses` returns 202 with a queue
  position rather than silently accumulating a two-hour backlog.

### Failure is a state, not an exception

Every stage is wrapped so a throw becomes a terminal `failed` analysis with a message, never a
promise that does not settle. A UI spinning forever on a job that died is the worst outcome
available, and it is the behaviour with a dedicated test.

---

## 5. Returning results

### Three channels, deliberately

1. **WebSocket (Socket.IO)** — the live path. One room per analysis, authenticated at the
   handshake; without that, knowing an id would be enough to subscribe to someone else's
   assessment. In production, the Socket.IO Redis adapter fans events across API replicas, since
   the worker that finishes a job is not connected to the client that started it.
2. **Polling `GET`** — the fallback and the source of truth. The web client subscribes *and* polls;
   sockets drop, corporate proxies eat upgrades, and phones suspend. A client that only listens is
   a client that hangs. Reconnection re-syncs from `GET` rather than replaying events.
3. **Push notification** — for when the app is backgrounded. `expo-notifications` against APNs and
   FCM, triggered by the worker on terminal state, carrying only the analysis id. Never the
   result: a lock-screen preview containing a possible diagnosis is a disclosure to whoever is
   holding the phone.

### Why not SSE

Server-sent events would be a reasonable fit for one-directional stage streaming and are cheaper
than a socket. Socket.IO is chosen because the client asked for it, because the same connection
carries the mobile app's other real-time needs, and because its reconnection and fallback
behaviour is a solved problem rather than one to reimplement.

### What is actually sent

The terminal event carries the full result. The prototype's result payload is deliberately rich —
a ranked differential, per-candidate evidence with signed contributions, the measured features, the
quality report, the provider and model id, and the compute time. That richness is the point: a
percentage on its own cannot be acted on or argued with, and a differential that cannot be argued
with will be either trusted blindly or ignored. Both are bad.

Contours are decimated to at most 240 points before serialisation. The raw trace is several
thousand points per frame and the drawn outline stops improving long before that.

---

## What the deployed demo does differently, and why

The demo is on GitHub Pages, which serves static files and cannot run Express or MongoDB. Vercel,
Render, Fly and Cloudflare all require an interactive account login that was not available in the
unattended environment this was built in.

Rather than ship no backend or fake one with canned responses, the API is written once as
framework-agnostic use-cases over ports, and bound to two adapter sets. The browser build runs
**the same handlers, the same Zod schemas, the same pipeline and the same event contract** against
a Map instead of MongoDB, an in-memory blob store instead of GridFS, and a canvas instead of
ffmpeg. The numbers on screen are computed from the uploaded pixels; nothing is stored or replayed.

The API inspector panel in the demo exists so this is checkable rather than merely asserted: it
shows the actual request and response envelopes, which are the same ones `apps/api` produces.

To run the real thing:

```bash
npm run standalone -w @caliper/api   # Express + Socket.IO + ephemeral MongoDB, no Docker needed
VITE_API_URL=http://localhost:4000 npm run dev -w @caliper/web
```

Setting `VITE_API_URL` swaps `InBrowserTransport` for `HttpTransport`. No component above the
transport changes.

---

## Cost and scale, briefly

At 10k analyses/day with a 3-frame average:

- **Inference** dominates. A batched GPU pool on spot instances is roughly an order of magnitude
  cheaper per frame than a per-call hosted vision API, and crosses over somewhere around
  1–2k images/day. Below that, a hosted API is the right call and the provider port makes the
  switch a config change.
- **Storage** is the second line. Original media is large and rarely re-read: lifecycle it to
  infrequent-access after 30 days and cold storage after 90, keeping only the extracted key frames
  hot. Retention is a clinical and legal decision, not an engineering one.
- **The quality gate pays for itself.** Rejecting an unusable photograph before inference costs
  microseconds of CPU and saves a GPU call plus, more importantly, a wrong answer.
