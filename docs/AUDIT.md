# Caliper — Audit Log

Evidence for every gate in `docs/ROADMAP.md`. Written as work happens, not reconstructed after.
Failures stay in this file.

## Environment baseline — 2026-08-19

| Item | Value |
|---|---|
| Node | v24.18.0 |
| npm | 11.16.0 |
| git | 2.43.0 |
| `gh` auth | `tammam-bt`, scopes `gist, read:org, repo, workflow` |
| ffmpeg | **not installed** — Phase 3.7 tests will skip |
| Vercel / Netlify / Cloudflare credentials | **none** — drives the GitHub Pages decision |
| Vision LLM keys present | `OPENROUTER_API_KEY`, `GROQ_API_KEY` (Groq exposes no vision model as of this date) |

---

## Gate 0 — De-risking spike — **PASS** (2026-08-19)

### 0.1 / 0.2 MobileCLIP zero-shot in Node — pass, with a plan-changing finding

`@huggingface/transformers@4.2.0`, `Xenova/mobileclip_s0`, `CLIPTextModelWithProjection` +
`CLIPVisionModelWithProjection`, 512-d embeddings, L2-normalised cosine similarity.

**Finding: every int8 quantization of this model is numerically broken.** Measured top-1 label and
the top-1/top-2 margin for a dog photo and a melanoma photo:

| vision dtype | size | dog → top-1 | margin | lesion → top-1 | margin |
|---|---|---|---|---|---|
| fp32 | 45.5 MB | **dog** ✓ | 0.138 | **skin lesion** ✓ | 0.191 |
| **fp16** | **22.9 MB** | **dog** ✓ | **0.138** | **skin lesion** ✓ | **0.191** |
| q8 | 11.8 MB | car ✗ | 0.005 | dog ✗ | 0.020 |
| int8 | 11.8 MB | dog ✓ | 0.005 | pizza ✗ | 0.016 |
| uint8 | 11.8 MB | car ✗ | 0.005 | dog ✗ | 0.020 |

The int8 variants do not merely degrade — the margins collapse to noise, so the ranking is
effectively random. The same applies to the text encoder: at `q8` it produced flat, meaningless
similarities; at `fp32` it separates cleanly.

**Plan amendment.** `PROJECT.md` §4.2 said the browser downloads the 11.8 MB quantized encoder. That
is wrong and would have shipped a model that returns noise. Corrected to **`vision_model_fp16.onnx`,
22,876,479 bytes (21.8 MiB)**, confirmed by `content-length`. The text encoder runs at **fp32 at
build time only**, so its size is irrelevant. Had this been discovered in Phase 4 instead of Phase 0
it would have looked like a UI bug.

Inference latency, Node CPU/WASM, 512-px input: **77–162 ms** per image at fp16.

`Xenova/clip-vit-base-patch32` at q8 was also tested as an alternative: it ranks correctly but with
much weaker margins (0.271 vs 0.203 on the dog) at 89 MB. MobileCLIP fp16 is better and a quarter of
the size. Rejected.

### 0.3 HF CDN reachable from a `github.io` origin — pass

```
curl -sI -H "Origin: https://tammam-bt.github.io" -L \
  https://huggingface.co/Xenova/mobileclip_s0/resolve/main/onnx/vision_model_fp16.onnx

HTTP/2 302 ... access-control-allow-origin: https://tammam-bt.github.io
HTTP/2 200 ... access-control-allow-origin: *
                content-length: 22876479
```

No proxy or vendoring needed. The risk-register fallback (committing the weights to the repo) is not
required.

### 0.4 OpenRouter vision inference — pass

512-px JPEG, base64 data URL, structured-JSON prompt. `google/gemma-4-31b-it:free` returned
`429 temporarily rate-limited upstream`. Two others succeeded:

- `nvidia/nemotron-nano-12b-v2-vl:free` — valid JSON, 3 ranked candidates with rationales.
- `google/gemma-4-26b-a4b-it:free` — valid JSON; independently identified melanoma citing asymmetry,
  irregular borders and colour variegation.

**Two findings for the provider implementation:** free models are rate-limited unpredictably, so the
provider needs an ordered model fallback list rather than a single model id; and both models wrap
their JSON in ```` ```json ```` fences, so the parser must strip fences before `JSON.parse`.

### Gate 0 verdict

Pass. On-device neural inference is viable at 21.8 MiB opt-in, and the server-side vision-LLM
provider is real and verified. Spike code is throwaway and stays out of the repo.
---

## Gate 1 — `@caliper/core` — **PASS** (2026-08-19)

```
 ✓ src/symptoms.test.ts (21 tests)
 ✓ src/features.test.ts (21 tests)
 ✓ src/fusion.test.ts   (34 tests)
   Test Files  3 passed (3)        Tests  76 passed (76)

