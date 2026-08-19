> Two `[FILL IN]` lines need your details before sending.

---

Hi — rather than describe my approach, I built your technical task.

**Live:** https://tammam-bt.github.io/caliper-triage/
**Code:** https://github.com/tammam-bt/caliper-triage

Enter symptoms, drop a photo or click a sample case, and it runs the whole workflow to a ranked result with a confidence score, a triage band, and a breakdown of every piece of evidence behind it. The "API" button in the header shows the real request/response envelopes.

Stack: React 19 + TypeScript, Node/Express/MongoDB/Socket.IO, and an Expo React Native app sharing the same core code. The ML is real, not mocked — MobileCLIP runs on-device in the browser, and a server-side vision-LLM provider is verified live against OpenRouter. 153 tests plus 10 Playwright e2e, CI green.

The demo runs the API handlers in the browser because GitHub Pages is static hosting — same handlers, same schemas, same pipeline, different adapters. `npm run standalone -w @caliper/api` runs the real Express + Mongo + Socket.IO server.

Your five production questions are answered concretely in `docs/ARCHITECTURE.md`. `docs/AUDIT.md` lists every defect I found while building, including two that a fully green test suite was hiding — that file is the honest picture of how I work with AI coding tools.

Yes, I'm comfortable completing the paid technical task. This was it.

`[FILL IN — 3-5 projects with live links, GitHub/portfolio, React Native apps you've shipped]`
`[FILL IN — availability and cost estimate for the full project]`

Thanks,
Tammam
