# Caliper — Project Description (Source of Truth)

> **Status:** authoritative. If implementation and this document disagree, this document wins
> unless it is explicitly amended. Amendments go in the Changelog at the bottom.

---

## 1. Why this exists

An Upwork client is hiring a **MERN + React Native** developer for an AI-powered healthcare
application. Shortlisted developers complete a small **paid technical task**. This repository is
that task, plus the evidence that the developer understands the production system behind it.

### 1.1 What the client literally asked for

Build a prototype where a user can:

1. Enter symptoms, and optionally select a suspected disease/condition.
2. Upload a medical image or video.
3. Send the media to a backend API.
4. Connect the backend to an AI/ML model **or a mock ML API** for disease detection/assessment.
5. See the AI/ML result and a confidence score.

Plus a written explanation of how, **in production**, we would handle: video uploads, video frame
processing, ML model connection, long-running AI processing, and returning results to the user.

### 1.2 What the client is actually evaluating

Stated in the job post: *"technical approach, code quality, AI/ML integration, and understanding of
the complete workflow."* So the deliverable is not one screen. It is:

- A prototype that visibly works, end to end, on a link they can click.
- A repository whose structure argues that the author has built production systems before.
- A written architecture note that answers the five production questions concretely.

### 1.3 Success criteria

| # | Criterion | How it is verified |
|---|---|---|
| S1 | All five task steps work on the deployed URL, from a cold browser, with no setup | Manual + Playwright run against the live URL |
| S2 | Assessment output genuinely depends on the uploaded media — different image, different numbers | Automated: two fixtures must produce different feature vectors and rankings |
| S3 | A real Express + MongoDB + Socket.IO backend exists in the repo and passes integration tests | `npm test -w @caliper/api` green against `mongodb-memory-server` |
| S4 | The web UI does not read as templated/AI-generated | Design rubric in §7.6, checked against the tell-list in §7.1 |
| S5 | The production architecture note answers all five questions with specifics, not platitudes | `docs/ARCHITECTURE.md` review checklist |
| S6 | Nothing in the repo or the deployed bundle claims a capability it does not have | Honesty audit, §9 |

### 1.4 Explicit non-goals

- Not a medical device. Not diagnostic. Not clinically validated. The UI says so, permanently.
- No real patient data, no PHI, no HIPAA compliance claims.
- Not the client's full 2-week MVP. This is the evaluation prototype.
- No paid infrastructure. Every runtime dependency is free-tier or self-hosted.

---

## 2. The hard constraint that shapes the architecture

The deployment must be reachable by the client at an unknown future time, from a link, with the
developer's machine off. The only deployment credential available in this environment is an
authenticated GitHub CLI (`gh`, scopes `repo` + `workflow`). Vercel, Netlify, Render, Fly and
Cloudflare all require an interactive browser login that cannot be performed unattended.

**Therefore: GitHub Pages. Which is static hosting. Which cannot run Express or MongoDB.**

The naive responses to this are both bad:

- *Ship only a static mock.* Fails S3 — the client asked specifically for "send the media to a
  backend API", and a submission with no server reads as dodging the requirement.
- *Fake a server with hardcoded responses.* Fails S2 and S6.

### 2.1 The resolution: ports and adapters

The API is written **once**, as framework-agnostic use-case handlers over a set of ports. Two
adapter sets bind those handlers to two runtimes:

```
                    ┌───────────────────────────────────┐
                    │   @caliper/service                │
                    │   use-cases + pipeline orchestrator│
                    │                                   │
                    │   ports:                          │
                    │     AnalysisRepository            │
                    │     MediaStore                    │
                    │     InferenceProvider             │
                    │     FrameExtractor                │
                    │     EventBus  Clock  IdGen        │
                    └───────┬───────────────────┬───────┘
                            │                   │
         ┌──────────────────┘                   └──────────────────┐
         │                                                          │
┌────────▼─────────────────────┐              ┌────────────────────▼──────────┐
│ apps/api  (Node, real MERN)  │              │ apps/web  (browser, demo mode)│
│  Mongo repo (Mongoose)       │              │  in-memory repo               │
│  GridFS media store          │              │  Blob/IndexedDB media store   │
│  OpenRouter vision provider  │              │  on-device CLIP provider      │
│  ffmpeg frame extractor      │              │  <video>+canvas frame extractor│
│  Socket.IO event bus         │              │  EventTarget event bus        │
│  Express routes + multer     │              │  in-process fetch shim        │
└──────────────────────────────┘              └───────────────────────────────┘
```