All files      |   99.59 % stmts |   91.66 % branch |  100 % funcs
```

`tsc --noEmit` clean under `strict` + `noUncheckedIndexedAccess`. Gate required 85% on
`features.ts`, `symptoms.ts` and `fusion.ts`; all three are at 100% statements.

### Five defects the tests found, and what each one actually was

These are recorded because each was a genuine wrong answer, not a style problem, and three of them
would have been invisible in the UI — the app would simply have been subtly wrong.

**1. Colour variegation was measuring sensor noise.** A uniformly brown disc with ±6 LSB of noise
scored **5.2 distinct colours**; a genuinely two-toned lesion scored **2.0**. k-means at k=6 splits
near-identical points into six clusters, and cluster-mass perplexity cannot tell that apart from six
real colours. Fixed by agglomerating centroids within ΔE 12 before counting. Now: noisy disc 1.04,
two-tone disc 2.00. Regression test added.

**2. Border irregularity was measuring sensor noise too.** The identical disc measured **1.33**
with noise and **0.99** without. Chain-code perimeter is the most noise-sensitive shape measure
there is. Fixed with Kulpa's 0.9481 correction plus two passes of a 3×3 majority filter on the mask.
Now: 1.019 / 0.978 / 0.985 across noisy, clean and small discs — the theoretical 1.0 for a circle.
The cue ramp floor was recalibrated from 1.15 to the measured 1.05; at the old value every round
lesion would have activated the irregularity cue.

**3. A uniform frame segmented as one whole-image lesion.** On a noiseless frame Otsu returns a
threshold of 0, and floating-point dust in the Lab conversion then puts every background pixel above
it. `maskAreaRatio` came out at **1.000**. Fixed with a minimum threshold of 2% of dynamic range and
a `no_subject` quality issue when the mask exceeds 90% of the frame. Real photographs always carry
noise, which is exactly why this had to be caught by a synthetic fixture.

**4. `"unchanged"` contained `"changed"`.** Substring matching meant a phrase asserting a lesion is
stable would have contributed evidence *for* melanoma once `changed` entered the lexicon. Fixed with
whole-word regex matching, and contracted negations (`hasn't`) are now expanded in `normalise` so
the negator is a free-standing word. Both are regression-tested.

**5. The system reported 95% confidence.** Temperature 1.8 was not nearly enough: the strongest
fixture case printed **95.3%**, from hand-set weights that have never seen a labelled dataset. This
broke honesty rule 3 in `PROJECT.md` §9. Worse, the calibration test passed — because it asserted
the bound on the *weakest* case, where confidence is 0.20 at any temperature.

Two changes. Temperature swept to **3.0** (strongest case 74%, benign 38%, ambiguous 20%), and a
structural `MAX_REPORTED_CONFIDENCE = 0.85` ceiling so no input can produce a number the prototype
has not earned. The test now asserts the bound across *every* fixture and separately checks that the
strongest case lands between 0.5 and 0.8 — a bound that would fail if temperature regressed.

### Behaviour spot-check at the committed settings

| Case | Top-1 | Confidence | Acuity | Abstained |
|---|---|---|---|---|
| Plain disc, no history | benign naevus | 0.20 | indeterminate | **yes** — genuinely ambiguous |
| Lobed blob, "changing, bleeding" | melanoma | 0.74 | urgent | no |
| Two-tone disc, "unchanged since childhood" | benign naevus | 0.38 | routine | no |
| Erythematous patch, "hot, fever, spreading" | cellulitis | 0.74 | urgent | no |
| Crescent, "itchy, dry, flaking" | melanoma 30% / eczema 22% | 0.30 | **urgent** | no |

The last row is the "triage on the worst plausible candidate" rule working: eczema is a close
second, but a 30% melanoma does not get a routine disposition.
---

## Gate 2 — `@caliper/service` — **PASS** (2026-08-19)

```
 ✓ src/pipeline.test.ts (16 tests)
   Test Files  1 passed (1)        Tests  16 passed (16)
```

`tsc --noEmit` clean. The gate asked for the happy-path event sequence to be asserted literally and
for an injected provider failure to be proven not to hang. Both are done:

```js
expect(h.events.log.map((e) => e.stage)).toEqual([
  'received', 'preprocess', 'features', 'inference', 'fusion', 'complete',
]);
```

Failure modes covered by test, each of which would otherwise leave a spinner running forever:
provider throws (→ `failed`, error message preserved, progress 1), media missing from the store,
zero decodable frames, a subscriber that throws during event fan-out (must not fail the analysis —
in `apps/api` the bus is Socket.IO and a disconnecting client is routine), cancellation mid-flight,
and cancellation of an already-complete analysis.

Also asserted: progress is monotonically non-decreasing and terminates at 1; the result rides only
on the terminal event; a replayed idempotency key returns the original analysis rather than
starting a second one; and two different images through the same code path produce different
feature values — the guarantee that output is a function of the pixels rather than of the route.

One packaging fix was needed: `@caliper/core` now exports a `./testing` subpath so other packages
can use the synthetic fixtures without reaching into `src/`.
---

## Gate 3 — `apps/api` — **PASS** (2026-08-19)

```
 ✓ src/api.test.ts (26 tests)          real Express + real Mongoose + real GridFS + in-memory MongoDB
 ✓ src/visionLlm.live.test.ts (2)      skipped without OPENROUTER_API_KEY; run live, see below
   Tests  26 passed (26)
```

`tsc --noEmit` clean. Only the inference provider is substituted in the integration suite; routes,
models, GridFS and the database are real.

### The bug this phase found

**Every upload in the system was writing to the same GridFS key.** `submitAnalysis` accepted a
caller-supplied media id, and `app.ts` passed the constant placeholder `'pending'`. So the first
image uploaded to a given deployment was the image every subsequent analysis measured — across
analyses and across users. A correctness bug and a data-leak bug at once, and nothing in the API's
shape would have revealed it: every response was well-formed and plausible.

Caught by the test that submits two visibly different pictures and demands two different
measurements (`1.019` for a disc, `4.455` for a lobed blob) rather than merely asserting `200 OK`.

Fixed at the source: `SubmitAnalysisRequestSchema` now takes `MediaUploadSchema`, which is
`MediaRefSchema` with `id` omitted. A client cannot name a storage key, so it cannot overwrite or
read someone else's. The id is minted in the use-case and nowhere else.

### Live vision-LLM verification

```
$ OPENROUTER_API_KEY=… npx vitest run src/visionLlm.live.test.ts
live model: google/gemma-4-26b-a4b-it:free (vision LLM) {"melanoma":0.7,"benign_nevus":0.3}
 ✓ 2 tests
```

Real multimodal inference through the real provider, fence-stripped, schema-validated and mapped
onto the catalogue. The second test points the provider at an invalid key and a nonexistent model
and asserts it degrades to measured features instead of failing the analysis.

### End-to-end walkthrough against a running server

`npm run standalone -w @caliper/api` (Express + Socket.IO + ephemeral MongoDB, no Docker needed):

```
GET  /api/v1/health
  {"status":"ok","provider":"cv-heuristic","modelId":"abcd-heuristic-v1","mongo":"connected"}

POST /api/v1/analyses                                                         → HTTP 202
  {"analysisId":"fdfe7b76-…","status":"queued","channel":"analysis:fdfe7b76-…"}

GET  /api/v1/analyses/fdfe7b76-…                                              → HTTP 200
  status      : complete | stage: complete | progress: 1
  provider    : cv-heuristic / abcd-heuristic-v1 | computeMs: 354
  acuity      : urgent | confidence: 0.6753 | abstained: False
  features    : border=4.455 asym=0.330 colour=1.08 entropy=0.12 contour=219 pts
  differential:
     Melanoma                      67.5%  urgent
     Basal cell carcinoma           6.4%  prompt
     Cellulitis                     5.7%  urgent
     Seborrhoeic keratosis          5.4%  routine
  top evidence for #1:
     Base rate            4% of photographed lesions   -3.22
     Asymmetry            1.00 activation (high)       +2.40
     Border irregularity  1.00 activation (high)       +2.20
     Reported: changing   stated in intake             +1.28

POST /api/v1/analyses  (same Idempotency-Key)   → same analysisId: True
POST /api/v1/analyses  (a text file named .png) → HTTP 400 invalid_request
```

### Also covered by test

Ownership isolation (one user gets 404, not 403, on another's analysis — and an empty list rather
than a leak of row counts); account-enumeration resistance (identical body for unknown-email and
wrong-password); refusal to mint an admin through self-service registration; rejection of a refresh
token used as an access token; `413` on oversized upload; magic-byte sniffing across all five
accepted signatures plus two rejections; rate limiting proven with a purpose-built app at limit 2.

