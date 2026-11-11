# ClipForge Project Status

Read-only status audit, 5 November 2026. This audit did not change existing files. It created this report only.

## Part A: Status report

### Summary

**10 of 23 planned features are complete (43%).** ClipForge currently runs as a local upload, import, transcription, and video-type analysis app; clip selection, scoring, rendering, and SEO are still to be built.

The percentage counts only items marked **Done** in the checklist below; partly complete items do not count as complete.

### Phase table

| Phase | Status | Evidence |
|---|---|---|
| 0 — Architecture | Partly done | The README describes local services and trade-offs, and Mongoose models exist. A complete architecture diagram and the proposed full set of data models are not in the repository. See [README.md](./README.md), [apps/api/src/models/](./apps/api/src/models/). |
| 1 — Scaffold, auth, projects, and upload | Done | The npm workspaces, API auth routes, project routes, resumable upload routes, and web pages are present. Typecheck and build passed. See [package.json](./package.json), [apps/api/src/routes/auth.ts](./apps/api/src/routes/auth.ts), [apps/api/src/routes/projects.ts](./apps/api/src/routes/projects.ts), [apps/api/src/routes/uploads.ts](./apps/api/src/routes/uploads.ts), [apps/web/src/pages/](./apps/web/src/pages/). |
| 2 — Worker, transcription, video type, and progress | Done | The worker runs in Compose; its logs reported concurrency 1 and Whisper `small`. The worker image contains ffmpeg, faster-whisper, and yt-dlp. The pipeline, transcript storage, SSE route, retry control, and related tests are present. The normal test run skipped the optional integration tests. See [compose.yaml](./compose.yaml), [Dockerfile.worker](./Dockerfile.worker), [apps/worker/src/pipeline/analyze-video.ts](./apps/worker/src/pipeline/analyze-video.ts), [apps/worker/python/transcribe.py](./apps/worker/python/transcribe.py), [apps/api/src/routes/jobs.ts](./apps/api/src/routes/jobs.ts), [apps/web/src/pages/project.tsx](./apps/web/src/pages/project.tsx). |
| 3 — Clip finding and scoring | Not started | No clip-candidate, virality-score, or score-breakdown implementation was found. |
| 4 — Clip rendering and captions | Not started | No selected-clip render pipeline or caption renderer was found. |
| 5 — SEO titles, descriptions, and tags | Not started | No SEO metadata generator was found. |
| 6 — Hardening, deployment, and publishing | Partly done | There is rate limiting, local storage cleanup, Docker setup, and a README. The 4 GiB Docker memory budget is not matched by current service ceilings; CI, a deployment guide, plan limits, and publishing are not implemented. See [compose.yaml](./compose.yaml), [README.md](./README.md), [apps/api/src/app.ts](./apps/api/src/app.ts), [apps/api/src/server.ts](./apps/api/src/server.ts). |

### Feature checklist

