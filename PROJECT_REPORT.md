# ClipForge — Complete Project Report

**Report date:** 6 November 2026  
**Scope:** Documentation, source code, tests, Docker services, and live local stack audit

## 1. Executive summary

ClipForge is currently a working local-first video-clipping and metadata application. It is much further advanced than the older `PROJECT_STATUS.md` suggests: that document was written before the clip discovery, ranking, rendering, animated-caption, trend-metadata, and UI upgrade stages and is now outdated.

The implemented system can:

- register, authenticate, and manage private projects;
- upload large videos through resumable chunks;
- import rights-confirmed YouTube URLs through yt-dlp;
- analyze a video with faster-whisper and FastEmbed;
- detect topics, find candidates, rank and diversify clips, and show why candidates were removed;
- trim clip boundaries, render 1080x1920 clips, burn in animated captions, preview a style, and download the MP4;
- generate and edit titles, descriptions, tags, hashtags, Reels captions, and TikTok captions;
- use Gemini on opt-in, Ollama locally, or a rules/heuristic offline fallback;
- fetch optional trend data from YouTube Data API v3 with cache and quota protection.

The live Docker stack was healthy on 6 November 2026:

- API health endpoint: healthy and connected to MongoDB;
- MongoDB, Redis, API, web, and worker containers: running;
- Gemini key: configured;
- Ollama URL: configured;
- YouTube Data API key: missing from `.env`;
- Trend metadata therefore operated in offline mode.

## 2. Documentation audited

The project-level documentation consists of:

- [README.md](./README.md) — setup, architecture features, model providers, testing, and manual verification;
- [.env.example](./.env.example) — environment configuration inventory;
- [PROJECT_STATUS.md](./PROJECT_STATUS.md) — an older status audit and implementation checklist that is no longer current.

The codebase also contains 52 worker TypeScript source files, 21 shared-package TypeScript source files, 11 API model files, 7 API route files, and 4 React page files.

## 3. Architecture

### Monorepo

The repository follows an npm-workspaces structure:

- `apps/api`: Express REST API, Mongoose models, authentication, jobs, uploads, clip routes, and range-video streaming;
- `apps/worker`: BullMQ worker, transcription, embeddings, topic detection, candidate ranking, rendering, standalone checks, and metadata generation;
- `apps/web`: React/Vite/Tailwind interface and project workspace;
- `packages/shared`: shared TypeScript/Zod schemas, constants, limits, storage abstraction, and testing helpers.

### Infrastructure

Docker Compose currently runs:

- MongoDB 7 with a loopback-published port and persistent volume;
- Redis 7 with persistence and memory limits;
- Express API with a 512 MiB limit;
- worker with FFmpeg, Python, faster-whisper, yt-dlp, FastEmbed support, and a 2 GiB limit;
- Vite web container with a 256 MiB limit;
- two persistent model/cache volumes plus Mongo/Redis volumes.

The worker is explicitly configured for one-at-a-time BullMQ processing.

### Storage and data

Local disk storage is used for source videos, transcript JSON, rendered clips, and preview renders. MongoDB stores projects, videos, transcript summaries, analysis data, clips, metadata, jobs, quota records, trend caches, and provider state.

## 4. Feature completion

### Authentication and projects — complete

- registration and login;
- bcrypt password hashing;
- access and refresh JWT flow;
- rotating refresh-token records;
- httpOnly cookie-based refresh behavior;
- `user` and `admin` roles;
- private project and ownership checks.

Relevant files:

- [apps/api/src/routes/auth.ts](./apps/api/src/routes/auth.ts)
- [apps/api/src/middleware/auth.ts](./apps/api/src/middleware/auth.ts)
- [apps/api/src/models/user.ts](./apps/api/src/models/user.ts)
- [apps/web/src/pages/auth.tsx](./apps/web/src/pages/auth.tsx)
- [apps/web/src/pages/dashboard.tsx](./apps/web/src/pages/dashboard.tsx)

### Upload and URL import — complete to the implemented scope

- resumable 8 MiB chunk uploads;
- cancel and resume behavior;
- stream-to-disk storage abstraction;
- ffprobe validation;
- size and duration enforcement;
- disk-space reserve checks;
- incomplete-upload cleanup;
- YouTube metadata preview through yt-dlp;
- mandatory rights/ownership confirmation;
- import failure handling and upload fallback guidance.

### Analysis pipeline — complete