A test-isolation defect was also fixed here: the shared event bus accumulated across tests, so a
stage-sequence assertion was matching the previous test's events. The log is now reset per test and
the assertion filters by analysis id.

### Not verified, and why

- **ffmpeg video extraction.** No ffmpeg binary in this environment. `FfmpegFrameExtractor` is
  written and typechecked but has not been executed; it throws a message naming the missing
  dependency rather than failing obscurely, and `apps/api/Dockerfile` installs ffmpeg so
  `docker compose up` would exercise it. Recorded here rather than claimed as working.
- **`docker compose up`.** Docker is not available in this environment. The compose file and
  Dockerfile are written but have not been built. The `standalone` script above is what was
  actually run, and it is the path the README recommends for that reason.
- **MongoDB Atlas.** Not provisioned. All Mongo testing was against `mongodb-memory-server` 10.4.3,
  which runs a genuine `mongod`.
---

## Gate 4 — `apps/web` — **PASS** (2026-08-19)

```
 ✓ apps/web  e2e/console.spec.ts  10 passed (Playwright, against the production build)
 ✓ @caliper/core     79 tests
 ✓ @caliper/service  16 tests
 ✓ @caliper/api      39 tests   (26 integration + 11 sample calibration + 2 live LLM)
   144 tests total
```

`tsc --noEmit` clean. Verified in a real browser at 1440×900 and 390×844, with screenshots reviewed
against the `PROJECT.md` §7.6 rubric.

### The calibration bug this phase found — the most consequential one in the project

Every image cue was **pinned at 1.0 activation on every real photograph**, so the differential had
stopped depending on the picture. Melanoma led every case regardless of content.

The cause was a category error in how the cue ramps were calibrated. They were anchored to the
synthetic fixtures, where a disc measures border irregularity 1.0 and asymmetry 0.006, giving ramps
of roughly 1.05–3.0 and 0.03–0.30. Real clinical photographs do not live there. Measured across the
four bundled samples:

| | melanoma | bcc | dermatitis | cellulitis |
|---|---|---|---|---|
| border irregularity | 4.2 | 5.4 | 3.5 | 3.8 |
| asymmetry | 0.14 | 0.30 | 0.20 | 0.24 |

Both of melanoma's dominant cues sat at maximum for all four. The whole suite was green throughout,
because every unit test asserted against fixtures — the same fixtures the mis-calibration came from.

Before concluding the ramps were wrong, mask smoothing was swept from 2 to 12 passes to check
whether the roughness was noise. It converges at 3.3–6.1, so it is genuine boundary complexity, not
something to filter away. Smoothing stayed at 2 and the ramps were re-anchored to the observed
photographic range (`PHOTOGRAPH_RANGES` in `cues.ts`).

**Guard added:** `apps/api/src/samples.test.ts` runs the four real photographs through the real
pipeline and asserts that no more than two cues saturate, that the four produce distinct
measurements, that at least three distinct conditions lead across the set, and that each reaches
its expected disposition. That is the test that would have caught this.

### A fairness defect found while fixing the above

Erythema was `(R − (G+B)/2)`, which cannot distinguish inflammation from brown pigment — brown is
dark orange in RGB, so a melanoma scored a *higher* erythema activation than a cellulitis.

The obvious patch is to gate erythema on absolute lightness. That is worse than the bug: it makes
one skin tone the implicit baseline and would systematically under-detect erythema on darker skin,
which is a documented failure mode of dermatology imaging tools.

Colour cues are now differences from the patient's **own** surrounding skin — Δa\* for erythema,
ΔL\* for pigmentation and pearly sheen, against the reference colour segmentation already computes.
Tone-invariant, and closer to the actual clinical question: is this redder, or darker, than the skin
around it. `ImageFeatures` now carries `lesionLab` and `referenceLab` so the comparison is visible
in the API response rather than hidden in a coefficient.

Also fixed here: the reference skin colour is now a per-channel **median** of the border band rather
than a mean. A real photograph's border catches hair, clothing and background; a mean is dragged
toward those, and the delta-E threshold then selects half the frame. The BCC sample segmented at 28%
of frame under the mean and finds the lesion under the median.

### Behaviour of the four bundled samples, at the committed settings