| Feature | Status | Evidence |
|---|---|---|
| Register, login, refresh, and logout | Done | [apps/api/src/routes/auth.ts](./apps/api/src/routes/auth.ts), [apps/api/src/middleware/auth.ts](./apps/api/src/middleware/auth.ts), [apps/web/src/pages/auth.tsx](./apps/web/src/pages/auth.tsx) |
| Project creation | Done | [apps/api/src/routes/projects.ts](./apps/api/src/routes/projects.ts), [apps/web/src/pages/dashboard.tsx](./apps/web/src/pages/dashboard.tsx) |
| Video upload | Done | [apps/api/src/routes/uploads.ts](./apps/api/src/routes/uploads.ts), [packages/shared/src/storage.ts](./packages/shared/src/storage.ts), [apps/web/src/pages/project.tsx](./apps/web/src/pages/project.tsx) |
| Large and resumable upload | Partly done | Chunks stream to disk and the UI has progress, cancel, and resume logic. A large live upload was not exercised in this audit. See [packages/shared/src/chunk-upload.ts](./packages/shared/src/chunk-upload.ts), [apps/api/src/routes/uploads.ts](./apps/api/src/routes/uploads.ts), [apps/web/src/pages/project.tsx](./apps/web/src/pages/project.tsx). |
| ffprobe media validation | Done | Upload completion probes the saved file and rejects invalid media or missing streams. See [packages/shared/src/media-probe.ts](./packages/shared/src/media-probe.ts), [apps/api/src/routes/uploads.ts](./apps/api/src/routes/uploads.ts). |
| Duration and size limits | Done | Environment settings and checks exist for upload and URL-import duration and size. See [.env.example](./.env.example), [apps/api/src/config.ts](./apps/api/src/config.ts), [apps/api/src/routes/projects.ts](./apps/api/src/routes/projects.ts), [packages/shared/src/url-import.ts](./packages/shared/src/url-import.ts). |
| BullMQ job queue | Done | Queue retries are configured; the worker runs at concurrency 1. See [apps/api/src/jobs/analysis-queue.ts](./apps/api/src/jobs/analysis-queue.ts), [apps/worker/src/index.ts](./apps/worker/src/index.ts), [compose.yaml](./compose.yaml). |
| Audio extraction | Done | Audio is extracted as mono 16 kHz PCM. See [apps/worker/src/media/commands.ts](./apps/worker/src/media/commands.ts), [apps/worker/src/pipeline/analyze-video.ts](./apps/worker/src/pipeline/analyze-video.ts). |
| faster-whisper transcription | Done | The worker image installs faster-whisper; the Python script runs CPU/int8 transcription with word timestamps. See [Dockerfile.worker](./Dockerfile.worker), [apps/worker/python/requirements.txt](./apps/worker/python/requirements.txt), [apps/worker/python/transcribe.py](./apps/worker/python/transcribe.py). |
| Word-level transcript saved to disk | Done | Word JSON is stored under the user's transcript directory; Mongo stores transcript summary and segments. See [apps/worker/src/pipeline/analyze-video.ts](./apps/worker/src/pipeline/analyze-video.ts), [apps/api/src/models/transcript.ts](./apps/api/src/models/transcript.ts). |
| Heuristic video-type detection | Done | Speech density, question ratio, pauses, and cue words feed a detector interface; its tests passed. See [apps/worker/src/video-type/detector.ts](./apps/worker/src/video-type/detector.ts), [apps/worker/src/video-type/detector.test.ts](./apps/worker/src/video-type/detector.test.ts). |
| Live progress and retry UI | Partly done | SSE, progress display, and retry controls are implemented. Their full browser behavior was not tested during this audit. See [apps/api/src/routes/jobs.ts](./apps/api/src/routes/jobs.ts), [apps/web/src/pages/project.tsx](./apps/web/src/pages/project.tsx). |
| YouTube link import | Partly done | Metadata preview, rights confirmation, limit checks, worker download, friendly errors, and tests are implemented. A real, authorized import was not performed. See [apps/api/src/routes/url-import.ts](./apps/api/src/routes/url-import.ts), [apps/worker/src/pipeline/import-video.ts](./apps/worker/src/pipeline/import-video.ts), [packages/shared/src/url-import.ts](./packages/shared/src/url-import.ts), [apps/web/src/pages/project.tsx](./apps/web/src/pages/project.tsx). |
| Ollama/LLM integration | Not started | `.env.example` contains Ollama settings, but no LLM provider or call is connected to the app. See [.env.example](./.env.example), [README.md](./README.md). |
| Heuristic clip shortlist | Not started | The existing heuristics classify video type; they do not find short clip candidates. |
| Clip scoring and readable breakdown | Not started | No scoring implementation or score breakdown model was found. |
| Clips grid UI | Not started | The project page shows videos and transcripts, not clip cards. See [apps/web/src/pages/project.tsx](./apps/web/src/pages/project.tsx). |
| 9:16 rendering with captions | Not started | No clip render pipeline or caption renderer was found. |
| SEO titles, description, tags, and hashtags | Not started | No metadata-generation code was found. |
| Plan limits | Partly done | A configurable active-job limit exists, but plan records, usage tracking, and the requested plan-limit stub are absent. See [.env.example](./.env.example), [apps/api/src/config.ts](./apps/api/src/config.ts), [apps/api/src/models/user.ts](./apps/api/src/models/user.ts). |
| YouTube publishing | Not started | No publishing or YouTube OAuth code was found. |
| Tests | Partly done | The run passed 23 tests; 4 integration tests were skipped. There are unit tests for shared helpers and video-type detection, plus optional worker integration tests. There are no clip, scoring, rendering, SEO, or API route test files in the inventory. See [packages/shared/src/](./packages/shared/src/), [apps/worker/src/](./apps/worker/src/), [package.json](./package.json). |
| README | Partly done | It documents the current setup, upload, transcription, Ollama setup, and URL import. It does not yet document the future clip, render, SEO, deployment, and publishing features. See [README.md](./README.md). |

### Known upload bugs

