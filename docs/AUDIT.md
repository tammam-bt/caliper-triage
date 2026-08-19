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
