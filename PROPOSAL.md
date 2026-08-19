# Upwork proposal — MERN + React Native, AI-powered healthcare app

> **Before sending:** three blocks below are marked `[FILL IN]`. I don't have your portfolio links,
> your React Native work, or your rate, and I'm not going to invent them. Everything else is
> verifiable against the live link.

---

Hi,

Rather than describe how I'd approach the technical task, I built it.

**Live demo:** https://tammam-bt.github.io/caliper-triage/
**Source:** https://github.com/tammam-bt/caliper-triage

Enter symptoms, optionally pick a suspected condition, drop a photo or short clip (or click a
bundled clinical sample), and it runs the whole workflow — quality gate → segmentation → feature
extraction → inference → evidence fusion → a calibrated result with a confidence score, a triage
acuity band, and a signed evidence trace for every contribution. The **API** button in the header
shows the actual request/response envelopes.

Try the *Pearly nodule* sample: the system declines to answer when its top two candidates tie, and
still escalates the acuity. I'd rather show you that than a demo that always sounds confident.

**What's in the repo**

- React 19 + TypeScript web app; Node + Express + MongoDB + Socket.IO backend with JWT auth and
  roles, magic-byte upload validation, GridFS storage, and a job queue behind a port so swapping in
  BullMQ/Redis is a wiring change. Socket.IO is tested over a real connection, handshake and all.
- An Expo React Native app on the same shared core — same catalogue, same CV, same calibration.
  It bundles for native (684 modules); I haven't run it on a device, and the audit says so.
- Real ML, not a stub: MobileCLIP runs **on-device in the browser** (opt-in, 22 MB, real ONNX
  inference), and a server-side vision-LLM provider is verified live against OpenRouter. The
  classical CV — Otsu segmentation on colour distance from the patient's own skin, boundary
  tracing, ABCD descriptors — is what draws the measured contour over your photo.
- 152 unit and integration tests across four packages, plus 10 Playwright e2e against the
  production build. CI green.

The deployed demo runs the API handlers **in the browser**, because GitHub Pages is static hosting
and I had no server credentials. Same handlers, same Zod schemas, same pipeline, same event
contract — just a Map instead of MongoDB and a canvas instead of ffmpeg. `npm run standalone -w
@caliper/api` runs the real Express + Mongo + Socket.IO server locally.

**Your five production questions** are answered concretely in
[`docs/ARCHITECTURE.md`](https://github.com/tammam-bt/caliper-triage/blob/main/docs/ARCHITECTURE.md):
presigned direct-to-S3 multipart upload (never through the API process), ffmpeg frame extraction in
a worker with sharpness-weighted frame selection, the model behind an `InferenceProvider` port with
a heuristic fallback, BullMQ on Redis with idempotency keys, backpressure and cancellation, and
results delivered over Socket.IO plus polling plus push — because sockets drop and phones suspend.

Two things I'd want you to know up front. The condition coefficients are illustrative, not fitted —
they're there to make the reasoning legible, and in production they're replaced by a model trained
on ISIC/HAM10000 or your own data. And confidence is hard-capped at 85%, because nothing here has
been validated and a prototype printing 95% would be lying.
[`docs/AUDIT.md`](https://github.com/tammam-bt/caliper-triage/blob/main/docs/AUDIT.md) lists every
defect I found while building, including two that a fully green test suite was hiding.

**Yes, I'm comfortable completing the paid technical task** — this was it. Happy to do a different
scope if you'd prefer.

**AI coding tools:** I use Claude Code and Cursor daily. The audit log is the honest picture of what
that looks like: fast generation, then finding a media-id collision that made every upload overwrite
the same storage key, and a calibration bug that made the model stop responding to the image. I test
and take responsibility for what I ship.

`[FILL IN — 3-5 previous projects with live/demo links]`

`[FILL IN — GitHub profile/portfolio, React Native apps you've shipped, other MERN/AI projects,
third-party and AI/ML APIs you've integrated]`

`[FILL IN — your availability, and your cost estimate for the full project. The 2-week MVP target
is realistic for the core scope; I'd want to confirm the AI/ML piece and app-store timelines.]`

Thanks for reading,
Tammam