| Reported bug | Status | Audit evidence |
|---|---|---|
| “Could not read uploaded media: write EPIPE” | **Fixed in code** | The probe runs ffprobe against the saved file path, with stdin ignored; the upload pipeline no longer sends the media through ffprobe stdin. See [packages/shared/src/media-probe.ts](./packages/shared/src/media-probe.ts). This audit did not repeat the original failing upload. |
| A 14.9 MB, roughly 10-minute video is rejected as over the 3,600-second limit | **Fixed in code** | Upload completion saves the probed duration, and the project listing probes and repairs records whose duration is missing rather than treating an unknown value as 3,600 seconds. See [apps/api/src/routes/uploads.ts](./apps/api/src/routes/uploads.ts), [apps/api/src/routes/projects.ts](./apps/api/src/routes/projects.ts). This audit did not inspect that specific Mongo record or re-upload that file. |

### Health checks

| Check | Result |
|---|---|
| `npm run typecheck` | **Pass.** Shared package, API, worker, and web typechecks completed successfully. |
| `npm test` | **Pass:** 23 tests passed, 4 skipped; 9 test files passed and 4 were skipped (13 total). The skipped tests are optional integration tests. |
| `npm run build` | **Pass.** Shared package, API, worker, and web production builds completed; Vite built 1,630 modules. |
| `docker compose ps` | **Running.** API, MongoDB, and Redis reported healthy. Web and worker were up; neither has a Compose health check configured. |

### Risks

- **Docker memory:** The Compose memory ceilings total about 6.9 GiB: MongoDB 2 GiB, Redis 384 MiB, API 1 GiB, worker 3 GiB, and web 512 MiB. These are maximums, not reservations, but they allow the stack to exceed a 4 GiB Docker Desktop limit. This is the first operational issue to address.
- **8 GiB Mac:** CPU transcription, media decoding, containers, and Ollama can compete for memory. Whisper and the API/worker limits need testing together under the actual 4 GiB Docker limit; Ollama also uses Mac host memory.
- **Security:** Authentication, httpOnly cookies, ownership checks, rate limits, and loopback-only service ports are present. Uploaded media is still parsed by ffprobe/ffmpeg and imported media by yt-dlp; keep these tools updated and only import content you have permission to use. There is no audited production deployment configuration yet.
- **Error handling:** The API has centralized error handling and jobs save failure messages. Full failure-and-retry behavior has not been exercised through the browser for both upload analysis and URL import in this audit.
- **Tests:** API route/security tests and end-to-end URL-import tests are missing. Four integration tests were skipped in the health-check run, so the current run did not re-test real ffprobe/transcription or BullMQ retry integration.
- **URL import:** The preview requires yt-dlp to provide a safe size estimate; when it cannot, the app asks the user to upload the file. The real authorized import/progress flow remains unverified.

## Part B: Next-steps plan

No unresolved instance of either reported upload bug was found in the code. Start by fitting Docker's resource ceilings to the 4 GiB budget; then retest large uploads and URL import before building Phases 3–6. All prompts below keep processing local and free. Do not use any URL you do not own or have permission to use.

### 1. Fit Docker within 4 GiB and recheck the two upload bugs

- **What it does:** Adjust the Compose memory ceilings so the running stack can fit the 4 GiB Docker budget, then repeat the known upload regressions.
- **What you do by hand:** Set Docker Desktop to 4 GiB; review and **Keep** the proposed file changes; restart with `docker compose up --build`; open the current project page at `http://localhost:5173/projects/6aec3c568168100eeaf9ab24`; sign in if asked; check that the 14.9 MB video displays its real duration and that a valid upload is accepted.
- **Exact prompt:** `Start next-step 1 only. Read-only inspect the existing Compose resource limits, then make the smallest changes needed so the service memory ceilings fit within my 4 GiB Docker budget without breaking the worker. Do not start Phase 3. Run docker compose config, npm run typecheck, npm test, and npm run build. Give me the restart steps and a checklist to retest the old EPIPE and 14.9 MB duration bugs.`
- **How you know it worked:** Docker Compose starts without services repeatedly restarting; the API health check succeeds; the project page shows the approximately 10-minute video's real duration and no false 3,600-second rejection.
- **Time:** About 30–60 minutes, including restart and checks.

### 2. Test large and resumable uploads