The deployed demo therefore runs **the real handler code, the real validation schemas, the real
pipeline orchestrator, and real machine learning** — against in-browser adapters. Nothing is
hardcoded. The same request/response envelopes cross both boundaries, and the UI exposes them in an
inspector panel so a reviewer can read the actual contract.

This is stated plainly in the README, in the UI, and in the proposal. It is a legitimate
architectural answer to a hosting constraint, and it is a stronger code-quality signal than a
deployed CRUD server would have been.

---

## 3. Product

**Name:** Caliper. An instrument for measuring a lesion. Concrete, non-generic, and literally what
the tool does.

**One-line:** Assistive triage console — symptom intake, media capture, model-assisted assessment.

**Primary user in the fiction:** a triage nurse or general practitioner photographing a skin lesion
or wound and wanting a ranked differential with an urgency band before deciding on referral.

**Real user in practice:** the hiring client, evaluating engineering.

### 3.1 The case flow

```
  INTAKE                MEDIA                 PIPELINE                    READOUT
  symptoms text    →    image or video   →    received                →   acuity band
  symptom chips         drag/drop/camera      preprocess (quality gate)    ranked differential
  suspected dx (opt)    frame sampling        features (CV)                per-item confidence
  duration, evolving                          inference (model)            evidence: why
                                              fusion (image + symptoms)    disclaimer
                                              calibration (abstain?)
```

### 3.2 Condition catalogue

Eight conditions plus an abstention outcome. Dermatology/wound focused because that domain is
photographable, which is what the task requires.

`melanoma`, `basal_cell_carcinoma`, `squamous_cell_carcinoma`, `benign_nevus`,
`seborrheic_keratosis`, `eczema_dermatitis`, `psoriasis`, `cellulitis`, plus
`insufficient_evidence`.

Each carries: display name, ICD-10 hint, baseline prevalence prior, urgency weight, the CV feature
directions that support it, and the symptom tokens that support it.

### 3.3 Acuity bands

Borrowed from real triage vocabulary rather than invented:

| Band | Meaning | Colour token |
|---|---|---|
| `urgent` | Same-day clinical review advised | `--acuity-urgent` oxblood |
| `prompt` | Review within two weeks | `--acuity-prompt` ochre |
| `routine` | Routine follow-up | `--acuity-routine` leaf |
| `indeterminate` | Model abstained; recapture or escalate to human | `--rule` grey |

---

## 4. The machine learning, precisely

Three inference providers implement one `InferenceProvider` port. All three return the same
`InferenceResult` shape. This is the single most important honesty boundary in the project, so each
is described exactly.

### 4.1 `CvHeuristicProvider` — deterministic, always available

Real computer vision over the actual pixels. Pure TypeScript, no model weights, runs identically in
Node and the browser. Operates on decoded RGBA.

- **Quality gate** — variance of the Laplacian (blur), mean luminance and clipping (exposure),
  minimum resolution. Below threshold the pipeline returns `insufficient_evidence` with the measured
  number and a corrective instruction. This exists because a production triage system that silently
  assesses a blurry photo is dangerous.
- **Segmentation** — greyscale, Otsu threshold, largest connected component, contour trace. Yields
  the lesion mask and the outline polygon the UI draws.
- **Features**, the classical ABCD-derived set:
  - `asymmetry` — normalised second-moment difference across the mask's principal axes.
  - `borderIrregularity` — perimeter² / (4π·area), i.e. reciprocal circularity.
  - `colourHeterogeneity` — number of distinct clusters from k-means (k=6) over Lab-converted pixels
    inside the mask, weighted by cluster mass.
  - `diameterPx` and `diameterMm` — major-axis length; mm only when a scale reference is supplied.
  - `textureEntropy` — Shannon entropy of the intra-mask luminance histogram.
  - `blurScore`, `exposureScore` — carried through from the quality gate.
