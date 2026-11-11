import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Clapperboard, FileVideo2, Link2, Pause, Play, RotateCw, Sparkles, Trash2, Upload, Volume2, VolumeX, X } from "lucide-react";
import { estimateTranscriptionSeconds, type ModelSpeed } from "@clipforge/shared/transcription-estimate";
import type { UrlImportMetadata } from "@clipforge/shared/url-import";
import type { ClipScoreResult } from "@clipforge/shared/clip-scoring";
import type { ClipMetadataResult, MetadataOptions, TrendSignals } from "@clipforge/shared/clip-metadata";
import type { ClipFunnelReport } from "@clipforge/shared/clip-funnel";
import type { ClipStandaloneCheck } from "@clipforge/shared/clip-standalone";
import { CAPTION_STYLES, type CaptionStyle } from "@clipforge/shared/caption-config";
import { PLATFORM_LIMITS } from "@clipforge/shared/platform-limits";
import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "../components/ui/button";
import { API_URL, apiRequest } from "../lib/api";
import { transcriptScriptMismatch } from "../lib/transcript-language";

interface JobProgress {
  stage: string;
  message: string;
  percent: number;
  completedChunks?: number;
  totalChunks?: number;
  etaSeconds?: number;
}

interface AnalysisJob {
  id: string;
  type: "analysis" | "url-import" | "find-clips" | "render" | "metadata" | "recompute-topics";
  status: "queued" | "processing" | "retrying" | "completed" | "failed";
  progress: JobProgress;
  attemptsMade: number;
  maxAttempts: number;
  failedReason?: string;
  captionPreview?: boolean;
}

interface Video {
  _id: string;
  originalName: string;
  sizeBytes: number;
  status: string;
  createdAt: string;
  durationSeconds?: number;
  source?: "upload" | "url";
  sourceUrl?: string;
  sourceTitle?: string;
  channel?: string;
  detectedType?: string;
  analysisError?: string;
  job: AnalysisJob | null;
  analysis: {
    videoType: string;
    topicSegments?: Array<{ id: string; index: number; start: number; end: number; label: string; text: string; boundaryDepthScore?: number; contextBefore?: string[]; contextAfter?: string[] }>;
    topicsMode?: "semantic" | "basic";
    topicWarning?: string;
    heuristics: {
      speechDensityWordsPerMinute: number;
      questionRatio: number;
      meanPauseSeconds: number;
    };
  } | null;
  transcript: {
    language: string;
    wordCount: number;
    segments: Array<{ start: number; end: number; text: string }>;
  } | null;
  clips: ClipCandidate[];
  findClipsRuns?: Array<{
    id: string;
    status: string;
    createdAt: string;
    completedAt?: string;
    diagnostics?: ClipFunnelReport;
  }>;
}

interface ClipCandidate {
  _id: string;
  start: number;
  end: number;
  transcriptText: string;
  signalsFound: string[];
  reason: string;
  score?: number;
  breakdown?: ClipScoreResult["breakdown"];
  scoringMode?: ClipScoreResult["scoringMode"];
  topicLabel?: string;
  factorBreakdown?: Record<string, { score: number; weight: number; contribution: number; reason: string }>;
  boundaryQualityScore?: number;
  boundaryQualityReason?: string;
  boundaryChanges?: string[];
  standaloneCheck?: ClipStandaloneCheck;
  selectedForRendering?: boolean;
  renderStatus?: "not-rendered" | "rendering" | "ready" | "failed";
  renderFilePath?: string;
  renderSettings?: { reframeStrategy: "blur-fit" | "center-crop" };
  captionStyle?: CaptionStyle;
  cleanupCaptionFillers?: boolean;
  captionPreviewFilePath?: string;
  renderedAt?: string;
  renderError?: string;
  renderJobId?: string;
  renderProgress?: { message: string; percent: number; etaSeconds?: number };
  metadata?: ClipMetadataState | null;
}

interface ClipMetadataState {
  contentHash?: string;
  result?: ClipMetadataResult;
  mode?: "AI" | "Offline";
  provider?: "Gemini" | "Ollama" | "Offline" | "Gemini + Offline" | "Ollama + Offline";
  fallbackReason?: string;
  warnings?: Record<string, string[]>;
  edited: boolean;
  language: MetadataOptions["language"];
  tone: MetadataOptions["tone"];
  includeOriginalCredit: boolean;
  useGemini: boolean;
  generationStatus: "idle" | "queued" | "processing" | "retrying" | "failed";
  generationJobId?: string;
  generationProgress?: { message: string; percent: number; etaSeconds?: number };
  generationError?: string;
  trendSignals?: TrendSignals;
}

interface ClipMetadataDraft {
  result: ClipMetadataResult | null;
  language: MetadataOptions["language"];
  tone: MetadataOptions["tone"];
  includeOriginalCredit: boolean;
  useGemini: boolean;
}

interface ProjectVideos {
  videos: Video[];
}

interface UploadSession {
  uploadId: string;
  offsetBytes: number;
  expectedSizeBytes: number;
  chunkSizeBytes: number;
}

