# Caliper

**Assistive triage console** — symptom intake, medical image and video capture, and a
model-assisted assessment with an auditable evidence trace.

**Live demo → https://tammam-bt.github.io/caliper-triage/**

> **Not a medical device.** This is an engineering prototype built as a technical exercise. It is
> not clinically validated, has not been trained on a labelled dataset, and must not be used to
> make a care decision.

---

## What it does

1. Enter symptoms as free text or chips, and optionally select a suspected condition.
2. Drop, paste, capture or pick a photograph or a short clip — or load one of four bundled clinical
   samples.
3. The media is sent to the API, which queues an analysis and returns `202` immediately.
4. A pipeline runs: quality gate → segmentation → feature extraction → inference → evidence fusion
   → calibration. Stages stream back live.
5. The readout gives a ranked differential with a calibrated confidence, a triage acuity band, and
   a signed evidence trace explaining every contribution that moved the ranking.

Try the **Pearly nodule** sample to see the system decline to answer: when the top two candidates
tie, it abstains rather than guessing — and still escalates the acuity, because refusing to answer
must not also refuse to escalate.

## What is real, and what is prototype

Being precise about this matters more than making the demo sound impressive.

**Real:**

- The computer vision. Otsu segmentation on Lab colour distance from the patient's own surrounding
  skin, Moore boundary tracing, k-means colour clustering with perceptual merging, and ABCD-derived
  descriptors. The contour drawn over your photograph is the actual segmentation polygon; the
  corner metadata are the actual measured values.
- The neural inference. Opt in and the browser downloads MobileCLIP S0 (21.8 MiB, fp16) and runs
  real zero-shot classification locally via ONNX Runtime.
- The backend. `apps/api` is a working Express + MongoDB + Socket.IO service with JWT auth and
  roles, magic-byte upload validation, GridFS media storage, an ffmpeg frame extractor and an
  OpenAI-compatible vision-LLM provider. 39 tests against real Mongoose and real GridFS.
- The calibration. Temperature scaling, an abstention rule, and a hard confidence ceiling.

**Prototype:**

- **The condition coefficients are illustrative, not fitted.** They are hand-written to make the
  reasoning legible and testable. They carry no clinical validity. In production this table is
  replaced by a model trained on a labelled dataset and the table becomes just the taxonomy.
- **Zero-shot CLIP is not a dermatology classifier.** It is a general-purpose image model standing
  in for a fine-tuned diagnostic network — real inference on real pixels, clearly labelled as what
  it is.
- **Confidence is capped at 85%** because nothing here has been validated. That ceiling is what a
  real reliability curve would replace.

## Why the demo runs its API in the browser

The only deployment credential available when this was built was an authenticated GitHub CLI, so
the target is GitHub Pages — which serves static files and cannot run Express or MongoDB.

Rather than ship no backend or fake one with canned responses, the API is written once as
framework-agnostic use-cases over ports, and bound to two adapter sets:

```
                @caliper/service — use-cases, pipeline, ports
                        │                        │
        apps/api  ──────┘                        └────── apps/web
        Mongo · GridFS · ffmpeg                  Map · Blob · canvas
        Socket.IO · OpenRouter                   EventTarget · on-device CLIP
```

The deployed page runs **the same handlers, the same Zod schemas, the same pipeline and the same
event contract** against in-browser adapters. Nothing is hardcoded — the numbers come from your
pixels. The **API panel** in the top bar shows the actual request and response envelopes, so this
is checkable rather than merely asserted.

To run it against the real server instead, set `VITE_API_URL`. Nothing above the transport changes.

## Running it

```bash
npm install

# Everything: 144 tests across four packages
npm test

# The console, on its own (in-browser API)
npm run dev:web

# The real backend — Express + Socket.IO + an ephemeral MongoDB, no Docker required
npm run standalone -w @caliper/api

# The console against that backend
VITE_API_URL=http://localhost:4000 npm run dev -w @caliper/web

# Or the full stack in containers (includes ffmpeg for video)
JWT_SECRET=$(openssl rand -hex 32) docker compose up
```

Useful scripts:

```bash
# Run the pipeline over any local image and print the measurements
npx tsx apps/api/scripts/assess.ts path/to/photo.jpg "itchy and changing"

# Regenerate the CLIP label embeddings (only needed if the catalogue changes)
npm run embeddings -w @caliper/web

# End-to-end, against the production build
npm run e2e -w @caliper/web
```

## Layout

```
packages/core/      domain: Zod schemas, condition catalogue, CV, symptom scoring, fusion
packages/service/   application: ports, use-cases, pipeline orchestrator, memory adapters
apps/api/           Express + Mongoose + Socket.IO + multer + inference providers
apps/web/           React 19 + Vite — the console
docs/               PROJECT.md · ROADMAP.md · ARCHITECTURE.md · AUDIT.md
```

## Documents

- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — the production write-up: video upload, frame
  processing, model connection, long-running jobs, and result delivery.
- **[`docs/PROJECT.md`](docs/PROJECT.md)** — the source of truth: scope, architecture, design
  system, and the honesty rules the code is held to.
- **[`docs/AUDIT.md`](docs/AUDIT.md)** — what was verified and how, including every defect found
  during development and what was *not* verified.

`docs/AUDIT.md` is the one worth reading if you want to know whether this was tested or merely
written. It records, among others, a media-id collision that made every upload overwrite the same
GridFS key, and a cue calibration anchored to synthetic fixtures that made the differential stop
depending on the photograph — with the whole suite green, because the tests used the same fixtures.

## Licence and credits

Code: MIT. Bundled sample photographs are from Wikimedia Commons under public domain, CC BY 3.0 and
CC BY-SA 3.0/4.0 — see [`apps/web/public/samples/ATTRIBUTION.md`](apps/web/public/samples/ATTRIBUTION.md).