- **Scoring** — each feature is mapped through a documented monotone response curve to a per-
  condition log-odds contribution, summed with the prevalence prior, softmaxed.

Every constant in this provider is named, commented with its provenance, and unit-tested. It is a
*heuristic*, and the UI labels it as one. It is not presented as a trained diagnostic model.

### 4.2 `OnDeviceClipProvider` — real neural inference, in the browser

`Xenova/mobileclip_s0`, zero-shot image classification via `@huggingface/transformers`.

- Only the **vision encoder** ships to the browser: `vision_model_fp16.onnx`, **21.8 MiB** (int8 variants are numerically broken — see `AUDIT.md` Gate 0).
- The **text encoder never ships**. Candidate condition prompts are embedded once at build time by a
  Node script and committed as a small JSON of L2-normalised 512-d vectors. This is why the download is 22 MB rather than 155 MB.
- At run time: encode the image, cosine-similarity against the frozen label embeddings, temperature-
  scaled softmax.
- WebGPU when available, WASM fallback. Loaded **on user opt-in**, behind an explicit control that
  states the download size — never on page load, because the first impression must not be a progress
  bar.
- Labelled in the UI as *"CLIP ViT zero-shot — a general-purpose model standing in for a fine-tuned
  diagnostic network."* Because that is what it is. Zero-shot CLIP is not a dermatology classifier;
  it is real inference on real pixels producing genuinely image-dependent scores, which is the honest
  claim and the one worth making.

### 4.3 `VisionLlmProvider` — real multimodal LLM, server side

OpenAI-compatible chat completions with an image part, against OpenRouter (free vision models
verified available: `google/gemma-4-31b-it:free`, `nvidia/nemotron-nano-12b-v2-vl:free`) or any
compatible endpoint. Structured JSON output, schema-validated on return, with retry and a fallback
to `CvHeuristicProvider` on failure or timeout.

Server-only. **The API key is never shipped to a browser bundle** — which is itself part of why the
deployed demo uses the on-device provider.

### 4.4 Fusion and calibration

Image evidence and symptom evidence are combined in log-odds space with a tunable weight, then:

- **Temperature scaling** on the final logits so the reported confidence is not the raw softmax peak.
- **Abstention rule** — if top-1 margin over top-2 is below threshold, or the quality gate flagged
  the media, the result is `insufficient_evidence` with `indeterminate` acuity. A system that always
  answers is worse than one that knows when not to.
- **Evidence trace** — every contribution that moved the ranking is retained and rendered, so the
  readout can say *"border irregularity 2.41 (high) → +1.2 melanoma"* rather than a bare percentage.

---

## 5. Video

Required by the task, and the production question the client asks about most explicitly.

**In the prototype (browser):** the uploaded video is loaded into a detached `<video>`, seeked to N
evenly spaced timestamps, each frame drawn to a canvas and read back as RGBA. Frames run through the
same feature extractor as a still. Per-frame results are aggregated by quality-weighted mean, with
the best-quality frame designated the key frame and shown in the viewport. Sharpness-based frame
selection discards motion-blurred samples before inference. This is genuine frame processing, not a
placeholder.

**In `apps/api` (Node):** an `FfmpegFrameExtractor` implementing the same port, using scene-change
detection plus fixed-interval sampling. Requires an `ffmpeg` binary; its tests skip with a printed
notice when one is absent, rather than pretending to pass. `ffmpeg` is not installed in the
development environment used to build this, and that fact is recorded in `docs/AUDIT.md` rather than
hidden.

**In production:** described fully in `docs/ARCHITECTURE.md` — direct-to-S3 multipart upload with
presigned URLs, an ingest worker doing transcode + frame extraction, per-frame fan-out to the
inference service, aggregation, and result delivery. The client asked; the answer is specific.

---

## 6. Long-running processing and result delivery