| Sample | Top-1 | Confidence | Acuity | Note |
|---|---|---|---|---|
| Pigmented lesion, changing | Melanoma | 37% | urgent | colour variegation and pigmentation lead |
| Pearly nodule, non-healing | **abstains** | 22% | urgent | melanoma and BCC tie exactly; declines but still escalates |
| Itchy, dry patch | Eczema / dermatitis | 28% | routine | erythema without pigment |
| Hot, spreading redness | Cellulitis | 58% | urgent | erythema plus systemic symptoms |

Three distinct dispositions plus a live demonstration of abstention. The BCC case is an honest
limitation on display: with colour measured relative to surrounding skin, a lesion neither darker
nor redder than its background yields no colour signal, and this heuristic has nothing trained to
recognise a pearly border.

### Two more defects fixed from browser inspection

**Model evidence displayed with an inverted sign.** Contributions were raw `log(p)`, negative for
every p < 1, so the trace read `MobileCLIP … 22.3% posterior … −2.25` — the model appearing to
argue against its own top pick. Log terms are now centred on their mean across the catalogue, which
changes no ranking (a softmax is invariant to adding a constant) but makes the displayed sign mean
what a reader assumes.

**Sparse posteriors inverted the model's own ordering.** A vision LLM returns its top three or four
candidates, not a distribution. Unmentioned conditions contributed 0 while mentioned ones
contributed `log(p) < 0` — so *not being mentioned* outscored *being ranked third*. Unmentioned
conditions now take a floor probability. Tested.

### Design rubric (`PROJECT.md` §7.6) — checked against the built bundle

| Check | Result |
|---|---|
| No violet or indigo hue | **pass** — every hex in the built CSS parsed; nothing in the 240–300° band |
| Inter not loaded | **pass** — fonts shipped are Faustina, Public Sans, IBM Plex Mono only |
| No three-equal-card feature grid | **pass** — three-column console, no card grid anywhere |
| Headline is specific to this product | **pass** — "Caliper — assistive triage console" |
| One accent colour, not several | **pass** — `--reticle` appears only on viewport overlays |
| No icon where a word is clearer | **pass** — no icon library in the bundle; the only SVG is the measured contour |
| No gradients | **pass** — the only two are 1px graticule hairlines and the overlay scrim |
| No secrets in the bundle | **pass** — grepped for `sk-`, `Bearer`, JWT prefixes, key names |

### Accessibility

Nineteen foreground/background pairs computed. Four failed WCAG AA 4.5:1 and were corrected by
solving for the required luminance rather than by eye — `--ink-45` 4.34→5.09, `--ink-25` 2.42→4.65,
`--acuity-prompt` 3.31→4.65, `--acuity-routine` 4.35→4.65. All nineteen now pass.

Also verified: visible focus rings on every control, `prefers-reduced-motion` disables all three
animations, keyboard reachability asserted by e2e, no horizontal page overflow at 390px
(`scrollWidth === clientWidth`; the pipeline rail scrolls inside its own container by design, and
on narrow screens collapses to tick marks plus the active stage).

### On-device model, verified in a browser

Loaded on click, ran, and produced a posterior that reached the readout:

```
Provider   on-device-clip
Model      mobileclip_s0 (zero-shot)
Compute    1519 ms
Evidence   MobileCLIP S0 (zero-shot)   22.3% posterior
```

Initial page load does not touch it: the 23 MB ONNX runtime and the 559 kB transformers chunk are
split out and fetched only on opt-in. First load is a 374 kB JS chunk plus fonts.
---

## Gate 5 — Deployment — **PASS** (2026-08-19)

**Live: https://tammam-bt.github.io/caliper-triage/**

Two workflows: `ci.yml` (typecheck, unit and integration tests, Playwright e2e) and `pages.yml`
(build with the correct base path, SPA fallback, deploy). Pages is configured with
`build_type=workflow`.

### Verified against the live public URL, not against a local build

```
GET https://tammam-bt.github.io/caliper-triage/                 → 200
GET https://tammam-bt.github.io/caliper-triage/samples/melanoma.jpg → 200, 137,569 bytes
asset base in served HTML → src="/caliper-triage/assets/index-….js"
```

Full workflow driven in a real browser against the deployed site:

```
sample "Pigmented lesion, changing" → Run assessment
  top          Melanoma
  confidence   52%
  acuity       Urgent — same-day review
  contour      231 points drawn over the photograph
  metadata     A 0.141  B 4.15  C 5.69
  compute      1053 ms
  stages       6 of 6 complete
  console      0 errors, 0 warnings
```

The confidence differs from the CLI figure for the same image (37%) because the sample also sets
the `evolving` flag and two symptom chips. Intake changing the outcome is the intended behaviour and
is covered by test.