- mono 16 kHz audio extraction;
- faster-whisper transcription with configurable CPU/int8 models;
- chunk progress and ETA;
- word-level transcript file on disk;
- summary metadata in MongoDB;
- heuristic video-type detection;
- semantic topic segmentation with FastEmbed;
- non-fatal embedding fallback to heuristic topics;
- persistent FastEmbed cache volume and ownership initialization;
- retryable recompute-topics job.

The worker runs transcription, embeddings, scoring, and rendering serially by design.

### Topic segmentation — complete

- configurable topic depth sensitivity and minimum/maximum segment duration;
- topic labels with English/Hindi stopword handling and TF-IDF-style distinctiveness;
- topic boundaries stored in analysis records;
- UI presentation of topic segments.
- recompute button with saved-transcript-only processing.

### Clip finding, ranking, and selection — complete

The implementation includes:

- 20–60 second candidate windows, normally up to 60 candidates;
- sentence-boundary start/end construction;
- cheap heuristic factors;
- LLM scoring limited to the top 15 candidates;
- normalized multi-factor ranking;
- centralized weight and threshold configuration;
- duplicate removal by text similarity and overlap;
- MMR diversity selection;
- context-aware boundary adjustment;
- standalone rules with an LLM check where available;
- staged replacement to preserve old clips if generation fails;
- a funnel report showing generated/removal counts and per-candidate removal reasons.

Core implementation: [apps/worker/src/clips/ranking.ts](./apps/worker/src/clips/ranking.ts), [apps/worker/src/clips/ranking-config.ts](./apps/worker/src/clips/ranking-config.ts), [apps/worker/src/clips/shortlist.ts](./apps/worker/src/clips/shortlist.ts), and [apps/worker/src/clips/selection.ts](./apps/worker/src/clips/selection.ts).

### Rendering and animated captions — complete to the implemented scope

- user-selected clips only;
- center-crop and blur-fit reframe modes;
- 1080x1920 output;
- H.264/AAC MP4 with faststart;
- Clean, Karaoke, and Bold pop caption styles;
- phrase-aware chunks;
- timing correction, filler removal, emphasis selection, and word highlighting;
- 5-second style preview;
- changing style or trim invalidates prior final output;
- range streaming, download, retry, and render deletion.

Core implementation: [apps/worker/src/pipeline/render-clip.ts](./apps/worker/src/pipeline/render-clip.ts), [apps/worker/src/render/ass.ts](./apps/worker/src/render/ass.ts), and [apps/worker/src/render/captions.ts](./apps/worker/src/render/captions.ts).

### Standalone quality checks — complete

- negative-control protection against a clip beginning mid-sentence;
- rules can veto a non-standing-alone result from an LLM;
- filler, unresolved-openings, payoff, and boundary changes are represented on the card;
- boundary-quality score and change reasons are stored.

### Metadata generation — complete

- three title variants;
- description;
- tags and hashtags;
- Instagram Reels and TikTok captions;
- editable metadata and title selection;
- length, banned-pattern, and content guards;
- Gemini opt-in, Ollama fallback, and offline generation;
- provider/fallback status and cache reuse;
- original-video credit insertion.

Relevant implementation:

- [packages/shared/src/clip-metadata.ts](./packages/shared/src/clip-metadata.ts)
- [apps/worker/src/llm/generate-clip-metadata.ts](./apps/worker/src/llm/generate-clip-metadata.ts)
- [apps/api/src/routes/clips.ts](./apps/api/src/routes/clips.ts)
- [apps/api/src/models/clip-metadata.ts](./apps/api/src/models/clip-metadata.ts)

### Trend-informed metadata — complete in implementation, partially live-verified

- trend-provider interface with a YouTube implementation;
- configurable YouTube region and language;
- configurable quota budget and API-call costs;
- Mongo 24-hour cache;
- safety-stop quota control;
- offline fallback;
- query derivation and public sample collection;
- title-word-overlap guard;
- competitor provenance and trend UI panel.

Live verification found:

- Gemini configured;
- Ollama configured as a fallback service;
- YouTube key absent;
- Trend mode offline with quota used 0;
- a real metadata generation attempt fell back Gemini 429 → Ollama timeout → Offline.

## 5. Job, retry, and failure behavior

Implemented job types are:

- `analysis`
- `url-import`
- `recompute-topics`
- `find-clips`
- `render`
- `metadata`

The API and worker use Mongo job records plus BullMQ. Startup can identify orphaned active Mongo records and mark stale work failed. Cancel support and retry handling exist for affected jobs.

Staged replacement protects existing clips when new candidate output fails validation or generation.

## 6. Verification status

The most recent full validation before the trend report showed:

- typecheck: passed;
- 199 tests passed, 10 skipped;
- full monorepo build: passed;
- Docker API/worker/web rebuild: passed;
- API health: connected;
- worker memory snapshot: approximately 347 MiB of 2 GiB;
- live YouTube trend calls: not verified because the key was absent.

The optional integration suites remain environment-dependent. The standard test run skips external-media, real-render, real-queue, and local-provider integrations unless separately enabled.

## 7. Known limitations and incomplete features

### Publishing and upload automation — not implemented

No YouTube OAuth flow, channel authorization, upload API, resumable YouTube publishing, publication status, or quota management is implemented.

The code does not and should not claim that a rendered clip is copyright-free.

### Third-party copyright — not solvable by software

Downloading, trimming, adding captions, improving metadata, or reframing does not remove rights restrictions. The current rights confirmation for URL imports is a minimum safeguard; it cannot verify the source owner's license.

Before uploading third-party material, the user needs:

- explicit written permission from the copyright owner; or
- a license permitting redistribution and monetization; or
- a defensible fair-use/legal analysis, which is jurisdiction-dependent and never guaranteed.

### CI/CD — not implemented

No `.github/workflows` directory was found. Docker Compose works locally, but lint/typecheck/test/build automation and deployment release automation are not configured.

### Real quota verification — incomplete

The YouTube trend implementation is present, but live quota use cannot be reported until `YOUTUBE_API_KEY` is configured and a real trend fetch succeeds. The key currently needs Google Cloud setup and a valid project/API enablement.

### Security and production hardening — still limited

Implemented:

- Helmet, CORS, cookie parser, centralized errors, request IDs, and rate limiting;
- passwords hashed with bcrypt;
- owner checks and access token middleware;
- loopback binds for MongoDB, Redis, API, and web in Compose;
- separate API and worker environment boundaries.

Remaining before production:

- HTTPS/reverse proxy/TLS and secure cookie deployment settings;
- stronger refresh-token rotation and revocation lifecycle;
- CSRF review beyond SameSite cookies;
- account lockout or abuse controls;
- centralized secret management;
- dependency and container vulnerability scanning;
- backup and restore procedures;
- audit logging for destructive/privileged operations;
- production log retention and redaction review;
- secure deletion and retention policy;
- S3/object-storage implementation if moving off local disk.

### Storage and cleanup — partially operational

The disk interface exists, but there is no full user-managed data-retention policy, lifecycle dashboard, backup command set, corrupt-file repair workflow, or automatic cleanup of old successful renders. Source-video retention is currently documented as a product choice rather than a configurable policy.

### Plan and billing model — not implemented

The `plans` and `usageRecords` concepts are not implemented. There is an active analysis-job limit and user RBAC, but no subscription tiers, usage metering, quota UI, invoice model, or billing provider integration.

This is appropriate for the zero-cost local-first phase, but it is not yet a complete SaaS billing model.

### Search and competitor data — constrained

YouTube trend collection uses public data only and default free API settings, but must be tuned against current official quota costs and terms. Search calls are relatively expensive, while no political, identity, medical, or commercial claim verification system exists.

### Tests — unit coverage is strong; live browser coverage is limited

There are real Mongoose validation tests and unit/integration coverage for candidates, boundaries, rendering, metadata, uploads, and trends. Missing or weak areas include:

- end-to-end Playwright/Cypress coverage;
- cross-browser range streaming;
- sustained large-file upload interruption tests;
- real Gemini/Ollama failover benchmarks;
- real YouTube trend data with a valid account key;
- real-channel publishing because publishing is absent;
- load and memory testing across long-duration inputs.

## 8. Performance and resource observations

Current Compose limits:

| Service | Limit |
|---|---:|
| MongoDB | 512 MiB |
| Redis | 256 MiB |
| API | 512 MiB |
| Web | 256 MiB |
| Worker | 2 GiB |

The worker image is approximately 2.55 GiB, with the API at approximately 1.44 GiB and web at approximately 673 MiB. Exact disk usage varies by Docker host and cache state.

No feature should run concurrently with transcription or rendering. Candidate scoring, embedding, metadata, and rendering already follow the worker serialization priority in the product design.

## 9. Current operational gaps

### `.env`

The key is missing:

```env
YOUTUBE_API_KEY=
```

Gemini key presence and Ollama URL were redacted and verified from the live container.

### Docker startup

The worker should show:

```text
youtube.trends.not_configured
```

after adding no key. When a valid key is configured, it should show `youtube.trends.configured`. Restart/rebuild behavior:

```sh
docker compose up -d --build worker
docker compose logs --tail=30 worker
```