The contract is asynchronous everywhere, because that is the only contract that survives a real
model latency.

```
POST /api/v1/analyses          → 202 Accepted  { analysisId, status: "queued" }
GET  /api/v1/analyses/:id      → 200           { status, stage, progress, result? }
WS   analysis:{id}             → stage events, then terminal result
```

- `apps/api` implements this with an in-process job queue behind a `JobQueue` port, Socket.IO rooms
  keyed by analysis id, and idempotency keys on submission. The port exists so the production answer
  (BullMQ on Redis, separate worker dynos) is a swap, not a rewrite — and `docs/ARCHITECTURE.md`
  shows that swap.
- `apps/web` in demo mode implements the identical contract over an `EventTarget` bus with realistic
  staged latency, so the UI code path is the same one that would run against Socket.IO.
- The UI never blocks. Stages stream into the pipeline rail; the result lands when it lands; a
  reconnect re-syncs from `GET` rather than losing the job.

---

## 7. Design

The client's brief to the developer was explicit: the interface must not look AI-generated.

### 7.1 Tells to avoid, from research

Indigo/violet-to-blue gradients (the single loudest tell). Inter as the default typeface. A row of
three rounded cards with soft shadows and thin-line icons. Dark hero with a gradient "Get Started"
button. Weightless headline copy of the "Build faster. Ship smarter." form. Uniform `rounded-2xl`
and `shadow-lg`. Emoji bullets. Centred everything. Also avoided, because they are the current
*second* wave of defaults: warm cream `#F4F1EA` + high-contrast serif + terracotta accent;
near-black + single acid-green accent; broadsheet hairline-rule pastiche.

### 7.2 Direction

The subject supplies the vocabulary. Clinical photography has a real visual world: a dark viewport,
corner-anchored monospace metadata, scale bars, adhesive paper rulers, graticules, Fitzpatrick
swatches, and surgical drape green — a colour that exists specifically because it is the complement
of blood red and reduces afterimages. That is a colour with a reason, which is the opposite of a
colour picked because it is the statistical centre of "nice modern UI".

The app is built as an **instrument**, not a landing page: a single full-height console, no
marketing scroll.

### 7.3 Colour

| Token | Hex | Role |
|---|---|---|
| `--ink` | `#12181A` | Near-black, green-cast. Text, viewport ground |
| `--drape` | `#234A40` | Surgical green. Structural chrome, primary actions |
| `--drape-lift` | `#3E7A69` | Interactive/hover state |
| `--bone` | `#E8E9E4` | Pale mineral neutral, page ground. Cool, deliberately not warm cream |
| `--paper` | `#F7F7F4` | Panel surface |
| `--rule` | `#C9CCC4` | Hairlines |
| `--reticle` | `#6FD3D8` | Pale cyan. **Viewport overlays only.** The one loud colour, confined to one place |
| `--acuity-urgent` | `#9E2B25` | Oxblood |
| `--acuity-prompt` | `#B8722A` | Ochre |
| `--acuity-routine` | `#4E7A3E` | Leaf |

No gradients anywhere except a single flat-to-transparent scrim over the viewport metadata.

### 7.4 Typography

Three faces, and the role split **encodes the information architecture**:

- **Faustina** (serif) — the assessment *report*: findings, narrative, headings. A clinical document
  is typeset; this is the part of the app that is a document.
- **Public Sans** (sans) — console *chrome*: field labels, controls, navigation. Uppercase, widely
  tracked, small, like a printed requisition form. Institutional lineage, and not a face any default
  reaches for.
- **IBM Plex Mono** — *measurements*: every number the machine produced. Instrument readout.

If a number was computed, it is mono. If a human wrote it, it is serif. If it labels a control, it is
sans. The reader learns this in about four seconds and it never breaks.