- **What it does:** Confirm a large upload streams to disk, can resume after interruption, and can be canceled cleanly.
- **What you do by hand:** Check free disk space first. On the project page, upload a large video you are allowed to use; interrupt the connection or close the tab during upload, reconnect, then choose the exact same file to resume. Also try canceling an upload. Only try a 1 GiB file if there is enough free disk space.
- **Exact prompt:** `Start next-step 2 only. Audit and, only if needed, fix the existing resumable chunk-upload flow so a dropped connection resumes from the acknowledged offset, cancellation removes the partial upload, and errors are clear. Keep streaming to disk and respect the configured size/duration limits. Do not start Phase 3 or change unrelated files. Add or update focused tests, run typecheck, tests, and build, then give me the manual large-file test steps.`
- **How you know it worked:** The progress bar advances; after interruption, selecting the same file resumes from the saved progress rather than 0%; cancel removes the staged upload; a successful upload appears once in the video list.
- **Time:** About 30–60 minutes, plus the time needed to transfer the file.

### 3. Test YouTube link import end to end

- **What it does:** Verify metadata preview, the permission checkbox, import progress, and the upload fallback using a video you are authorized to use.
- **What you do by hand:** Open the project page; paste a permitted YouTube link; check that title, channel, duration, and thumbnail appear; check the rights box; start import and watch progress. Do not try to bypass a private, age, geographic, removed, or bot-check block.
- **Exact prompt:** `Start next-step 3 only. Audit and test the existing YouTube URL-import implementation; fix only issues found in that flow. Keep the required ownership/permission confirmation, pre-download size and duration checks, friendly blocked-video errors, upload fallback, and no bypasses. Use mocks in automated tests; do not download a real video. Do not start Phase 3. Run typecheck, tests, and build, then give me a manual checklist for an authorized URL.`
- **How you know it worked:** Metadata appears before import; import stays disabled until the rights box is checked; the video enters the list and shows download progress; blocked links show a clear message and upload suggestion.
- **Time:** About 30–60 minutes for code and mocks, plus download time for your manual authorized test.

### 4. Build heuristic clip candidates (Phase 3, first part)

- **What it does:** Find promising 15–60 second transcript windows using explainable local heuristics, without claiming they will go viral.
- **What you do by hand:** Review and **Keep** the proposed changes; restart the worker and web services; open a project with an analyzed video and confirm candidate times are shown.
- **Exact prompt:** `Start Phase 3 step 1 only: implement a tested, heuristic-only shortlist of 15–60 second clip candidates from the saved transcript, using the existing transcript/video-type data and simple explainable signals. Do not add scoring, an LLM, rendering, SEO, or new paid services yet. Do not start Phase 4. Run typecheck, tests, and build, then tell me what to check on the project page.`
- **How you know it worked:** The analysis view lists candidate start/end times that stay within the video and do not cut through words; no virality scores are shown yet.
- **Time:** About 1–2 hours.

### 5. Add scores and local Ollama support (Phase 3, second part)

- **What it does:** Score shortlisted candidates with a readable breakdown, using local `llama3.2:3b` when available and a clearly labeled local fallback when not.
- **What you do by hand:** Confirm Ollama is running on the Mac and that `llama3.2:3b` is present; review and **Keep** changes; restart the stack; analyze a video and inspect a candidate's score breakdown.
- **Exact prompt:** `Start Phase 3 step 2 only. Add the LLM-provider interface and local Ollama provider using OLLAMA_BASE_URL and OLLAMA_MODEL=llama3.2:3b. Validate every LLM response with Zod, allow at most two retries for invalid JSON, and keep a heuristic-only fallback. Score only the shortlisted windows and show hook, emotion, clarity, pacing, and payoff separately. Scores are guidance, never promises. No paid APIs, Phase 4 rendering, or Phase 5 SEO. Add focused tests and run typecheck, tests, and build.`
- **How you know it worked:** A shortlisted clip displays a 0–100 guidance score and the five-part breakdown; the app still gives a result if Ollama is stopped.
- **Time:** About 1–2 hours.

### 6. Add the analysis timeline and clips grid (Phase 3, final part)

- **What it does:** Show the transcript and candidate windows in a reviewable timeline and grid.
- **What you do by hand:** Restart the web app, open the analyzed project, and inspect the grid, timing, scores, and empty/error states.
- **Exact prompt:** `Finish Phase 3 only. Add the analysis timeline and clips grid for the existing candidates, with candidate time range, score, and readable score breakdown. Include loading, empty, and error states. Do not add rendering, editing, SEO, publishing, or paid services. Add focused UI tests if the existing setup supports them; run typecheck, tests, and build.`
- **How you know it worked:** The project page shows candidate cards linked to the transcript/timeline, with score details and sensible loading/empty/error states.
- **Time:** About 1–2 hours.

### 7. Render selected clips vertically with captions (Phase 4, first part)