### Stale status file

`PROJECT_STATUS.md` uses a 5 November 2026 phase audit that predates later implementations. It explicitly says clip finding, rendering, SEO, and trend features are not started. Current source evidence supersedes that document. A future cleanup should replace it or clearly label it as historical.

## 10. Recommended next improvements

### Priority 1 — stabilize production foundations

1. Add GitHub Actions CI for lint, typecheck, unit tests, build, Docker Compose config validation, and dependency security scanning.
2. Add Playwright smoke tests for registration, upload, analysis, Find clips, metadata, render, preview, and download.
3. Add backups and restore documentation for MongoDB, Redis, the `data` directory, and model volumes.
4. Add real service retention policies, deletion confirmation, and cleanup controls.
5. Add structured provider diagnostics without exposing API keys or full sensitive transcript bodies.
6. Correct and re-run all live-stack verification commands after future changes.

### Priority 2 — improve analysis quality

1. Benchmark topic segmentation across several real videos and add configurable presets.
2. Add manual topic boundary review/edit controls.
3. Compare ranking output against human-rated clips and tune weights empirically.
4. Measure each factor's contribution rather than treating the 0–100 score as certainty.
5. Improve multilingual transcript punctuation and sentence snapping.
6. Add face-aware optional crop later using a separate low-cost service, not the base Docker image.

### Priority 3 — trend and metadata quality

1. Configure a valid YouTube API key and verify real quota behavior.
2. Preserve provenance for every title, tag, and hashtag suggestion.
3. Add trend snapshots, cache age, quota history, and API-error history to the UI.
4. Add A/B metadata variant comparison rather than only three static options.
5. Keep strict copyright and false-claim disclaimers visible in every metadata workflow.
6. Add metrics such as title length, overlap guard score, keyword coverage, and description completeness.

### Priority 4 — rendering and user workflow

1. Add timeline-based trim editing with waveform/speaker preview.
2. Add multiple safe crop focus points or optional face tracking behind a provider interface.
3. Improve multilingual line wrapping for mixed scripts.
4. Offer font and palette presets in centralized caption configuration.
5. Add render queue visibility and estimate accuracy.
6. Add cleanup controls for previews, failed renders, old final renders, and incomplete files.

### Priority 5 — SaaS and deployment features

1. Add usage counters, plans, storage limits, and per-user quotas if the product becomes multi-user.
2. Add an external object-storage provider behind the existing storage interface.
3. Add email verification, password reset, account recovery, and session-management UI.
4. Add TLS/reverse-proxy deployment with a non-loopback production topology.
5. Add monitoring, metrics, worker queue dashboards, and alerting.
6. Add disaster recovery and migration tooling for MongoDB and local files.

## 11. Optional publishing plan

YouTube publishing should remain blocked until the product first establishes rights handling. If publishing is added later:

1. Verify current OAuth and API requirements for direct uploads.
2. Add a separate user-confirmation flow requiring rights/ownership evidence.
3. Store refresh tokens encrypted and scoped to the minimum upload permissions.
4. Preserve source credit and content-license metadata.
5. Upload in paused/privatedraft mode first when supported.
6. Add post-upload status and Content ID/claim warnings, but never claim a zero-copyright result.
7. Do not promise that YouTube will accept, monetize, or leave a clip untouched.

## 12. Recommended immediate actions for you

1. Replace the old JWT placeholder secrets in `.env` with unique 32-plus-character secrets.
2. Create and restrict a valid YouTube Data API v3 key and add it to `.env`.
3. Rebuild and restart only the worker:

```sh
docker compose up -d --build worker
docker compose logs --tail=30 worker
```

4. Regenerate metadata for a real clip.
5. Verify online trend queries, public sample titles, quota use, and the provider fallback.
6. Run the complete validation commands:

```sh
npm run typecheck
npm test
npm run build
docker compose config
```

7. Add CI after the local workflow is stable.
8. Prepare explicit source ownership/license confirmation if the source content is not yours.

## 13. Final assessment

ClipForge already contains a substantial end-to-end implementation: local transcription, topic discovery, candidate selection, ranking, boundary adjustment, rendering, animated captions, metadata, and optional trends.

The largest remaining engineering gaps are:

- CI/CD;
- production hardening and backup/restore procedures;
- end-to-end browser and live-provider verification;
- storage/retention management;
- plans/usage models;
- YouTube publishing and OAuth.

The largest business/legal gap is copyright authorization for third-party source content. Copyright-free production and upload monetization cannot be guaranteed merely by using free tools or adding captions.