interface UrlPreview {
  sourceUrl: string;
  metadata: UrlImportMetadata;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

function formatEta(seconds: number) {
  if (seconds < 60) return `About ${seconds}s remaining`;
  const minutes = Math.ceil(seconds / 60);
  return `About ${minutes} min remaining`;
}

function isActive(status?: string) {
  return status === "queued" || status === "processing";
}

async function getUploadOffset(uploadId: string): Promise<{ offset: number; length: number; chunkSize: number } | null> {
  let response = await fetch(`${API_URL}/uploads/${uploadId}`, { method: "HEAD", credentials: "include" });
  if (response.status === 401) {
    await apiRequest<void>("/auth/refresh", { method: "POST", retryAfterRefresh: false });
    response = await fetch(`${API_URL}/uploads/${uploadId}`, { method: "HEAD", credentials: "include" });
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not resume upload (${response.status})`);
  const offset = Number(response.headers.get("Upload-Offset"));
  const length = Number(response.headers.get("Upload-Length"));
  const chunkSize = Number(response.headers.get("Upload-Chunk-Size"));
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || !Number.isSafeInteger(chunkSize)) {
    throw new Error("The server returned an invalid upload offset");
  }
  return { offset, length, chunkSize };
}

function sendUploadChunk(
  uploadId: string,
  offset: number,
  chunk: Blob,
  onProgress: (loaded: number) => void,
  activeRequest: { current: XMLHttpRequest | null },
  mayRefresh = true
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    activeRequest.current = request;
    request.open("PUT", `${API_URL}/uploads/${uploadId}`);
    request.withCredentials = true;
    request.setRequestHeader("Content-Type", "application/offset+octet-stream");
    request.setRequestHeader("Upload-Offset", String(offset));
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    request.onload = async () => {
      activeRequest.current = null;
      if (request.status === 401 && mayRefresh) {
        try {
          await apiRequest<void>("/auth/refresh", { method: "POST", retryAfterRefresh: false });
          resolve(await sendUploadChunk(uploadId, offset, chunk, onProgress, activeRequest, false));
        } catch (error) {
          reject(error);
        }
        return;
      }
      if (request.status !== 204) {
        let message = `Chunk upload failed (${request.status})`;
        try {
          message = (JSON.parse(request.responseText) as { error?: string }).error ?? message;
        } catch {
          // Keep the HTTP status message when the server response is not JSON.
        }
        reject(new Error(message));
        return;
      }
      const nextOffset = Number(request.getResponseHeader("Upload-Offset"));
      if (!Number.isSafeInteger(nextOffset) || nextOffset !== offset + chunk.size) {
        reject(new Error("The server acknowledged an unexpected upload offset"));
        return;
      }
      resolve(nextOffset);
    };
    request.onerror = () => {
      activeRequest.current = null;
      reject(new Error("Upload connection was interrupted. Choose the same file to resume."));
    };
    request.onabort = () => {
      activeRequest.current = null;
      reject(new DOMException("Upload canceled", "AbortError"));
    };
    request.send(chunk);
  });
}

async function deleteUploadWhenIdle(uploadId: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await apiRequest<void>(`/uploads/${uploadId}`, { method: "DELETE" });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("A chunk is still being written")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("The server is still finishing the current chunk; retry canceling in a moment");
}

export function ProjectPage() {
  const { projectId = "" } = useParams();
  const [uploadError, setUploadError] = useState("");
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [urlPreview, setUrlPreview] = useState<UrlPreview | null>(null);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [pendingUploadId, setPendingUploadId] = useState<string | null>(null);
  const [uploadCompleting, setUploadCompleting] = useState(false);
  const activeRequest = useRef<XMLHttpRequest | null>(null);
  const uploadKeyRef = useRef<string | null>(null);
  const cancelRequested = useRef(false);
  const queryClient = useQueryClient();
  const videosKey = ["projects", projectId, "videos"];
  const videosQuery = useQuery({
    queryKey: videosKey,
    queryFn: () => apiRequest<ProjectVideos>(`/projects/${projectId}/videos`),
    refetchInterval: (query) => query.state.data?.videos.some((video) =>
      video.clips.some((clip) => clip.renderStatus === "rendering" ||
        ["queued", "processing", "retrying"].includes(clip.metadata?.generationStatus ?? "idle"))
    ) ? 1_000 : false
  });
  const limitsQuery = useQuery({
    queryKey: ["projects", "limits"],
    queryFn: () => apiRequest<{
      maxUploadBytes: number;
      maxVideoDurationSeconds: number;
      uploadChunkBytes: number;
    }>("/projects/limits")
  });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      cancelRequested.current = false;
      setUploadName(file.name);
      setUploadPercent(0);
      setUploadError("");
      const key = `clipforge-upload:${projectId}:${file.name}:${file.size}:${file.lastModified}`;
      uploadKeyRef.current = key;
      let uploadId = sessionStorage.getItem(key) ?? undefined;
      let offset = 0;
      let chunkSize = limitsQuery.data?.uploadChunkBytes ?? 8 * 1024 * 1024;
      try {
        if (uploadId) {
          const remote = await getUploadOffset(uploadId);
          if (remote && remote.length === file.size) {
            offset = remote.offset;
            chunkSize = remote.chunkSize;
          } else {
            sessionStorage.removeItem(key);
            uploadId = undefined;
          }
        }
        if (!uploadId) {
          const session = await apiRequest<UploadSession>(`/projects/${projectId}/uploads`, {
            method: "POST",
            body: JSON.stringify({ originalName: file.name, sizeBytes: file.size, contentType: file.type })
          });
          uploadId = session.uploadId;
          offset = session.offsetBytes;
          chunkSize = session.chunkSizeBytes;
          sessionStorage.setItem(key, uploadId);
        }
        setPendingUploadId(uploadId);
        while (offset < file.size) {
          if (cancelRequested.current) throw new DOMException("Upload canceled", "AbortError");
          const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size));
          const chunkOffset = offset;
          offset = await sendUploadChunk(uploadId, chunkOffset, chunk, (loaded) => {
            setUploadPercent(Math.min(99, Math.round((chunkOffset + loaded) / file.size * 100)));
          }, activeRequest);
          setUploadPercent(Math.min(99, Math.round(offset / file.size * 100)));
        }
        if (cancelRequested.current) throw new DOMException("Upload canceled", "AbortError");
        setUploadCompleting(true);
        const result = await apiRequest<{ video: Video }>(`/uploads/${uploadId}/complete`, { method: "POST" });
        sessionStorage.removeItem(key);
        uploadKeyRef.current = null;
        setPendingUploadId(null);
        return result;
      } catch (error) {
        if (cancelRequested.current && uploadId) {
          try {
            await deleteUploadWhenIdle(uploadId);
            sessionStorage.removeItem(key);
            setPendingUploadId(null);
          } catch (cleanupError) {
            cancelRequested.current = false;
            throw cleanupError;
          }
        }
        throw error;
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["projects", projectId, "videos"] });
      setUploadError("");
      setUploadPercent(100);
    },
    onError: (error) => {
      if (cancelRequested.current && error instanceof DOMException && error.name === "AbortError") return;
      setUploadError(error.message);
    },
    onSettled: () => {
      activeRequest.current = null;
      setUploadCompleting(false);
      setUploadName("");
      if (!cancelRequested.current) setUploadPercent(null);
    }
  });
  const previewUrl = useMutation({
    mutationFn: (url: string) => apiRequest<UrlPreview>(`/projects/${projectId}/import-metadata`, {
      method: "POST",
      body: JSON.stringify({ sourceUrl: url })
    }),
    onSuccess: (preview) => {
      setUrlPreview(preview);
      setSourceUrl(preview.sourceUrl);
      setRightsConfirmed(false);
    },
    onError: () => setUrlPreview(null)
  });
  const importUrl = useMutation({
    mutationFn: () => {
      if (!urlPreview || !rightsConfirmed) throw new Error("Confirm that you have permission to use this video.");
      return apiRequest<{ video: Video; job: AnalysisJob }>(`/projects/${projectId}/imports`, {
        method: "POST",
        body: JSON.stringify({ sourceUrl: urlPreview.sourceUrl, rightsConfirmed: true })
      });
    },
    onSuccess: async () => {
      setUrlPreview(null);
      setSourceUrl("");
      setRightsConfirmed(false);
      await queryClient.invalidateQueries({ queryKey: videosKey });
    }
  });
  const activeJobIds = (videosQuery.data?.videos ?? [])
    .filter((video) => video.job && isActive(video.job.status))
    .map((video) => video.job!.id)
    .join(",");

  useEffect(() => {
    if (!activeJobIds) return;
    const sources = activeJobIds.split(",").map((jobId) => {
      const source = new EventSource(`${API_URL}/jobs/${jobId}/events`, { withCredentials: true });
      source.onmessage = (event) => {
        const update = JSON.parse(event.data) as { job: AnalysisJob };
        queryClient.setQueryData<ProjectVideos>(videosKey, (current) => current && ({
          videos: current.videos.map((video) => video.job?.id === jobId ? { ...video, job: update.job } : video)
        }));
        if (update.job.status === "completed" || update.job.status === "failed") {
          void queryClient.invalidateQueries({ queryKey: videosKey });
        }
      };
      source.onerror = () => {
        if (source.readyState === EventSource.CLOSED) source.close();
      };
      return source;
    });
    return () => sources.forEach((source) => source.close());
  }, [activeJobIds, projectId, queryClient]);

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      const key = `clipforge-upload:${projectId}:${file.name}:${file.size}:${file.lastModified}`;
      if (pendingUploadId && uploadKeyRef.current !== key) {
        setUploadError("Discard the current staged upload before selecting a different file.");
      } else if (limitsQuery.data && file.size > limitsQuery.data.maxUploadBytes) {
        setUploadError(`File exceeds the configured ${formatBytes(limitsQuery.data.maxUploadBytes)} upload limit.`);
      } else {
        upload.mutate(file);
      }
    }
    event.target.value = "";
  }

  function fetchUrlMetadata(value: string) {
    setUrlPreview(null);
    setRightsConfirmed(false);
    importUrl.reset();
    previewUrl.mutate(value.trim());
  }

  function pasteUrl(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text").trim();
    if (!pasted) return;
    event.preventDefault();
    setSourceUrl(pasted);
    fetchUrlMetadata(pasted);
  }

  function cancelUpload() {
    const uploadKey = uploadKeyRef.current;
    if (!upload.isPending && pendingUploadId && uploadKey) {
      void deleteUploadWhenIdle(pendingUploadId).then(() => {
        sessionStorage.removeItem(uploadKey);
        setPendingUploadId(null);
        uploadKeyRef.current = null;
        setUploadError("");
      }).catch((error: unknown) => {
        setUploadError(error instanceof Error ? error.message : "Could not cancel this upload");
      });
      return;
    }
    cancelRequested.current = true;
    activeRequest.current?.abort();
  }

  return (
    <main className="app-shell">
      <header className="app-header"><Link to="/" className="brand"><span className="brand-mark"><Clapperboard size={17} /></span>clipforge</Link><Link to="/dashboard" className="nav-link">All projects</Link></header>
      <section className="project-detail-wrap">
        <Link to="/dashboard" className="back-link"><ArrowLeft size={14} /> All projects</Link>
        <span className="section-kicker">PROJECT WORKSPACE</span>
        <h1>Your video library</h1>
        <p className="project-subtitle">Upload a video you own. Processing and storage run locally with your ClipForge setup.</p>
        <div className="ingest-grid">
        <div className="upload-panel panel">
          <div className="upload-icon"><Upload size={20} /></div>
          <strong>{upload.isPending ? "Uploading your video…" : "Add a long-form video"}</strong>
          <span>
            MP4, MOV, MKV, or WebM
            {limitsQuery.data
              ? ` · up to ${formatBytes(limitsQuery.data.maxUploadBytes)} and ${Math.floor(limitsQuery.data.maxVideoDurationSeconds / 60)} minutes`
              : " · limits configured by your local server"}
          </span>
          <label className="file-button"><Button asChild disabled={upload.isPending}><span>{pendingUploadId && !upload.isPending ? "Choose the same file to resume" : upload.isPending ? "Please wait…" : "Choose a video"}</span></Button><input type="file" accept=".mp4,.m4v,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm" onChange={selectFile} disabled={upload.isPending} /></label>
          {upload.isPending && uploadPercent !== null && (
            <div className="upload-progress" aria-live="polite">
              <div><span>{uploadName}</span><strong>{uploadPercent}%</strong></div>
              <div className="progress-track"><span style={{ width: `${uploadPercent}%` }} /></div>
            </div>
          )}
          {pendingUploadId && (
            <Button size="small" variant="secondary" onClick={cancelUpload} disabled={uploadCompleting}>
              <X size={13} /> {uploadCompleting ? "Validating media…" : upload.isPending ? "Cancel upload" : "Discard staged upload"}
            </Button>
          )}
          {uploadError && <p className="form-error" role="alert">{uploadError}</p>}
          <small className="rights-note">Only upload content you own or have permission to use. If a connection drops, choose the same file to resume.</small>
        </div>
        <div className="url-import-panel panel">
          <div className="upload-icon"><Link2 size={20} /></div>
          <strong>Or import a YouTube link</strong>
          <span>Preview the video details before importing.</span>
          <form className="url-import-form" onSubmit={(event) => {
            event.preventDefault();
            fetchUrlMetadata(sourceUrl);
          }}>
            <label htmlFor="source-url">YouTube video link</label>
            <div className="url-input-row">
              <input id="source-url" type="url" value={sourceUrl} onChange={(event) => {
                setSourceUrl(event.target.value);
                setUrlPreview(null);
                setRightsConfirmed(false);
                importUrl.reset();
              }} onPaste={pasteUrl} placeholder="https://youtu.be/…" disabled={previewUrl.isPending || importUrl.isPending} />
              <Button type="submit" variant="secondary" disabled={!sourceUrl.trim() || previewUrl.isPending || importUrl.isPending}>
                {previewUrl.isPending ? "Checking…" : "Preview link"}
              </Button>
            </div>
          </form>
          {previewUrl.isError && <p className="form-error" role="alert">{previewUrl.error.message} You can upload the video file instead.</p>}
          {urlPreview && (
            <div className="url-preview">
              <img src={urlPreview.metadata.thumbnailUrl} alt="" />
              <div>
                <strong>{urlPreview.metadata.title}</strong>
                <span>{urlPreview.metadata.channel} · {formatDuration(urlPreview.metadata.durationSeconds)} · ~{formatBytes(urlPreview.metadata.estimatedSizeBytes)}</span>
              </div>
            </div>
          )}
          {urlPreview && (
            <>
              <label className="rights-checkbox">
                <input type="checkbox" checked={rightsConfirmed} required onChange={(event) => setRightsConfirmed(event.target.checked)} />
                <span>I own this video or have permission to use it.</span>
              </label>
              <Button onClick={() => importUrl.mutate()} disabled={!rightsConfirmed || importUrl.isPending}>
                {importUrl.isPending ? "Queueing import…" : "Import video"}
              </Button>
            </>
          )}
          {importUrl.isError && <p className="form-error" role="alert">{importUrl.error.message} Upload the video file instead if the link is unavailable.</p>}
          <small className="rights-note">Private, age-restricted, geo-blocked, removed, and bot-check blocked videos are not bypassed.</small>
        </div>
        </div>
        <div className="video-list-heading"><h2>Videos</h2><span>{videosQuery.data?.videos.length ?? 0}</span></div>
        {videosQuery.isPending && <div className="empty-panel">Loading videos…</div>}
        {videosQuery.isError && <div className="empty-panel error-state">Couldn’t load videos. {videosQuery.error.message}</div>}
        {!videosQuery.isPending && !videosQuery.isError && videosQuery.data?.videos.length === 0 && <div className="empty-panel"><div className="empty-icon"><FileVideo2 size={22} /></div><strong>Your next great clip is in there.</strong><span>Upload your first video to get this project started.</span></div>}
        <div className="video-list">{videosQuery.data?.videos.map((video) => (
          <VideoCard key={video._id} video={video} queryKey={videosKey} />
        ))}</div>
      </section>
    </main>
  );
}

function VideoCard({ video, queryKey }: { video: Video; queryKey: string[] }) {
  const queryClient = useQueryClient();
  const [modelSpeed, setModelSpeed] = useState<ModelSpeed>("fast");
  const [useGeminiForScoring, setUseGeminiForScoring] = useState(false);
  const [renderStrategy, setRenderStrategy] = useState<"blur-fit" | "center-crop">("center-crop");
  const analyze = useMutation({
    mutationFn: () => apiRequest<{ job: AnalysisJob }>(`/videos/${video._id}/analyze`, {
      method: "POST",
      body: JSON.stringify({ modelSpeed })
    }),
    onSuccess: ({ job }) => updateJob(job)
  });
  const retry = useMutation({
    mutationFn: () => apiRequest<{ job: AnalysisJob }>(`/jobs/${video.job?.id}/retry`, { method: "POST" }),
    onSuccess: ({ job }) => updateJob(job)
  });
  const cancel = useMutation({
    mutationFn: () => apiRequest<{ job: AnalysisJob }>(`/jobs/${video.job?.id}/cancel`, { method: "POST" }),
    onSuccess: ({ job }) => updateJob(job)
  });
  const findClips = useMutation({
    mutationFn: () => apiRequest<{ job: AnalysisJob }>(`/videos/${video._id}/find-clips`, {
      method: "POST",
      body: JSON.stringify({ useGemini: useGeminiForScoring })
    }),
    onSuccess: ({ job }) => updateJob(job)
  });
  const recomputeTopics = useMutation({
    mutationFn: () => apiRequest<{ job: AnalysisJob }>(`/videos/${video._id}/recompute-topics`, { method: "POST" }),
    onSuccess: ({ job }) => updateJob(job)
  });
  const renderSelected = useMutation({
    mutationFn: () => apiRequest<{ jobs: AnalysisJob[]; message: string }>(`/videos/${video._id}/render-selected`, {
      method: "POST",
      body: JSON.stringify({ reframeStrategy: renderStrategy })
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    }
  });

  function updateJob(job: AnalysisJob) {
    queryClient.setQueryData<ProjectVideos>(queryKey, (current) => current && ({
      videos: current.videos.map((entry) => entry._id === video._id
        ? {
            ...entry,
            status: job.type === "find-clips" ? entry.status
              : job.status === "completed" ? (job.type === "url-import" ? "uploaded" : "ready")
                : job.status === "failed" ? "failed" : "processing",
            job
          }
        : entry)
    }));
  }

  const job = video.job;
  const canRetry = job?.status === "failed" && job.type !== "render";
  const canAnalyze = video.status === "uploaded" &&
    (!job || (job.type === "url-import" && job.status === "completed"));
  const canFindClips = video.status === "ready" && Boolean(video.analysis && video.transcript) &&
    (!job || job.type !== "find-clips" || !isActive(job.status));

  return (
    <article className="video-item">
      <div className="video-row panel">
        <span className="video-icon"><FileVideo2 size={18} /></span>
        <div className="video-name">
          <strong>{video.originalName}</strong>
          <span>
            {formatBytes(video.sizeBytes)}{video.durationSeconds ? ` · ${formatDuration(video.durationSeconds)}` : ""}
            {video.channel ? ` · ${video.channel}` : ""} · Added {new Date(video.createdAt).toLocaleDateString()}
          </span>
        </div>
        {video.analysis && <span className="video-type-tag"><Sparkles size={12} /> {video.analysis.videoType}</span>}
        {video.analysis?.topicWarning && <span className="status-tag warning-tag">{video.analysis.topicWarning}</span>}
        <span className="status-tag">{job?.status ?? video.status}</span>
        {canFindClips && (
          <>
            <label className="gemini-opt-in">
              <span><input type="checkbox" checked={useGeminiForScoring} onChange={(event) => setUseGeminiForScoring(event.target.checked)} /> Use Gemini scoring</span>
              <small>Sends clip transcript text to Google. On the free tier, Google may use it to improve its products.</small>
            </label>
            <Button size="small" onClick={() => findClips.mutate()} disabled={findClips.isPending}>
              {findClips.isPending ? "Queueing…" : "Find clips"}
            </Button>
          </>
        )}
        {video.status === "ready" && video.analysis && video.transcript && (
          <Button size="small" variant="secondary" onClick={() => recomputeTopics.mutate()} disabled={recomputeTopics.isPending || !!(job && isActive(job.status))}>
            {recomputeTopics.isPending ? "Recomputing…" : "Recompute topics"}
          </Button>
        )}
        {video.clips.some((clip) => clip.selectedForRendering) && (
          <>
            <select className="model-speed-select" value={renderStrategy} onChange={(event) => setRenderStrategy(event.target.value as "blur-fit" | "center-crop")} aria-label="Reframe strategy for selected clips">
              <option value="blur-fit">Blur-fit</option>
              <option value="center-crop">Center-crop</option>
            </select>
            <Button size="small" onClick={() => renderSelected.mutate()} disabled={renderSelected.isPending}>
              {renderSelected.isPending ? "Queueing…" : "Render selected"}
            </Button>
          </>
        )}
        {canAnalyze && (
          <>
            <select className="model-speed-select" value={modelSpeed} onChange={(event) => setModelSpeed(event.target.value as ModelSpeed)} aria-label="Transcription model speed">
              <option value="fast">Fast · base</option>
              <option value="balanced">Balanced · small</option>
            </select>
            <Button size="small" onClick={() => analyze.mutate()} disabled={analyze.isPending}>
              {analyze.isPending ? "Queueing…" : "Analyze"}
            </Button>
          </>
        )}
        {canRetry && (
          <Button size="small" variant="secondary" onClick={() => retry.mutate()} disabled={retry.isPending}>
            <RotateCw size={13} /> {retry.isPending ? "Retrying…" : job?.type === "url-import" ? "Retry import" : "Retry"}
          </Button>
        )}
        {job && isActive(job.status) && (
          <Button size="small" variant="secondary" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            <X size={13} /> {cancel.isPending ? "Cancelling…" : "Cancel"}
          </Button>
        )}
        {(analyze.isError || retry.isError || findClips.isError || recomputeTopics.isError || renderSelected.isError) && (
          <span className="form-error" role="alert">{(analyze.error ?? retry.error ?? findClips.error ?? recomputeTopics.error ?? renderSelected.error)?.message}</span>
        )}
      </div>
      {canAnalyze && video.durationSeconds && (
        <p className="transcription-estimate">
          Estimated transcription time: about {formatDuration(estimateTranscriptionSeconds(video.durationSeconds, modelSpeed))}
          {" "}({modelSpeed === "fast" ? "base" : "small"} model; actual time varies by CPU and language).
        </p>
      )}
      {job && job.type !== "render" && isActive(job.status) && (
        <div className="job-progress panel" aria-live="polite">
          <div className="job-progress-heading">
            <strong>{job.progress.message}</strong>
            <span>{job.progress.etaSeconds !== undefined ? formatEta(job.progress.etaSeconds) : `${job.progress.percent}%`}</span>
          </div>
          <div className="progress-track"><span style={{ width: `${job.progress.percent}%` }} /></div>
          <div className="job-progress-meta">
            <span>{job.progress.stage} · {job.progress.percent}%</span>
            {job.progress.completedChunks !== undefined && job.progress.totalChunks !== undefined && (
              <span>Audio chunks {job.progress.completedChunks}/{job.progress.totalChunks}</span>
            )}
            {job.attemptsMade > 0 && <span>Attempt {job.attemptsMade}/{job.maxAttempts}</span>}
          </div>
        </div>
      )}
      {job?.status === "failed" && job.type !== "render" && (
        <div className="job-error panel" role="alert">
          <strong>{job.type === "url-import" ? "Video import failed" : job.type === "find-clips" ? "Finding clips failed" : "Analysis failed"}</strong>
          <span>{job.failedReason ?? video.analysisError ?? "The worker could not finish this analysis."}</span>
        </div>
      )}
      {video.findClipsRuns?.some((run) => run.diagnostics) && (
        <section className="candidate-funnel-history" aria-label="Find clips candidate funnel">
          <h3>Why only N clips?</h3>
          {[...video.findClipsRuns]
            .filter((run) => run.diagnostics)
            .map((run) => {
              const funnel = run.diagnostics!;
              return (
                <details className="panel candidate-funnel" key={run.id}>
                  <summary>
                    {new Date(run.createdAt).toLocaleString()} · {funnel.selectedCount} selected from {funnel.candidatePoolCount ?? funnel.generatedCount} candidates
                  </summary>
                  <dl className="funnel-counts">
                    <div><dt>Windows evaluated</dt><dd>{funnel.attemptedCount ?? funnel.generatedCount}</dd></div>
                    <div><dt>Unique candidates generated</dt><dd>{funnel.generatedCount}</dd></div>
                    <div><dt>Candidate pool after cap</dt><dd>{funnel.candidatePoolCount ?? funnel.generatedCount}</dd></div>
                    <div><dt>Scored</dt><dd>{funnel.scoredCount}</dd></div>
                    <div><dt>Selected</dt><dd>{funnel.selectedCount}</dd></div>
                    {Object.entries(funnel.removalCounts).map(([reason, count]) => (
                      <div key={reason}><dt>{reason.replaceAll("-", " ")}</dt><dd>{count}</dd></div>
                    ))}
                  </dl>
                  <details className="funnel-thresholds">
                    <summary>Thresholds used</summary>
                    <dl>
                      {Object.entries(funnel.thresholds).map(([name, value]) => (
                        <div key={name}>
                          <dt>{name.replace(/[A-Z]/g, (letter) => ` ${letter}`).replace(/^./, (letter) => letter.toLocaleUpperCase())}</dt>
                          <dd>{JSON.stringify(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                  {funnel.removals.length > 0 ? (
                    <details className="funnel-removals">
                      <summary>Rejected or removed windows ({funnel.removals.length})</summary>
                      <ol>
                        {funnel.removals.map((removal, index) => (
                          <li key={`${removal.start}-${removal.end}-${removal.reason}-${index}`}>
                            <strong>{formatDuration(removal.start)}–{formatDuration(removal.end)}</strong>
                            <span>{removal.reason.replaceAll("-", " ")}: {removal.detail}</span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : <p>No candidates were removed in this run.</p>}
                </details>
              );
            })}
        </section>
      )}
      {video.analysis?.topicSegments && video.analysis.topicSegments.length > 0 && (
        <section className="panel" aria-label="Topic flow">
          <div className="clips-heading"><h3>Topic flow</h3><span>{video.analysis.topicSegments.length}</span></div>
          <ol className="topic-timeline">
            {video.analysis.topicSegments.map((segment) => (
              <li key={segment.id}>
                <time>{formatDuration(segment.start)}–{formatDuration(segment.end)}</time>
                <div>
                  <strong>{segment.label}</strong>
                  <small>Depth {segment.boundaryDepthScore !== undefined ? segment.boundaryDepthScore.toFixed(3) : "—"}</small>
                  <p>{segment.text}</p>
                  {segment.contextBefore && segment.contextBefore.length > 0 && (
                    <p className="topic-context"><span>Before:</span> {segment.contextBefore.join(" ")}</p>
                  )}
                  {segment.contextAfter && segment.contextAfter.length > 0 && (
                    <p className="topic-context"><span>After:</span> {segment.contextAfter.join(" ")}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
      {video.status === "ready" && video.analysis && video.transcript && (
        <section className="clips-section" aria-label="Clips">
          <div className="clips-heading"><h3>Clips</h3><span>{video.clips.length}</span></div>
          <p className="score-guidance">Scores are guidance only, not a promise that a clip will go viral. Only clips you select are rendered.</p>
          {video.clips.length === 0 ? (
            <div className="clips-empty panel" role="status">
              <strong>{job?.type === "find-clips" && isActive(job.status) ? "Finding and scoring clips…" : "No clips yet"}</strong>
              <span>{job?.type === "find-clips" && isActive(job.status) ? "Progress appears above." : "Choose Find clips to build a scored clips grid."}</span>
            </div>
          ) : (
            <div className="clips-grid">
              {[...video.clips]
                .sort((left, right) => (right.score ?? -1) - (left.score ?? -1) || left.start - right.start)
                .map((clip) => (
                  <ClipCard
                    key={clip._id}
                    videoId={video._id}
                    videoTitle={video.sourceTitle ?? video.originalName}
                    videoType={video.analysis?.videoType ?? video.detectedType ?? "other"}
                    whisperLanguage={video.transcript?.language}
                    sourceIsUrl={video.source === "url"}
                    sourceUrl={video.sourceUrl}
                    channel={video.channel}
                    clip={clip}
                    queryKey={queryKey}
                    videoJob={video.job}
                  />
                ))}
            </div>
          )}
        </section>
      )}
      {video.transcript && (
        <details className="transcript-panel panel">
          <summary><span>Transcript</span><small>{video.transcript.wordCount.toLocaleString()} words · {video.transcript.language}</small></summary>
          <div className="transcript-segments">
            {video.transcript.segments.map((segment, index) => (
              <p key={`${segment.start}-${index}`}><time>{formatDuration(segment.start)}</time>{segment.text}</p>
            ))}
          </div>
        </details>
      )}
    </article>
  );
}

function ClipCard({
  videoId,
  videoTitle,
  videoType,
  whisperLanguage,
  sourceIsUrl,
  sourceUrl,
  channel,
  clip,
  queryKey,
  videoJob
}: {
  videoId: string;
  videoTitle: string;
  videoType: string;
  whisperLanguage: string | undefined;
  sourceIsUrl: boolean;
  sourceUrl: string | undefined;
  channel: string | undefined;
  clip: ClipCandidate;
  queryKey: string[];
  videoJob: AnalysisJob | null;
}) {
  const queryClient = useQueryClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const playRequested = useRef(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [loop, setLoop] = useState(true);
  const [previewError, setPreviewError] = useState("");
  const [reframeStrategy, setReframeStrategy] = useState<"blur-fit" | "center-crop">(clip.renderSettings?.reframeStrategy ?? "center-crop");
  const [captionPreviewJobId, setCaptionPreviewJobId] = useState<string | null>(null);
  const renderedVideoRef = useRef<HTMLVideoElement>(null);
  const [renderMuted, setRenderMuted] = useState(false);
  const [renderVolume, setRenderVolume] = useState(100);

  const updateClip = useMutation({
    mutationFn: (updates: Partial<Pick<ClipCandidate, "start" | "end" | "selectedForRendering" | "captionStyle" | "cleanupCaptionFillers">> | {
      nudge: { edge: "start" | "end"; direction: -1 | 1 };
    }) =>
      apiRequest<{ clip: ClipCandidate }>(`/clips/${clip._id}`, {
        method: "PATCH",
        body: JSON.stringify(updates)
      }),
    onSuccess: ({ clip: updatedClip }) => {
      queryClient.setQueryData<ProjectVideos>(queryKey, (current) => current && ({
        videos: current.videos.map((video) => video._id === videoId
          ? { ...video, clips: video.clips.map((entry) => entry._id === updatedClip._id ? updatedClip : entry) }
          : video)
      }));
    }
  });
  const discardClip = useMutation({
    mutationFn: () => apiRequest<void>(`/clips/${clip._id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.setQueryData<ProjectVideos>(queryKey, (current) => current && ({
        videos: current.videos.map((video) => video._id === videoId
          ? { ...video, clips: video.clips.filter((entry) => entry._id !== clip._id) }
          : video)
      }));
    }
  });
  const render = useMutation({
    mutationFn: () => apiRequest<{ job?: AnalysisJob; renderStatus?: string }>(`/clips/${clip._id}/render`, {
      method: "POST",
      body: JSON.stringify({ reframeStrategy })
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    }
  });
  const captionPreview = useMutation({
    mutationFn: () => apiRequest<{ job: AnalysisJob }>(`/clips/${clip._id}/render-preview`, {
      method: "POST",
      body: JSON.stringify({})
    }),
    onSuccess: ({ job }) => setCaptionPreviewJobId(job.id)
  });
  const captionPreviewJobQuery = useQuery({
    queryKey: ["caption-preview-job", captionPreviewJobId],
    queryFn: () => apiRequest<{ job: AnalysisJob }>(`/jobs/${captionPreviewJobId}`),
    enabled: captionPreviewJobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.job.status;
      return status === "completed" || status === "failed" ? false : 1_000;
    }
  });
  useEffect(() => {
    if (captionPreviewJobQuery.data?.job.status === "completed") {
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [captionPreviewJobQuery.data?.job.status, queryClient, queryKey]);
  const retryRender = useMutation({
    mutationFn: () => apiRequest<{ job: AnalysisJob }>(`/jobs/${clip.renderJobId}/retry`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    }
  });
  const deleteRender = useMutation({
    mutationFn: () => apiRequest<void>(`/clips/${clip._id}/render`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    }
  });

  function startPreview() {
    setPreviewError("");
    if (previewOpen) {
      playRequested.current = false;
      videoRef.current?.pause();
      setIsPlaying(false);
      setPreviewLoading(false);
      setPreviewOpen(false);
      return;
    }
    playRequested.current = true;
    setPreviewLoading(true);
    setPreviewOpen(true);
  }

  async function togglePlayback() {
    const player = videoRef.current;
    if (!player) {
      playRequested.current = true;
      setPreviewLoading(true);
      setPreviewOpen(true);
      return;
    }
    if (player.readyState === 0) {
      playRequested.current = true;
      setPreviewLoading(true);
      return;
    }
    if (!player.paused) {
      player.pause();
      return;
    }
    if (player.currentTime < clip.start || player.currentTime >= clip.end) {
      player.currentTime = clip.start;
    }
    try {
      playRequested.current = true;
      await player.play();
    } catch (error) {
      playRequested.current = false;
      setPreviewError(error instanceof Error ? error.message : "Could not play this preview");
    }
  }

  function nudge(edge: "start" | "end", direction: -1 | 1) {
    updateClip.mutate({ nudge: { edge, direction } });
  }

  const errorMessage = updateClip.error?.message ?? discardClip.error?.message ??
    render.error?.message ?? retryRender.error?.message ?? deleteRender.error?.message ??
    captionPreview.error?.message ?? captionPreviewJobQuery.error?.message;
  const renderStatus = clip.renderStatus ?? "not-rendered";
  const renderProgress = clip.renderProgress;
  const renderJobActive = videoJob?.type === "render" && videoJob.id === clip.renderJobId && isActive(videoJob.status);
  useEffect(() => {
    const player = renderedVideoRef.current;
    if (!player) return;
    player.muted = renderMuted;
    player.volume = renderMuted ? 0 : renderVolume / 100;
  }, [renderMuted, renderVolume, renderStatus, clip._id]);

  return (
    <article className="clip-card panel">
      <header className="clip-card-heading">
        <div className="clip-score-badge">
          <strong>{clip.score !== undefined ? clip.score : "—"}</strong><span>/100</span>
        </div>
        <div className="clip-card-timing">
          <strong>{formatDuration(clip.start)}–{formatDuration(clip.end)}</strong>
          <span>{clip.scoringMode ?? "Not scored · run Find clips again"}</span>
        </div>
        <span className={`render-status render-status-${renderStatus}`}>
          {renderStatus === "not-rendered" ? "Not rendered" : renderStatus === "ready" ? "Ready" : renderStatus === "failed" ? "Failed" : "Rendering"}
        </span>
      </header>
      {clip.topicLabel && <p className="clip-topic-label">Topic: {clip.topicLabel}</p>}
      {clip.boundaryQualityScore !== undefined && (
        <p className="clip-boundary-quality">
          Boundary quality: <strong>{clip.boundaryQualityScore}/100</strong>
          {clip.boundaryQualityReason ? ` · ${clip.boundaryQualityReason}` : ""}
        </p>
      )}
      {clip.boundaryChanges && clip.boundaryChanges.length > 0 && (
        <ul className="clip-boundary-changes" aria-label="Automatic boundary adjustments">
          {clip.boundaryChanges.map((change, index) => <li key={`${index}-${change}`}>{change}</li>)}
        </ul>
      )}
      {clip.standaloneCheck && (
        <p className={`clip-standalone-check ${clip.standaloneCheck.standsAlone ? "is-standalone" : "needs-context"}`}>
          Stands alone: {clip.standaloneCheck.standsAlone ? "Yes" : "Needs context"} · {clip.standaloneCheck.reason}
          <span> ({clip.standaloneCheck.provider}; rules {clip.standaloneCheck.rulesPass ? "pass" : "flag"})</span>
        </p>
      )}
      <p className="clip-transcript">{clip.transcriptText || "Transcript text is unavailable for this trim."}</p>
      <p className="clip-reason">{clip.reason}</p>
      {clip.breakdown ? (
        <dl className="clip-score-breakdown">
          <div><dt>Hook</dt><dd>{clip.breakdown.hookStrength.score} · {clip.breakdown.hookStrength.reason}</dd></div>
          <div><dt>Emotion</dt><dd>{clip.breakdown.emotionalPeak.score} · {clip.breakdown.emotionalPeak.reason}</dd></div>
          <div><dt>Clarity</dt><dd>{clip.breakdown.standaloneClarity.score} · {clip.breakdown.standaloneClarity.reason}</dd></div>
          <div><dt>Pacing</dt><dd>{clip.breakdown.pacing.score} · {clip.breakdown.pacing.reason}</dd></div>
          <div><dt>Payoff</dt><dd>{clip.breakdown.payoff.score} · {clip.breakdown.payoff.reason}</dd></div>
        </dl>
      ) : <p className="clip-reason">Score breakdown unavailable. Run Find clips again to rescore this candidate.</p>}
      {clip.factorBreakdown && (
        <dl className="clip-factor-breakdown" aria-label="Normalized multi-factor ranking">
          {Object.entries(clip.factorBreakdown).map(([factor, value]) => (
            <div key={factor}>
              <dt>{factor.replace(/[A-Z]/g, (letter) => ` ${letter}`).replace(/^./, (letter) => letter.toLocaleUpperCase())}</dt>
              <dd><strong>{value.score}</strong> · weight {(value.weight * 100).toFixed(0)}% · {value.reason}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="clip-trim-controls" aria-label="Nudge clip trim by half a second; saved to nearest word boundary">
        <span>Start</span>
        <Button size="small" variant="secondary" disabled={updateClip.isPending || renderStatus === "rendering"} onClick={() => nudge("start", -1)} aria-label="Move start earlier by 0.5 seconds">−0.5s</Button>
        <Button size="small" variant="secondary" disabled={updateClip.isPending || renderStatus === "rendering"} onClick={() => nudge("start", 1)} aria-label="Move start later by 0.5 seconds">+0.5s</Button>
        <span>End</span>
        <Button size="small" variant="secondary" disabled={updateClip.isPending || renderStatus === "rendering"} onClick={() => nudge("end", -1)} aria-label="Move end earlier by 0.5 seconds">−0.5s</Button>
        <Button size="small" variant="secondary" disabled={updateClip.isPending || renderStatus === "rendering"} onClick={() => nudge("end", 1)} aria-label="Move end later by 0.5 seconds">+0.5s</Button>
      </div>

      {previewOpen && (
        <div className="clip-preview">
          <video
            ref={videoRef}
            src={`${API_URL}/videos/${videoId}/stream`}
            crossOrigin="use-credentials"
            preload="metadata"
            playsInline
            onLoadedMetadata={(event) => {
              const player = event.currentTarget;
              setPreviewLoading(false);
              player.currentTime = clip.start;
              if (playRequested.current) {
                void player.play().catch((error: unknown) => {
                  playRequested.current = false;
                  setPreviewError(error instanceof Error ? error.message : "Could not play this preview");
                });
              }
            }}
            onTimeUpdate={(event) => {
              const player = event.currentTarget;
              if (player.currentTime < clip.end) return;
              if (loop) {
                player.currentTime = clip.start;
                void player.play().catch((error: unknown) => {
                  setPreviewError(error instanceof Error ? error.message : "Could not loop this preview");
                });
              } else {
                player.currentTime = clip.end;
                player.pause();
              }
            }}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onError={() => {
              setPreviewLoading(false);
              setPreviewError("Could not load the source video preview. Try refreshing the page.");
            }}
          />
          <div className="clip-preview-controls">
            <Button size="small" onClick={() => void togglePlayback()}>
              {isPlaying ? <Pause size={13} /> : <Play size={13} />}
              {isPlaying ? "Pause" : "Play"}
            </Button>
            <label><input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} /> Loop</label>
            <span>Preview plays only {formatDuration(clip.start)}–{formatDuration(clip.end)}</span>
            {previewLoading && <span role="status">Loading source preview…</span>}
          </div>
        </div>
      )}

      {renderStatus === "rendering" && (
        <div className="render-progress" aria-live="polite">
          <div className="render-progress-heading">
            <strong>{renderProgress?.message ?? "Waiting for a render worker"}</strong>
            <span>{renderProgress?.etaSeconds !== undefined ? formatEta(renderProgress.etaSeconds) : `${renderProgress?.percent ?? 0}%`}</span>
          </div>
          <div className="progress-track"><span style={{ width: `${renderProgress?.percent ?? 0}%` }} /></div>
          {renderJobActive && <span className="render-job-attempt">Render job · attempt {videoJob.attemptsMade}/{videoJob.maxAttempts}</span>}
        </div>
      )}
      {renderStatus === "failed" && (
        <div className="render-error panel" role="alert">
          <strong>Render failed</strong>
          <span>{clip.renderError ?? "The worker could not finish this clip render."}</span>
          {clip.renderJobId && (
            <Button size="small" variant="secondary" onClick={() => retryRender.mutate()} disabled={retryRender.isPending}>
              <RotateCw size={13} /> {retryRender.isPending ? "Retrying…" : "Retry render"}
            </Button>
          )}
        </div>
      )}
      {renderStatus === "ready" && (
        <div className="render-output">
          <video
            ref={renderedVideoRef}
            src={`${API_URL}/clips/${clip._id}/render/stream`}
            crossOrigin="use-credentials"
            controls
            playsInline
            preload="metadata"
            muted={renderMuted}
            aria-label={`Rendered clip ${formatDuration(clip.start)} to ${formatDuration(clip.end)}`}
            onLoadedMetadata={(event) => {
              event.currentTarget.muted = renderMuted;
              event.currentTarget.volume = renderMuted ? 0 : renderVolume / 100;
            }}
            onPlay={(event) => {
              event.currentTarget.muted = renderMuted;
              event.currentTarget.volume = renderMuted ? 0 : renderVolume / 100;
            }}
          />
          <div className="render-output-actions">
            <Button
              size="small"
              variant="ghost"
              aria-label={renderMuted ? "Unmute rendered clip audio" : "Mute rendered clip audio"}
              onClick={() => {
                const player = renderedVideoRef.current;
                const nextMuted = !renderMuted;
                setRenderMuted(nextMuted);
                if (player) {
                  player.muted = nextMuted;
                  player.volume = nextMuted ? 0 : renderVolume / 100;
                }
              }}
            >
              {renderMuted ? <VolumeX size={13} /> : <Volume2 size={13} />}
              {renderMuted ? "Unmute audio" : "Mute audio"}
            </Button>
            <label className="caption-cleanup-toggle" aria-label="Rendered clip volume">
              Volume
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={renderVolume}
                onChange={(event) => {
                  const nextVolume = Number(event.target.value);
                  setRenderVolume(nextVolume);
                  if (renderedVideoRef.current) {
                    renderedVideoRef.current.volume = nextVolume / 100;
                    renderedVideoRef.current.muted = nextVolume === 0;
                  }
                  setRenderMuted(nextVolume === 0);
                }}
              />
              <span>{renderVolume}%</span>
            </label>
            <a className="render-download" href={`${API_URL}/clips/${clip._id}/render/download`}>
              Download MP4
            </a>
            <Button size="small" variant="ghost" onClick={() => deleteRender.mutate()} disabled={deleteRender.isPending}>
              <Trash2 size={13} /> {deleteRender.isPending ? "Deleting…" : "Delete render"}
            </Button>
          </div>
          {clip.renderSettings && <span className="render-settings-label">1080×1920 · {clip.renderSettings.reframeStrategy} · rendered {clip.renderedAt ? new Date(clip.renderedAt).toLocaleString() : ""}</span>}
        </div>
      )}
      {(clip.selectedForRendering || renderStatus === "ready") && (
        <MetadataPanel
          clipId={clip._id}
          clip={clip}
          videoTitle={videoTitle}
          videoType={videoType}
          whisperLanguage={whisperLanguage}
          sourceIsUrl={sourceIsUrl}
          sourceUrl={sourceUrl}
          channel={channel}
          queryKey={queryKey}
        />
      )}
      {(previewError || errorMessage) && <p className="form-error clip-card-error" role="alert">{previewError || errorMessage}</p>}
      {updateClip.isPending && <span className="clip-save-status" role="status">Saving clip settings…</span>}
      <footer className="clip-card-actions">
        <Button size="small" variant="secondary" onClick={startPreview}>
          <Play size={13} /> {previewOpen ? "Close preview" : "Preview"}
        </Button>
        <select className="render-strategy-select" value={reframeStrategy} onChange={(event) => setReframeStrategy(event.target.value as "blur-fit" | "center-crop")} aria-label="Reframe strategy for this clip" disabled={renderStatus === "rendering"}>
          <option value="blur-fit">Blur-fit</option>
          <option value="center-crop">Center-crop</option>
        </select>
        <select
          className="render-strategy-select"
          value={clip.captionStyle ?? "clean"}
          onChange={(event) => updateClip.mutate({ captionStyle: event.target.value as CaptionStyle })}
          aria-label="Caption style for this clip"
          disabled={updateClip.isPending || renderStatus === "rendering" || captionPreview.isPending ||
            (captionPreviewJobQuery.data?.job.status === "queued" || captionPreviewJobQuery.data?.job.status === "processing")}
        >
          {CAPTION_STYLES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select>
        <label className="caption-cleanup-toggle">
          <input
            type="checkbox"
            checked={clip.cleanupCaptionFillers ?? true}
            disabled={updateClip.isPending || renderStatus === "rendering" || captionPreview.isPending ||
              (captionPreviewJobQuery.data?.job.status === "queued" || captionPreviewJobQuery.data?.job.status === "processing")}
            onChange={(event) => updateClip.mutate({ cleanupCaptionFillers: event.target.checked })}
          />
          Clean fillers
        </label>
        <Button
          size="small"
          variant="secondary"
          onClick={() => captionPreview.mutate()}
          disabled={updateClip.isPending || captionPreview.isPending || renderStatus === "rendering" ||
            captionPreviewJobQuery.data?.job.status === "queued" ||
            captionPreviewJobQuery.data?.job.status === "processing"}
        >
          {updateClip.isPending
            ? "Saving settings…"
            : captionPreview.isPending ||
            captionPreviewJobQuery.data?.job.status === "queued" ||
            captionPreviewJobQuery.data?.job.status === "processing"
            ? "Rendering preview…"
            : "Preview style (5s)"}
        </Button>
        {renderStatus !== "ready" && renderStatus !== "failed" && (
          <Button size="small" onClick={() => render.mutate()} disabled={!clip.selectedForRendering || renderStatus === "rendering" || render.isPending}>
            {render.isPending ? "Queueing…" : "Render"}
          </Button>
        )}
        <label className="render-selection">
          <input
            type="checkbox"
            checked={clip.selectedForRendering ?? false}
            disabled={updateClip.isPending || renderStatus === "rendering"}
            onChange={(event) => updateClip.mutate({ selectedForRendering: event.target.checked })}
          />
          Selected for rendering
        </label>
        <Button size="small" variant="ghost" disabled={discardClip.isPending || renderStatus === "rendering"} onClick={() => discardClip.mutate()}>
          <Trash2 size={13} /> {discardClip.isPending ? "Discarding…" : "Discard"}
        </Button>
      </footer>
      {captionPreviewJobQuery.data?.job.status === "processing" && (
        <div className="caption-preview-progress" role="status">
          {captionPreviewJobQuery.data.job.progress.message} · {captionPreviewJobQuery.data.job.progress.percent}%
        </div>
      )}
      {captionPreviewJobQuery.data?.job.status === "failed" && (
        <p className="form-error clip-card-error" role="alert">
          Caption preview failed: {captionPreviewJobQuery.data.job.failedReason ?? "The worker could not finish the preview."}
        </p>
      )}
      {captionPreviewJobQuery.data?.job.status === "completed" && (
        <div className="render-output caption-preview-output">
          <strong>5-second {clip.captionStyle ?? "clean"} caption preview</strong>
          <video
            key={captionPreviewJobId}
            src={`${API_URL}/clips/${clip._id}/render/preview?job=${captionPreviewJobId}`}
            crossOrigin="use-credentials"
            controls
            playsInline
            preload="metadata"
            aria-label="Five-second caption style preview"
          />
        </div>
      )}
    </article>
  );
}

function MetadataPanel({
  clipId,
  clip,
  videoTitle,
  videoType,
  whisperLanguage,
  sourceIsUrl,
  sourceUrl,
  channel,
  queryKey
}: {
  clipId: string;
  clip: ClipCandidate;
  videoTitle: string;
  videoType: string;
  whisperLanguage: string | undefined;
  sourceIsUrl: boolean;
  sourceUrl: string | undefined;
  channel: string | undefined;
  queryKey: string[];
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ClipMetadataDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [copyError, setCopyError] = useState("");
  const metadata = clip.metadata;
  const generationStatus = metadata?.generationStatus ?? "idle";
  const isGenerating = ["queued", "processing", "retrying"].includes(generationStatus);

  useEffect(() => {
    if (!dirty) {
      setDraft(metadata?.result ? {
        result: metadata.result,
        language: metadata.language,
        tone: metadata.tone,
        includeOriginalCredit: metadata.includeOriginalCredit,
        useGemini: metadata.useGemini
      } : {
        result: null,
        language: "same",
        tone: "curious",
        includeOriginalCredit: sourceIsUrl,
        useGemini: false
      });
    }
  }, [metadata, dirty, sourceIsUrl]);

  const generate = useMutation({
    mutationFn: () => apiRequest<{ job: AnalysisJob }>(`/clips/${clipId}/metadata/generate`, {
      method: "POST",
      body: JSON.stringify({
        language: draft?.language ?? "same",
        tone: draft?.tone ?? "curious",
        includeOriginalCredit: sourceIsUrl && (draft?.includeOriginalCredit ?? true),
        useGemini: draft?.useGemini ?? false
      })
    }),
    onSuccess: async () => {
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey });
    }
  });
  const save = useMutation({
    mutationFn: () => {
      if (!draft?.result) throw new Error("Generate metadata before saving edits");
      return apiRequest<{ metadata: ClipMetadataState }>(`/clips/${clipId}/metadata`, {
        method: "PATCH",
        body: JSON.stringify({
          result: draft.result,
          language: draft.language,
          tone: draft.tone,
          includeOriginalCredit: sourceIsUrl && draft.includeOriginalCredit,
          useGemini: draft.useGemini
        })
      });
    },
    onSuccess: async () => {
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey });
    }
  });
  const retry = useMutation({
    mutationFn: () => apiRequest<{ job: AnalysisJob }>(`/jobs/${metadata?.generationJobId}/retry`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    }
  });

  function changeDraft(update: (current: ClipMetadataDraft) => ClipMetadataDraft) {
    setDraft((current) => current ? update(current) : current);
    setDirty(true);
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyError("");
    } catch (error) {
      setCopyError(error instanceof Error ? `Could not copy: ${error.message}` : "Could not copy this field");
    }
  }

  function counter(value: string, limit: number) {
    return <span className={`metadata-counter${value.length > limit ? " over-limit" : ""}`}>{value.length}/{limit}</span>;
  }

  const result = draft?.result;
  const errorMessage = generate.error?.message ?? save.error?.message ?? retry.error?.message ?? copyError;
  const creditLine = sourceIsUrl && sourceUrl
    ? `Original video: ${channel ? `${channel} · ` : ""}${sourceUrl}`
    : "";
  const youtubeAll = result
    ? `YouTube Shorts\nTitle: ${result.youtube.titleVariants[result.youtube.selectedTitleIndex]}\n\nDescription:\n${result.youtube.description}\n\nTags: ${result.youtube.tags.join(", ")}`
    : "";

  return (
    <section className="metadata-panel" aria-label="Clip metadata">
      <header className="metadata-heading">
        <div>
          <strong>Metadata</strong>
          {metadata?.provider && <span className={`metadata-mode metadata-mode-${metadata.provider.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>{metadata.provider}</span>}
        </div>
        <span>Titles and captions are grounded in the clip transcript.</span>
      </header>
      <div className="metadata-options">
        <label>
          Output language
          <select
            value={draft?.language ?? "same"}
            onChange={(event) => changeDraft((current) => ({ ...current, language: event.target.value as MetadataOptions["language"] }))}
            disabled={isGenerating}
          >
            <option value="same">Same language as the video</option>
            <option value="english">English</option>
          </select>
        </label>
        <label className="gemini-opt-in">
          <span>
            <input
              type="checkbox"
              checked={draft?.useGemini ?? false}
              onChange={(event) => changeDraft((current) => ({ ...current, useGemini: event.target.checked }))}
              disabled={isGenerating}
            />
            Allow Gemini for this clip
          </span>
          <small>Sends clip transcript text to Google. On the free tier, Google may use it to improve its products.</small>
        </label>
        <label>
          Tone for regeneration
          <select
            value={draft?.tone ?? "curious"}
            onChange={(event) => changeDraft((current) => ({ ...current, tone: event.target.value as MetadataOptions["tone"] }))}
            disabled={isGenerating}
          >
            <option value="curious">More curious</option>
            <option value="direct">More direct</option>
            <option value="informative">More informative</option>
          </select>
        </label>
        {sourceIsUrl && (
          <label className="metadata-credit-toggle">
            <input
              type="checkbox"
              checked={draft?.includeOriginalCredit ?? true}
              onChange={(event) => changeDraft((current) => ({ ...current, includeOriginalCredit: event.target.checked }))}
              disabled={isGenerating}
            />
            Include original-video credit
          </label>
        )}
      </div>
      {metadata?.trendSignals && (
        <details className="trend-signals-panel" open>
          <summary>
            <span>Trend signals</span>
            <span className={`trend-badge trend-badge-${metadata.trendSignals.mode}`}>{metadata.trendSignals.badge}</span>
          </summary>
          <p className="trend-guidance">Based on recent top-ranking videos for these keywords. Guidance only.</p>
          <div className="trend-grid">
            <div><strong>Queries</strong><ul>{metadata.trendSignals.queries.map((query) => <li key={query}>{query}</li>)}</ul></div>
            <div><strong>Top keywords</strong><p>{metadata.trendSignals.topKeywords.join(" · ") || "None"}</p></div>
            <div><strong>Common hashtags</strong><p>{metadata.trendSignals.commonHashtags.join(" ") || "None"}</p></div>
            <div><strong>Quota</strong><p>{metadata.trendSignals.quotaUsedToday} used · {metadata.trendSignals.quotaRemaining} remaining</p></div>
            <div><strong>Region / language</strong><p>{metadata.trendSignals.regionCode} / {metadata.trendSignals.relevanceLanguage}</p></div>
            <div><strong>Fetched</strong><p>{new Date(metadata.trendSignals.fetchedAt).toLocaleString()}</p></div>
          </div>
          {metadata.trendSignals.samples.length > 0 && (
            <ul className="trend-samples">
              {metadata.trendSignals.samples.slice(0, 8).map((sample) => (
                <li key={sample.videoId}>
                  <a href={sample.url} target="_blank" rel="noreferrer">{sample.title}</a>
                  <span>{sample.viewCount.toLocaleString()} views</span>
                </li>
              ))}
            </ul>
          )}
          {metadata.trendSignals.fallbackReason && <p className="trend-fallback">{metadata.trendSignals.fallbackReason}</p>}
        </details>
      )}
      <div className="metadata-actions">
        <Button size="small" onClick={() => generate.mutate()} disabled={generate.isPending || isGenerating}>
          {generate.isPending ? "Queueing…" : result ? "Regenerate metadata" : "Generate metadata"}
        </Button>
        {result && (
          <Button size="small" variant="secondary" onClick={() => save.mutate()} disabled={!dirty || save.isPending || isGenerating}>
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        )}
      </div>
      {isGenerating && (
        <div className="metadata-progress" aria-live="polite">
          <div className="metadata-progress-heading">
            <strong>{metadata?.generationProgress?.message ?? "Waiting for the metadata worker to start"}</strong>
            <span>{metadata?.generationProgress?.etaSeconds !== undefined
              ? formatEta(metadata.generationProgress.etaSeconds)
              : `${metadata?.generationProgress?.percent ?? 0}%`}</span>
          </div>
          <div className="progress-track"><span style={{ width: `${metadata?.generationProgress?.percent ?? 0}%` }} /></div>
        </div>
      )}
      {metadata?.fallbackReason && (
        <p className="metadata-fallback" role="status">
          Provider fallback: {metadata.fallbackReason}
        </p>
      )}
      {metadata?.warnings && Object.keys(metadata.warnings).length > 0 && (
        <div className="metadata-warning" role="status">
          <span className="metadata-warning-badge">Review wording</span>
          {Object.entries(metadata.warnings).map(([field, messages]) => (
            <span key={field}>{field}: {messages.join("; ")}</span>
          ))}
        </div>
      )}
      {draft?.language === "same" && whisperLanguage && transcriptScriptMismatch(whisperLanguage, clip.transcriptText) && (
        <p className="metadata-language-note" role="note">
          Whisper detected {whisperLanguage}, but this clip&apos;s transcript uses a different writing script. “Same language” follows the transcript text.
        </p>
      )}
      {generationStatus === "failed" && (
        <div className="metadata-error" role="alert">
          <span>{metadata?.generationError ?? "Metadata generation failed."}</span>
          {metadata?.generationJobId && (
            <Button size="small" variant="secondary" onClick={() => retry.mutate()} disabled={retry.isPending}>
              <RotateCw size={13} /> {retry.isPending ? "Retrying…" : "Retry generation"}
            </Button>
          )}
        </div>
      )}
      {result ? (
        <div className="metadata-platforms">
          <section className="metadata-platform">
            <header><h4>YouTube Shorts</h4><Button size="small" variant="ghost" onClick={() => void copy(youtubeAll)}>Copy all</Button></header>
            {result.youtube.titleVariants.map((title, index) => (
              <div className="metadata-field" key={`title-${index}`}>
                <label htmlFor={`${clipId}-title-${index}`}>
                  <input
                    type="radio"
                    name={`${clipId}-selected-title`}
                    checked={result.youtube.selectedTitleIndex === index}
                    onChange={() => changeDraft((current) => current.result ? ({
                      ...current,
                      result: { ...current.result, youtube: { ...current.result.youtube, selectedTitleIndex: index as 0 | 1 | 2 } }
                    }) : current)}
                    disabled={isGenerating}
                  />
                  Title variant {index + 1}{result.youtube.selectedTitleIndex === index ? " · selected" : ""}
                </label>
                <div className="metadata-edit-row">
                  <input
                    id={`${clipId}-title-${index}`}
                    value={title}
                    maxLength={PLATFORM_LIMITS.youtubeShorts.titleCharacters}
                    onChange={(event) => changeDraft((current) => current.result ? ({
                      ...current,
                      result: {
                        ...current.result,
                        youtube: {
                          ...current.result.youtube,
                          titleVariants: current.result.youtube.titleVariants.map((entry, entryIndex) =>
                            entryIndex === index ? event.target.value : entry) as [string, string, string]
                        }
                      }
                    }) : current)}
                    disabled={isGenerating}
                  />
                  {counter(title, PLATFORM_LIMITS.youtubeShorts.titleCharacters)}
                  <Button size="small" variant="ghost" onClick={() => void copy(title)}>Copy</Button>
                </div>
              </div>
            ))}
            <div className="metadata-field">
              <label htmlFor={`${clipId}-youtube-description`}>Description</label>
              <textarea
                id={`${clipId}-youtube-description`}
                value={result.youtube.description}
                maxLength={PLATFORM_LIMITS.youtubeShorts.descriptionCharacters}
                rows={7}
                onChange={(event) => changeDraft((current) => current.result ? ({
                  ...current,
                  result: { ...current.result, youtube: { ...current.result.youtube, description: event.target.value } }
                }) : current)}
                disabled={isGenerating}
              />
              <div className="metadata-field-footer">
                {counter(result.youtube.description, PLATFORM_LIMITS.youtubeShorts.descriptionCharacters)}
                <Button size="small" variant="ghost" onClick={() => void copy(result.youtube.description)}>Copy</Button>
              </div>
            </div>
            <div className="metadata-field">
              <label htmlFor={`${clipId}-youtube-tags`}>Tags (comma-separated)</label>
              <textarea
                id={`${clipId}-youtube-tags`}
                value={result.youtube.tags.join(", ")}
                maxLength={PLATFORM_LIMITS.youtubeShorts.totalTagCharacters}
                rows={3}
                onChange={(event) => changeDraft((current) => current.result ? ({
                  ...current,
                  result: {
                    ...current.result,
                    youtube: {
                      ...current.result.youtube,
                      tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean)
                    }
                  }
                }) : current)}
                disabled={isGenerating}
              />
              <div className="metadata-field-footer">
                <span>{result.youtube.tags.length} tags · {result.youtube.tags.reduce((sum, tag) => sum + tag.length + 1, -1)}/{PLATFORM_LIMITS.youtubeShorts.totalTagCharacters}</span>
                <Button size="small" variant="ghost" onClick={() => void copy(result.youtube.tags.join(", "))}>Copy</Button>
              </div>
              <small className="metadata-tag-provenance">
                {metadata?.trendSignals?.mode === "online"
                  ? `Sources: trend tags when matching trend keywords; transcript otherwise. Trend keywords: ${metadata.trendSignals.topKeywords.slice(0, 5).join(", ") || "none"}`
                  : "Source: transcript and offline keyword extraction (trend data unavailable)"}
              </small>
            </div>
            <div className="metadata-field">
              <label htmlFor={`${clipId}-youtube-hashtags`}>Hashtags</label>
              <div className="metadata-edit-row">
                <input
                  id={`${clipId}-youtube-hashtags`}
                  value={result.youtube.hashtags.join(" ")}
                  onChange={(event) => {
                    const hashtags = event.target.value.split(/\s+/).filter(Boolean);
                    changeDraft((current) => {
                      if (!current.result) return current;
                      const oldHashtags = new Set(current.result.youtube.hashtags);
                      const lines = current.result.youtube.description.split(/\r?\n/).filter((line) =>
                        !line.trim().split(/\s+/).some((word) => oldHashtags.has(word))
                      );
                      const credit = lines.find((line) => line.startsWith("Original video:"));
                      const body = lines.filter((line) => line !== credit).join("\n").trimEnd();
                      const description = `${body}\n\n${hashtags.join(" ")}${credit ? `\n${credit}` : ""}`;
                      return {
                        ...current,
                        result: {
                          ...current.result,
                          youtube: { ...current.result.youtube, hashtags, description }
                        }
                      };
                    });
                  }}
                  disabled={isGenerating}
                />
                <Button size="small" variant="ghost" onClick={() => void copy(result.youtube.hashtags.join(" "))}>Copy</Button>
              </div>
            </div>
          </section>
          <section className="metadata-platform">
            <header><h4>Instagram Reels</h4><Button size="small" variant="ghost" onClick={() => void copy(result.instagramReels.caption)}>Copy all</Button></header>
            <div className="metadata-field">
              <label htmlFor={`${clipId}-instagram-caption`}>Caption</label>
              <textarea
                id={`${clipId}-instagram-caption`}
                value={result.instagramReels.caption}
                maxLength={PLATFORM_LIMITS.instagramReels.captionCharacters}
                rows={4}
                onChange={(event) => changeDraft((current) => current.result ? ({
                  ...current,
                  result: { ...current.result, instagramReels: { caption: event.target.value } }
                }) : current)}
                disabled={isGenerating}
              />
              <div className="metadata-field-footer">{counter(result.instagramReels.caption, PLATFORM_LIMITS.instagramReels.captionCharacters)}<Button size="small" variant="ghost" onClick={() => void copy(result.instagramReels.caption)}>Copy</Button></div>
            </div>
          </section>
          <section className="metadata-platform">
            <header><h4>TikTok</h4><Button size="small" variant="ghost" onClick={() => void copy(result.tiktok.caption)}>Copy all</Button></header>
            <div className="metadata-field">
              <label htmlFor={`${clipId}-tiktok-caption`}>Caption</label>
              <textarea
                id={`${clipId}-tiktok-caption`}
                value={result.tiktok.caption}
                maxLength={PLATFORM_LIMITS.tiktok.captionCharacters}
                rows={3}
                onChange={(event) => changeDraft((current) => current.result ? ({
                  ...current,
                  result: { ...current.result, tiktok: { caption: event.target.value } }
                }) : current)}
                disabled={isGenerating}
              />
              <div className="metadata-field-footer">{counter(result.tiktok.caption, PLATFORM_LIMITS.tiktok.captionCharacters)}<Button size="small" variant="ghost" onClick={() => void copy(result.tiktok.caption)}>Copy</Button></div>
            </div>
          </section>
        </div>
      ) : (
        <p className="metadata-placeholder">Generate metadata for this selected or rendered clip. Ollama runs locally; if it is unavailable, an offline template generator is used.</p>
      )}
      {metadata?.provider && <span className="metadata-source">Generated by {metadata.provider} · {metadata.edited ? "edited and saved" : "generated from transcript"}</span>}
      {errorMessage && <p className="form-error metadata-error-message" role="alert">{errorMessage}</p>}
      {!sourceIsUrl && sourceUrl && <span className="sr-only">Video title: {videoTitle}; type: {videoType}; {creditLine}</span>}
    </section>
  );
}