- **What it does:** Render only a clip the user selects as a 9:16 MP4 with burned-in captions using local ffmpeg.
- **What you do by hand:** Restart the worker; select one candidate; request a render; wait for its job to finish; play the resulting file.
- **Exact prompt:** `Start Phase 4 step 1 only. Implement a retryable worker render job for one user-selected candidate at a time: cut on safe transcript boundaries, produce a 9:16 MP4 with burned-in captions using local ffmpeg, and report progress/errors. Use a ReframeStrategy interface with a simple center crop or blurred fit; do not add face-tracking dependencies. Add focused tests. No SEO or publishing. Run typecheck, tests, and build.`
- **How you know it worked:** The selected candidate finishes as a playable vertical MP4 with readable captions; unselected candidates are not rendered.
- **Time:** About 1–2 hours.

### 8. Add clip trim, caption controls, and download (Phase 4, second part)

- **What it does:** Let the user adjust a candidate's trim and caption appearance, rerender it, and download the result.
- **What you do by hand:** Open a rendered clip; change its trim/caption settings; rerender; play and download the new file.
- **Exact prompt:** `Continue Phase 4 with the clip editor only: add trim controls constrained to the source clip, a small set of caption-style controls, rerender, and download actions. Preserve the existing render worker and add validation/tests for invalid trim ranges. Do not start Phase 5 or add paid services. Run typecheck, tests, and build.`
- **How you know it worked:** The editor prevents invalid ranges; rerendered captions reflect the selected style; the download opens as an MP4.
- **Time:** About 1–2 hours.

### 9. Generate clip titles and descriptions offline-first (Phase 5)

- **What it does:** Generate editable titles, descriptions, tags, and hashtags from the clip transcript, using Ollama locally and transcript keywords as the fallback.
- **What you do by hand:** Restart the app; open a rendered clip's metadata editor; generate text; edit it and copy it.
- **Exact prompt:** `Start Phase 5 only. Add offline keyword extraction and local Ollama metadata generation for each rendered clip: three titles of at most 70 characters, a description, 10–15 tags, and hashtags. Enforce lengths and reject misleading/banned claims in code; keep an offline fallback. Do not require YouTube Data API, billing, or any paid service. Add schema and generation tests; run typecheck, tests, and build.`
- **How you know it worked:** The editor shows three bounded title options, description, tags, and hashtags; generation still works in fallback mode when Ollama is unavailable.
- **Time:** About 1–2 hours.

### 10. Harden and document the completed local workflow (Phase 6, first part)

- **What it does:** Close reliability and security gaps, add missing tests and CI, and document operation and recovery for the local app.
- **What you do by hand:** Review and **Keep** the changes; restart Compose; follow the README setup and backup/recovery steps; check the CI run if you use GitHub.
- **Exact prompt:** `Start Phase 6 hardening only. Audit the implemented local workflow for security, cleanup, resource use under an 8 GiB Mac with Docker limited to 4 GiB, error reporting, and missing tests. Make small evidence-based fixes, add CI for lint/typecheck/test/build using the existing tools, and update the README with hardware expectations, local setup, backups, cleanup, and troubleshooting. Keep all services and providers free/local by default; do not add paid APIs. Do not add YouTube publishing in this step. Run typecheck, tests, build, and Compose config validation.`
- **How you know it worked:** The README steps work from a clean local setup; normal tests and the CI checks pass; the services stay running under the configured memory budget.
- **Time:** About 1–3 hours.

### 11. Optional: YouTube publishing (Phase 6, second part)

- **What it does:** Add publishing only if the official YouTube requirements can be met without a paid service.
- **What you do by hand:** First check the current official YouTube API and OAuth requirements; create any required developer configuration only if it does not require billing; authorize your own channel; publish a test clip you own.
- **Exact prompt:** `Start the optional YouTube publishing step only after Phase 6 hardening. First verify that the official YouTube API/OAuth path can be used without paid services or a billing account; if it cannot, stop without implementing publishing. If it can, add an opt-in publisher behind an interface, keep credentials in environment variables, require a clear user confirmation before publishing, and add mocked tests. Do not weaken existing privacy or rights checks.`
- **How you know it worked:** The user explicitly confirms a publish action and sees the returned YouTube link; if a free path is not available, no publishing code is added.
- **Time:** About 1–3 hours if the free API setup is available; otherwise skip.

**Recommended starting point: Step 1.** The current Compose memory ceilings do not fit the requested 4 GiB Docker budget, so address that before stressing large files or adding more processing.
