# ClipForge

ClipForge is a local-first workspace for turning long videos into short clips. Phase 2 adds local audio extraction, CPU transcription, heuristic video-type detection, and live analysis progress to the Phase 1 monorepo and upload workflow.

## Requirements

- Docker Engine with Docker Compose v2
- 8 GB RAM recommended for the full stack; transcription and rendering are serialized to limit peak memory
- About 5 GB free disk space for images, the default Whisper model, and databases, plus room for source videos

All current services are open-source and run locally. No payment account, hosted API, or API key is required.

## Run with Docker Compose

```sh
cp .env.example .env
```

Change both JWT secrets in `.env` to distinct random values of at least 32 characters. On Linux, set `LOCAL_UID` and `LOCAL_GID` to the values from `id -u` and `id -g` so the API and worker can write to the bind-mounted `data/` folder. On macOS, if the default IDs cannot write there, set them to the IDs reported by `id -u` and `id -g`.

Then start the stack:

```sh
mkdir -p data
docker compose up --build
```

Open [http://localhost:5173](http://localhost:5173). The API health check is at [http://localhost:4000/health](http://localhost:4000/health). MongoDB and Redis ports are bound to loopback only. Uploaded media is written under `./data/users/<user-id>/videos/`; MongoDB and Redis data use Docker named volumes.

Stop with `Ctrl-C`, or run `docker compose down`. `docker compose down -v` also removes the MongoDB and Redis volumes; it does not remove `./data`.

The worker image includes ffmpeg, ffprobe, Python, yt-dlp, and a faster-whisper virtual environment. Whisper model files persist in the `whisper-models` Docker volume and are reused after restarts. Topic segmentation uses FastEmbed multilingual MiniLM and stores the model cache in the `fastembed-models` Docker volume so the weight files do not live in the image layer. Configure `WHISPER_MODEL_SIZE` (`tiny`, `base`, `small`, `medium`, `large-v3`), `FASTEMBED_MODEL_NAME`, `FASTEMBED_CACHE_DIR`, `MAX_VIDEO_DURATION_SECONDS` (default 3,600 seconds; maximum 86,400), `MAX_UPLOAD_BYTES` (default 2 GiB), `UPLOAD_CHUNK_BYTES` (default 8 MiB), and `MIN_FREE_DISK_BYTES` (default 256 MiB free-space reserve) in `.env`. The API and worker both enforce the configured duration cap. Raising it allows longer videos but increases download, transcription, and disk requirements; processing remains sequential. The API rejects oversized or overlong media before analysis can be queued. Uploads use resumable offset-based chunks written directly to disk, and the API checks available disk space before creating an upload session. Incomplete upload files older than 24 hours are cleaned up automatically.

### Embedding cache permission troubleshooting

The Compose initializer creates the model-cache directories and sets their ownership to `LOCAL_UID:LOCAL_GID` (default `1000:1000`). The worker image also seeds `/models/fastembed` with default ownership for fresh volumes. At startup, the worker checks that the cache is writable and logs a repair command if not. To repair an existing FastEmbed volume, run the exact command printed in the worker log from the project directory, then restart the worker:

```sh
docker compose up -d worker
```

If embeddings still cannot load, check `docker compose logs worker` for the FastEmbed traceback. Topic segmentation falls back to basic heuristic topics, marks the warning in the project UI, and does not fail video analysis.

URL import supports YouTube video links only. It previews title, channel, duration, thumbnail, and estimated size using yt-dlp before queueing an import; the user must confirm ownership or permission. Both metadata and worker download steps enforce configured duration/size limits, and imports are stored and ffprobe-validated like uploaded files. Private, age-restricted, geo-blocked, removed, and bot-check blocked videos are not bypassed; upload the file instead. yt-dlp can break as YouTube changes: update it by rebuilding the API and worker images, which install the current package during image build:

```sh
docker compose build --no-cache api worker
docker compose up -d api worker
```

For manual testing outside Docker, install/update with `python3 -m pip install --upgrade yt-dlp` and set `YTDLP_PATH` to the installed executable.

The default `base` model uses CPU/int8; the analysis controls also offer `balanced` (`small`) and show an approximate transcription ETA before queuing. Actual timing depends strongly on CPU, model, and language. The generated two-minute sample transcribed with `small` in 50.5 seconds on the current Mac/Docker setup; use your own machine's measured test output for a current estimate.

## Ollama setup

Install Ollama on macOS with `brew install ollama`, then start it with `brew services start ollama` (or launch the Ollama app). Pull `llama3.2:3b` on Macs with 8 GB RAM or less; use `qwen2.5:7b` on systems with at least 16 GB. Set `OLLAMA_MODEL` to the model you pulled and `OLLAMA_BASE_URL=http://host.docker.internal:11434` in `.env`. Verify the local server with `curl http://localhost:11434/api/tags`. Ollama and its models run locally; model downloads require network access. Clip scoring sends one candidate at a time, validates the JSON response, and falls back to a visible heuristic score if Ollama is unavailable or returns invalid data. One warmed 98-word candidate scored with `llama3.2:3b` in 14.65 seconds on the current Mac; first use may take longer while the model loads.

## Run the applications directly

Requires Node.js 20.19+ and a local MongoDB and Redis instance.

```sh
cp .env.example .env
# For a host-run API, set MONGO_URI=mongodb://localhost:27017/clipforge,
# REDIS_URL=redis://localhost:6379, and STORAGE_ROOT=./data in .env.
npm install
npm run dev
```

The API listens on port 4000 and Vite on port 5173. Running the worker directly also requires ffmpeg/ffprobe and an installed faster-whisper Python environment; Docker is the supported zero-setup path.

## Phase 1 and 2 functionality

- Register and sign in with email/password. Access and rotating refresh JWTs use `httpOnly`, `SameSite=Lax` cookies; the password is hashed with bcrypt.
- Create private projects and upload MP4, M4V, MOV, MKV, or WebM videos. Resumable 8 MiB chunks stream directly to disk, can resume after a dropped connection, and have a progress bar and cancel control. Uploads are limited by `MAX_UPLOAD_BYTES` (2 GiB by default), checked against available disk space, and validated with ffprobe on the saved media path for real streams and duration.
- Video data is stored in a per-user directory. Project ownership is checked before accepting an upload.
- Paste a YouTube video URL to preview its metadata and import it as a background job. Download progress is sent over the existing authenticated SSE job stream, and successful imports can be analyzed through the same Phase 2 pipeline as uploads.
- Upload handling uses a `StorageProvider` stream interface; `LocalDiskStorage` is the current implementation.
- Start or retry analysis from a project's video list. BullMQ retries failed attempts and the worker processes one video at a time.
- Audio is normalized to mono 16 kHz, transcribed locally by faster-whisper with word timestamps, and reported in per-chunk progress over SSE. Language labels are combined by audio duration across chunks rather than copied only from the last chunk. Transcript words are stored as a per-user JSON file; summary segments and metadata are stored in MongoDB.
- Video type is detected heuristically (speech density, questions, pauses, and cue words). It is guidance only and does not use an LLM.
- Incomplete upload files and old worker job directories are cleaned up automatically. Source videos and successful transcripts are retained.

Clip candidates are available after analysis: choose **Find clips** to build up to 60 varied, sentence-bounded 20–60 second windows from the saved transcript, then send only the top 15 cheap-signal candidates to the sequential scorer. Local multilingual embeddings are used for topic coherence and duplicate removal when the cache is available; rule-based signals remain the fallback. The selected 5–8 clips use normalized multi-factor ranking and maximal marginal relevance for topic diversity. The factor weights and detection thresholds are centralized in `apps/worker/src/clips/ranking-config.ts`. The optional Gemini scoring checkbox is off by default and discloses that only clip transcript text is sent to Google. Cards show the topic, five-part highlight assessment, and each normalized factor with its weight. Scores are guidance, not a promise that a clip will go viral. Scoring results are cached by content hash.

Only clips marked **Selected for rendering** can be rendered. Use **Render selected** or a card's **Render** button, then choose the default low-cost blur-fit background or center-crop framing. Each clip also has **Clean**, **Karaoke**, and **Bold pop** caption styles and a filler-cleanup toggle; **Preview style (5s)** renders a separate five-second test without replacing the final render. Captions are phrase-chunked at punctuation and pauses, use timed karaoke highlighting or limited rule-based emphasis, and retain word timings when fillers/repeats are hidden. The single worker serializes rendering with transcription, scoring, and metadata generation. It writes 1080×1920 H.264/AAC MP4s with burned-in word-timestamp captions; the worker image includes Noto fonts with Devanagari and Telugu coverage. Each card shows render progress and ETA, offers retry after a final failure, and provides an authenticated video preview, MP4 download, and render deletion when ready. Changing a trim or caption setting clears its previous render.

Selected or rendered clips also have an editable **Metadata** panel. Generate three YouTube Shorts title options, a description and tags, plus Instagram Reels and TikTok captions. The configurable provider order defaults to `gemini,ollama,offline`; Gemini is considered only when `GEMINI_API_KEY` is set and the user enables **Allow Gemini for this clip**. Its request contains the clip transcript and generation instructions, never the source video or a media file. The UI shows this disclosure beside the opt-in: “Sends clip transcript text to Google. On the free tier, Google may use it to improve its products.” Google currently lists `gemini-3.8-flash` as a Flash model with free-tier input/output tokens; availability can change. See [Google's model list](https://ai.google.dev/gemini-api/docs/models) and [pricing](https://ai.google.dev/gemini-api/docs/pricing). Keep `GEMINI_API_KEY` only in `.env` (which is gitignored), never in browser settings or source control.

Ollama (`OLLAMA_MODEL`, default `llama3.2:3b`) runs locally and is the next provider by default. Metadata generation uses small JSON calls with bounded output and a 60-second timeout per request. Hard safety failures (unsupported health/financial claims, invented numbers/names/quotes, guarantees, urgency, virality claims, and ALL-CAPS spam) cause only the affected field to be regenerated; harmless unsupported wording is allowed with a warning badge. If a field remains unsafe after retries, it uses an explicit field-level Offline fallback rather than hiding that decision. The UI identifies the provider and explains fallback reasons. “Same language as the video” follows the transcript text if faster-whisper's language label disagrees with the writing script; the recorded Whisper label is not silently rewritten. Results are cached by content and generation options. Source-link imports can include an editable original-video credit line. Character limits live in `packages/shared/src/platform-limits.ts`. Trend data, YouTube API integration, publishing, and paid services are not part of this phase.

## Development checks

```sh
npm run typecheck
npm test
npm run build
```

Unit tests include chunk timestamp merging, interrupted/resumed upload chunks, duration limits, heuristic classification, clip boundary snapping, overlap removal, candidate signals, karaoke ASS tags, phrase-aware chunks, timing safety, filler cleanup, emphasis caps, real Mongoose clip validation, FFmpeg command construction, metadata schema/length/content validation, offline fallback, and cache reuse. The media integration suite generates its own two-minute speech/video sample, rejects a fake media file, verifies the real file with ffprobe, and runs it through ffmpeg and faster-whisper. A separate render integration test burns Latin, Hindi, and Telugu captions into a five-second 1080×1920 sample, and optional render and Ollama metadata integrations measure local processing time. Run integrations with the Compose services available:

```sh
docker compose build worker
docker compose up -d mongo redis worker
docker compose run --rm --no-deps -e RUN_QUEUE_INTEGRATION=true worker npm exec vitest -- run apps/worker/src/queue.retry.integration.test.ts
docker compose run --rm --no-deps -e RUN_MEDIA_INTEGRATION=true worker npm exec vitest -- run apps/worker/src/media.pipeline.integration.test.ts
docker compose run --rm --no-deps -e RUN_RENDER_INTEGRATION=true worker npm test -- --run apps/worker/src/render/render.integration.test.ts
docker compose run --rm --no-deps -e RUN_RENDER_BENCHMARK=true worker npm test -- --run apps/worker/src/render/render.integration.test.ts
docker compose run --rm --no-deps -e RUN_METADATA_INTEGRATION=true worker npm test -- --run apps/worker/src/llm/generate-clip-metadata.test.ts
```

The media integration test prints `CLIPFORGE_SAMPLE_TRANSCRIPTION_SECONDS` for its measured transcription duration. Manual retest checklist:

1. Sign in, then upload a valid video and confirm progress, final duration, and video/audio stream validation.
2. During a larger upload, cancel and confirm it stops; start again, interrupt the connection, then choose the exact same file and confirm it resumes rather than restarts.
3. Paste a valid YouTube video URL and confirm metadata appears before import. Confirm the permission checkbox is required, then import and watch download progress update over SSE before analyzing.
4. Try an invalid/non-YouTube URL, a playlist-only URL, and a link that yt-dlp cannot access. Confirm friendly errors and the upload-file suggestion; confirm private/age/geo/bot blocks are not bypassed.
5. Upload a renamed text file and confirm ffprobe rejects it.
6. Configure `MAX_UPLOAD_BYTES` and `MAX_VIDEO_DURATION_SECONDS` to low test values; verify URL metadata is rejected before queueing/download and over-size uploads fail before a session is created.
7. To verify disk-space reporting without filling the disk, temporarily set `MIN_FREE_DISK_BYTES` above available space; confirm the API/UI reports the available and required space for uploads and URL imports. Restore the normal reserve afterward.
8. Confirm the previously uploaded 14.9 MB video displays the ffprobe duration of 367.320 seconds and no longer reports the missing-duration 3,600-second limit error.
9. Before analysis, select `fast` or `balanced` and confirm the estimate changes; start analysis and confirm the selected model, per-chunk progress, and SSE ETA.
10. Force a worker failure, confirm the clear error is visible, then use Retry (including Retry import). Restart the worker and confirm the Whisper model does not download again.
11. On a clip card, try **Clean**, **Karaoke**, and **Bold pop**, toggle **Clean fillers**, and use **Preview style (5s)**. Confirm the preview is five seconds and does not change the final render status or output.
12. Select one clip and render it. Confirm progress and ETA update, the ready card plays a vertical captioned video, and it offers MP4 download and **Delete render**. Confirm that changing caption style or trim clears the old final render.
13. Confirm an unselected clip cannot be rendered and **Render selected** queues only selected clips.
14. Select a clip and open **Metadata**. Generate it; check the selected title, three variants, description, 10–15 tags, hashtags, and Instagram/TikTok captions. Confirm the mode is AI or Offline and generation does not overlap another worker job.
  Also open **Trend signals**. If `YOUTUBE_API_KEY` is absent or unavailable, it must show `Trend data: offline`, zero API quota used, and fallback text. If a key is configured, public YouTube title/tag/hashtag samples and quota usage should appear. Add the key only to `.env`; it is read by the worker and must never be returned by the API or logged.
15. Change the output language and tone, regenerate, edit fields and select a title, then **Save changes**. Reload the page to confirm edits persist; use each **Copy** and **Copy all** button.
16. For an imported video, turn the original-video credit on and off and confirm the YouTube description updates. Confirm counters update and invalid over-limit, unsupported, ALL-CAPS, or guarantee-style metadata cannot be saved.

The upload path is handled directly by Express as `application/offset+octet-stream`; Vite has no proxy and Compose has no reverse proxy/body limit. Express's JSON parser is not applied to chunk bodies.

## YouTube trend API setup

Trend metadata remains a free optional feature. Add a YouTube Data API key to the local `.env` only:

```sh
printf '\nYOUTUBE_API_KEY=<your-key-here>\n' >> .env
docker compose up -d --build worker
docker compose logs --tail=30 worker | grep -E 'youtube\\.trends|YOUTUBE_API_KEY'
```

The worker startup log reports `youtube.trends.configured` or `youtube.trends.not_configured`. It never logs the key. A missing or invalid key causes the metadata provider to remain non-fatal and use offline trend data. Configure a Google Cloud API key with YouTube Data API v3 enabled; ClipForge does not enable billing automatically. Express's JSON parser is not applied to chunk bodies.