### Initial load

The 23 MB ONNX runtime and the 559 kB transformers chunk are code-split and fetched only when a
user opts into on-device inference. First load is a 374 kB JS chunk, a 23 kB stylesheet and
self-hosted fonts — no runtime request to Google Fonts, no CDN.

### CI

`Typecheck` and `Unit and integration tests` pass on the runner. The first CI run **failed**, and
correctly so: `@caliper/web` had a `test` script but no unit test files, and vitest exits non-zero
on "no test files found". Rather than suppress it with `passWithNoTests`, 13 tests were written for
the in-browser transport — the code path the entire deployment depends on, and the one place it
would have been most embarrassing to leave untested.

Writing them surfaced a further race: the API returns `202` with a channel and expects the client to
subscribe *next*, but the in-process queue started the job in the same microtask, so the `received`
event could be emitted before the subscription existed. The queue now yields a macrotask first,
matching the queue hop that always exists in production. Fixed and tested.
---

## Gate 6 — `apps/mobile` — **PARTIAL PASS** (2026-08-19)

Built, typechecked and bundled for a native target. **Not run on a device or simulator**, because
this environment has neither. That limit is stated here and in the README rather than left implied.

### What was verified

```
$ npx tsc --noEmit -p apps/mobile/tsconfig.json      → clean
$ npx expo export --platform android --output-dir dist
  Android Bundled 6241ms apps/mobile/index.ts (684 modules)
  _expo/static/js/android/index-….hbc (1.9 MB)
```

684 modules of Hermes bytecode, with `@caliper/core` and `@caliper/service` compiled in **unchanged**.
That is the claim worth making: the condition catalogue, the computer vision, the symptom lexicon
with its negation handling, the fusion weights and the abstention rule are the same code running on
the phone, in the browser and in the Express worker. One taxonomy and one calibration, not three
that drift apart.

### What is not verified

- No simulator or device run. Camera capture, the photo picker and the notification permission flow
  are written against the Expo APIs and typecheck, but have not been exercised.
- No App Store or Play Store build.
- The PNG decoder (`src/decode.ts`) has no unit test. It is a real decoder — 8-bit RGB/RGBA,
  non-interlaced, with all five scanline filters per RFC 2083 — and it throws rather than guessing
  on anything else, but it has only been exercised by the bundler, not by a test.

### Four problems getting Expo to build inside an npm workspace

Recorded because "add Expo to a monorepo" sounds like a one-liner and is not.

1. **A second React Native.** `expo-image-manipulator@13.0.6` depends on Expo SDK 57, while the app
   had been pinned to SDK 52. npm installed React Native 0.87 *alongside* 0.76 and hoisted metro
   0.84 next to metro 0.81, which then disagreed about internal module subpaths. npm `overrides`
   did not dislodge it. Fixed by aligning the whole app to the current SDK — the underlying mistake
   was pinning an SDK and then adding packages that had moved past it.
2. **`babel-preset-expo` was simply missing.** Referenced by `babel.config.js`, not installed,
   surfacing as an opaque `Cannot read properties of undefined (reading 'transformFile')`.
3. **`disableHierarchicalLookup: true` broke Expo's own imports.** It confines Metro to the declared
   `nodeModulesPaths`, and in a hoisted workspace several Expo packages live nested under
   `node_modules/expo/`, where Metro then cannot see them. `expo-modules-core` failed first. Left at
   Metro's default.
4. **Metro could not resolve the shared packages.** `@caliper/core` is standards-compliant
   TypeScript ESM, where `./schemas.js` is the correct specifier for `./schemas.ts`. Vite resolves
   that natively and Node resolves it via tsx; Metro does neither. A scoped `resolveRequest` in
   `metro.config.js` rewrites `.js` to `.ts` for the workspace's own packages only, falling through
   to the default resolver otherwise.

### Design continuity

The palette and the serif/sans/mono role split are carried over in `src/theme.ts`. The three custom
families are *not* shipped to mobile — three font files plus a loading state is a poor trade for a
prototype — so the roles map onto the platform faces. The distinction between report text, console
chrome and machine-produced numbers is what carries the design, and it survives the substitution.

### One deliberate product decision

The completion notification carries the acuity band and nothing else — never the condition, never
the confidence. A lock-screen preview reading "Melanoma, 72%" is a disclosure to whoever is holding
the phone, and notification payloads are the easiest place in a health app to leak a diagnosis by
accident.
