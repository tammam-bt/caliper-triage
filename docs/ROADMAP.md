# Caliper — Roadmap and Audit Gates

Companion to `docs/PROJECT.md`. That document says *what* and *why*; this one says *in what order*
and *how we know it worked*.

**Working rule:** no phase is marked done until its audit gate passes with pasted evidence recorded
in `docs/AUDIT.md`. A gate that fails re-opens the phase. Phases do not overlap.

**Budget discipline:** Phase 6 (React Native) is a stretch. If Phase 5 completes and the remaining
budget looks tight, Phase 6 is cut, and the proposal cites RN experience without claiming an app in
this repo. Cutting it is a decision to record, not a failure to hide.

---

## Phase 0 — De-risking spike

The two assumptions that would be expensive to discover as false late.

| # | Task |
|---|---|
| 0.1 | Run `Xenova/mobileclip_s0` vision encoder under `@huggingface/transformers` in Node. Confirm it loads, accepts an image, and returns a 512-d embedding |
| 0.2 | Run the matching text encoder once in Node over the condition prompt set. Confirm embedding dim matches and cosine similarities are sane (a photo of a dog scores higher on "a photo of a dog" than on "a photo of a skin lesion") |
| 0.3 | Confirm the quantized vision ONNX is fetchable from the HF CDN with CORS headers permitting a browser on a `github.io` origin |
| 0.4 | Make one real OpenRouter vision call with an image and a structured-output prompt; confirm parseable JSON comes back |

**Gate 0.** All four pass, or the plan changes here rather than in Phase 4. If 0.1–0.3 fail, the
on-device provider is dropped and `CvHeuristicProvider` becomes the sole demo provider — the project
still satisfies every task requirement, so this is a survivable outcome. If 0.4 fails, `VisionLlmProvider`
ships written-and-unit-tested but marked unverified in `AUDIT.md`.

*Spike code is throwaway and lives in `/scratch`, not the repo.*

---

## Phase 1 — Monorepo skeleton and `@caliper/core`

| # | Task |
|---|---|
| 1.1 | npm workspaces, TS strict, shared tsconfig base, vitest, eslint. `.gitignore` before the first commit |
| 1.2 | `core/types.ts` + `core/schemas.ts` — Zod schemas for `Case`, `MediaRef`, `Analysis`, `InferenceResult`, `EvidenceItem`, `PipelineEvent`. Types derived from schemas, never duplicated |
| 1.3 | `core/catalogue.ts` — the nine conditions with priors, urgency weights, feature directions, symptom tokens |
| 1.4 | `core/image/` — greyscale, Otsu, connected components, contour trace, Laplacian variance, exposure, Lab conversion, k-means |
| 1.5 | `core/features.ts` — `extractFeatures(rgba, w, h)` producing the ABCD-derived vector plus mask and contour |
| 1.6 | `core/symptoms.ts` — tokenizer, negation handling ("no bleeding" must not score as bleeding), lexicon → per-condition log-odds |
| 1.7 | `core/fusion.ts` — log-odds combination, temperature scaling, abstention rule, evidence trace |
| 1.8 | Unit tests throughout, with synthetic fixtures: a solid circle must score near-zero asymmetry and near-1.0 circularity; a blurred image must fail the quality gate; a two-tone blob must score higher colour heterogeneity than a flat one |

**Gate 1.** `npm test -w @caliper/core` green. Coverage of `features.ts`, `symptoms.ts`, `fusion.ts`
above 85%. Determinism check: the same input twice yields byte-identical output. Discrimination
check: two visibly different fixtures yield different top-1 conditions.

---

## Phase 2 — `@caliper/service`

| # | Task |
|---|---|
| 2.1 | Ports: `AnalysisRepository`, `MediaStore`, `InferenceProvider`, `FrameExtractor`, `JobQueue`, `EventBus`, `Clock`, `IdGen` |
| 2.2 | Use-cases: `submitAnalysis`, `getAnalysis`, `listAnalyses`, `cancelAnalysis`. Input validated by core schemas at the boundary |
| 2.3 | `pipeline.ts` — the stage machine: received → preprocess → features → inference → fusion → complete, emitting a `PipelineEvent` per transition, with per-stage error capture and a terminal failed state |
| 2.4 | `providers/cvHeuristic.ts` implementing `InferenceProvider` over core |
| 2.5 | Memory adapters: in-memory repo, in-memory media store, deterministic clock and id generator for tests |
| 2.6 | Tests: full pipeline over a fixture with fake clock; event ordering asserted exactly; a provider that throws produces a failed analysis, not a hang; cancellation stops emission |

**Gate 2.** `npm test -w @caliper/service` green. The event sequence for a happy path is asserted
literally. An injected provider failure is proven not to hang the pipeline.

---

## Phase 3 — `apps/api` (the real MERN backend)

| # | Task |
|---|---|
| 3.1 | Express 5, helmet, cors, pino, centralised error handler, Zod request validation middleware |
| 3.2 | Mongoose models + `MongoAnalysisRepository`; GridFS `MediaStore` |
| 3.3 | Auth: JWT access/refresh, bcrypt, roles `patient` / `clinician` / `admin`, route guards |
| 3.4 | Upload: multer, MIME sniffing on magic bytes rather than trusting the header, size caps, image/video allowlist |
| 3.5 | Socket.IO event bus, room per analysis, auth handshake |
| 3.6 | `providers/visionLlm.ts` — OpenAI-compatible vision call, structured output, timeout, retry, fallback to heuristic |
| 3.7 | `adapters/ffmpegFrameExtractor.ts` — interval + scene-change sampling. Tests skip loudly when no ffmpeg binary is present |
| 3.8 | In-process `JobQueue` implementation, with the BullMQ swap documented at the port |
| 3.9 | Integration tests with `mongodb-memory-server` + supertest: full submit → poll → complete; auth rejection paths; oversized upload rejection; a socket client receiving the stage sequence |
| 3.10 | `docker-compose.yml` for api + mongo, and a seed script |