### 7.5 Layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│ CALIPER · assistive triage console          demo case ▾    v0.1  ● in-browser│
├──────────────────┬──────────────────────────────┬──────────────────────────┤
│ 1  INTAKE        │      SPECIMEN VIEWPORT       │  2  ASSESSMENT           │
│                  │  ┌────────────────────────┐  │                          │
│ symptoms         │  │▛                      ▜│  │  empty:                  │
│ [chips + text]   │  │   uploaded media       │  │  "No case yet."          │
│                  │  │   ╭─ contour ─╮        │  │                          │
│ suspected dx ▾   │  │   ╰───────────╯        │  │  after run:              │
│                  │  │▙ ├─── 12.4 mm ───┤   ▟│  │  ACUITY BAND             │
│ duration         │  │  1024×768  σ²L 87.2    │  │  ranked differential     │
│ [ ] evolving     │  └────────────────────────┘  │  confidence bars         │
│                  │   ▤▤▤▤▤▤ frame strip (video) │  evidence: why           │
│ [Run assessment] │                              │  disclaimer              │
├──────────────────┴──────────────────────────────┴──────────────────────────┤
│ received › preprocess › features › inference › fusion › complete           │
└────────────────────────────────────────────────────────────────────────────┘
```

Mobile stacks intake → viewport → assessment; the pipeline rail becomes a sticky bottom strip.

### 7.6 Signature element and rubric

**Signature:** the specimen viewport. Dark, against pale chrome. The segmentation contour draws
itself onto the user's actual photograph as the features stage completes; the scale bar, corner
metadata and colour readout are the real computed values. Empty state shows a graticule awaiting
media. The memorable moment of the app is watching the machine measure *your* image.

Structural devices are earned: the intake steps and the pipeline rail are numbered because they are
genuinely ordered sequences.

Motion, total: contour draw-on, pipeline stage advance, confidence bars growing once.
`prefers-reduced-motion` disables all three. Nothing floats, pulses, or parallaxes.

**Rubric for S4** — the build fails if any is true: a violet or indigo hue appears; Inter is loaded;
three equal cards sit in a row as a feature grid; a headline could be pasted onto a different
product unchanged; more than one accent colour competes; an icon appears where a word would be
clearer.

### 7.7 Copy

Clinical register, active voice, specific. "Run assessment", not "Analyze with AI". Errors state the
measurement and the fix: *"Too blurry to assess — Laplacian variance 12.4, threshold 40. Retake in
brighter light, holding steady."* The disclaimer is permanent and unmissable, because for this
subject that is both correct and characterful.

---

## 8. Repository shape

```
caliper/
├─ packages/
│  ├─ core/            domain: types, Zod schemas, catalogue, CV, scoring, fusion   [vitest]
│  └─ service/         use-cases, ports, pipeline orchestrator, memory adapters      [vitest]
├─ apps/
│  ├─ api/             Express + Mongoose + Socket.IO + multer + providers  [vitest + supertest]
│  ├─ web/             React 19 + Vite + TS — the console                   [vitest + playwright]
│  └─ mobile/          Expo React Native — same core, same client            [stretch]
├─ docs/
│  ├─ PROJECT.md       this file
│  ├─ ROADMAP.md       phased plan and audit gates
│  ├─ ARCHITECTURE.md  the production write-up the client asked for
│  └─ AUDIT.md         what was verified, how, and what was not
├─ PROPOSAL.md         the Upwork proposal
└─ README.md
```

TypeScript strict everywhere. npm workspaces. Zod schemas defined once in `core` and imported by
every layer, so the API contract cannot drift between server, web and mobile.

---

## 9. Honesty rules

Binding on every file in the repository and every sentence of the proposal.

1. Nothing is described as a trained diagnostic model unless it is one. Nothing here is one.
2. The deployed demo states, in the interface, that it runs the API handlers in-browser.
3. Confidence numbers come from the calibration path. No number is invented for display.
4. Anything not exercised locally (`ffmpeg`, MongoDB Atlas, real device push) is listed as such in
   `docs/AUDIT.md`.
5. No secret is committed, and no API key reaches a browser bundle.
6. The medical disclaimer is permanent in the UI, not a dismissible modal.

---

## Changelog

- **2026-08-19** — Initial version. Architecture fixed to ports-and-adapters after establishing that
  GitHub Pages is the only unattended deployment target available.