**Gate 3.** `npm test -w @caliper/api` green. `docker compose up` serves a working API and a manual
curl walkthrough of submit → poll → result is recorded in `AUDIT.md`. One real `VisionLlmProvider`
call against OpenRouter is executed and its (redacted) response recorded.

---

## Phase 4 — `apps/web` (the console)

Design is fixed by `PROJECT.md` §7 and is not re-litigated during build.

| # | Task |
|---|---|
| 4.1 | Vite + React 19 + TS. Design tokens as CSS custom properties from §7.3. Fonts self-hosted via `@fontsource` — no runtime call to Google Fonts |
| 4.2 | Browser adapters: canvas decoder → RGBA, IndexedDB media store, `<video>` + canvas frame extractor, `EventTarget` bus |
| 4.3 | `OnDeviceClipProvider` + the build-time text-embedding script that emits the committed label vectors |
| 4.4 | `@caliper/client` transport layer: `HttpTransport` and `InBrowserTransport`, one interface, selected by build flag |
| 4.5 | Shell: top bar, three-column console, pipeline rail. Full-height, no marketing scroll |
| 4.6 | Intake panel: symptom chips + free text, suspected condition select, duration, evolving flag |
| 4.7 | **Specimen viewport** — the signature. Dark ground, drag/drop/paste/camera, graticule empty state, contour draw-on, scale bar, corner metadata, frame strip for video |
| 4.8 | Assessment panel: acuity band, ranked differential with confidence bars, evidence trace, permanent disclaimer |
| 4.9 | API inspector panel showing the real request/response envelopes and socket events |
| 4.10 | Sample cases so a reviewer with no photo to hand can still run the flow in one click |
| 4.11 | Responsive to 375px, visible focus rings, `prefers-reduced-motion`, AA contrast on every pair |
| 4.12 | Playwright e2e: load → pick sample → run → assert a result with a confidence number renders |

**Gate 4.** Playwright green. Screenshots at 1440 / 768 / 375 reviewed against the §7.6 rubric,
line by line, with the verdict written down. Grep the built bundle for `#6366f1`-class indigo, for
`Inter`, and for any `sk-`/`Bearer` string. Lighthouse accessibility ≥ 95.

---

## Phase 5 — Deployment

| # | Task |
|---|---|
| 5.1 | Create the public GitHub repo via `gh`, push |
| 5.2 | GitHub Actions: install, typecheck, test, build web with the correct `base` path, upload Pages artifact, deploy |
| 5.3 | SPA fallback (`404.html`) and correct asset base for a project-page subpath |
| 5.4 | Enable Pages, wait for the deployment, **open the live URL in a real browser and run the whole flow against it** |
| 5.5 | Verify from a cold cache: no console errors, fonts load, the on-device model downloads and runs when opted into |

**Gate 5.** The live URL performs the complete task flow, verified in a browser, with a screenshot
of a real result on the deployed site. Not "the build succeeded" — the flow works, on the internet.

---

## Phase 6 — `apps/mobile` (stretch, budget-gated)

| # | Task |
|---|---|
| 6.1 | Expo + TS, consuming `@caliper/core` and the client package unchanged |
| 6.2 | Camera/library capture, intake form, result screen in the same design language |
| 6.3 | `expo-notifications` wired for the "analysis complete" push, with the production APNs/FCM path documented |
| 6.4 | Screenshots, and an `expo export --platform web` build published alongside the console if it is clean |

**Gate 6.** Runs in Expo Go against a local API; screenshots captured. If cut, that is recorded in
`AUDIT.md` and the proposal says nothing about a mobile app in this repo.

---

## Phase 7 — Documents and final audit

| # | Task |
|---|---|
| 7.1 | `docs/ARCHITECTURE.md` — the production write-up: video upload, frame processing, model connection, long-running jobs, result delivery. Diagrams, named technologies, failure modes, cost notes |
| 7.2 | `README.md` — what it is, the live link, how to run each app, and an unflinching statement of what is real and what is prototype |
| 7.3 | Full-repo honesty pass against `PROJECT.md` §9 |
| 7.4 | `PROPOSAL.md` — very short, straightforward, leading with the live link |
| 7.5 | Final report to the user |

**Gate 7.** Every claim in `PROPOSAL.md` traces to something verified in `AUDIT.md`. Fresh-clone
test: `git clone && npm i && npm test` passes from nothing.

---

## Risk register

| Risk | Likelihood | Response |
|---|---|---|
| HF CDN blocks the model fetch from `github.io` | low | Gate 0.3 catches it. Fallback: vendor the 11.8 MB ONNX into the repo and serve from Pages |
| On-device inference too slow on a modest laptop | medium | Opt-in only, never on load; heuristic provider is always the default path |
| Pages subpath breaks asset or worker URLs | medium | Explicitly configured in 5.2/5.3 and verified live in 5.4, not assumed |
| Scope overrun starves the design phase | high | Phase 4 is protected. Phase 6 is the release valve, and Phase 3 tests are trimmed before Phase 4 quality is |
| The demo reads as a fake backend | medium | The inspector panel, the shared handlers, and plain statements in README/UI/proposal |
