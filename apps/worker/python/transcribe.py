import argparse
import json
import os
import tempfile
import time
import wave

from faster_whisper import WhisperModel


def emit_progress(event):
    print(json.dumps({"type": "progress", **event}), flush=True)


def read_audio_duration(audio_path):
    with wave.open(audio_path, "rb") as audio_file:
        return audio_file.getnframes() / audio_file.getframerate()


def write_audio_chunks(audio_path, chunk_directory, chunk_seconds):
    with wave.open(audio_path, "rb") as source:
        parameters = source.getparams()
        frames_per_chunk = max(1, parameters.framerate * chunk_seconds)
        chunks = []
        offset_seconds = 0.0
        index = 0
        while True:
            frames = source.readframes(frames_per_chunk)
            if not frames:
                break
            chunk_path = os.path.join(chunk_directory, f"chunk-{index:05d}.wav")
            with wave.open(chunk_path, "wb") as target:
                target.setparams(parameters)
                target.writeframes(frames)
            frame_count = len(frames) // parameters.nchannels // parameters.sampwidth
            duration_seconds = frame_count / parameters.framerate
            chunks.append((chunk_path, offset_seconds, duration_seconds))
            offset_seconds += duration_seconds
            index += 1
        return chunks


def transcribe(args):
    duration_seconds = read_audio_duration(args.audio)
    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        download_root=args.model_dir,
    )
    chunks_result = []
    language_chunks = []
    started_at = time.monotonic()
    completed_audio_seconds = 0.0

    with tempfile.TemporaryDirectory(prefix="clipforge-audio-chunks-") as chunk_directory:
        chunks = write_audio_chunks(args.audio, chunk_directory, args.chunk_seconds)
        for index, (chunk_path, offset_seconds, chunk_duration) in enumerate(chunks, start=1):
            segment_iterator, info = model.transcribe(
                chunk_path,
                word_timestamps=True,
                beam_size=1,
                condition_on_previous_text=False,
                vad_filter=False,
            )
            chunk_words = []
            chunk_segments = []
            for segment in segment_iterator:
                chunk_segments.append({
                    "start": segment.start,
                    "end": segment.end,
                    "text": segment.text.strip(),
                })
                for word in segment.words or []:
                    chunk_words.append({
                        "text": word.word,
                        "start": word.start,
                        "end": word.end,
                        "probability": word.probability,
                    })
            chunks_result.append({
                "offsetSeconds": offset_seconds,
                "words": chunk_words,
                "segments": chunk_segments,
            })
            language_chunks.append({
                "language": info.language,
                "durationSeconds": chunk_duration,
            })
            completed_audio_seconds += chunk_duration
            elapsed = time.monotonic() - started_at
            eta_seconds = None
            if completed_audio_seconds > 0 and index == len(chunks):
                eta_seconds = 0
            elif completed_audio_seconds > 0:
                eta_seconds = max(0, round(elapsed / completed_audio_seconds * (duration_seconds - completed_audio_seconds)))
            emit_progress({
                "completedChunks": index,
                "totalChunks": len(chunks),
                "completedAudioSeconds": round(completed_audio_seconds, 2),
                "etaSeconds": eta_seconds,
                "message": f"Transcribed audio chunk {index}/{len(chunks)}",
            })

    output = {
        "language": max(
            ((language, duration) for language, duration in _language_durations(language_chunks).items()),
            key=lambda item: item[1],
            default=("und", 0.0),
        )[0],
        "languageChunks": language_chunks,
        "durationSeconds": duration_seconds,
        "chunks": chunks_result,
    }
    temporary_output = f"{args.output}.tmp"
    with open(temporary_output, "w", encoding="utf-8") as output_file:
        json.dump(output, output_file, ensure_ascii=False, separators=(",", ":"))
    os.replace(temporary_output, args.output)


def _language_durations(language_chunks):
    totals = {}
    for chunk in language_chunks:
        language = chunk["language"]
        totals[language] = totals.get(language, 0.0) + chunk["durationSeconds"]
    return totals


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="small")
    parser.add_argument("--chunk-seconds", type=int, default=30)
    parser.add_argument("--model-dir", default="/models")
    args = parser.parse_args()
    os.makedirs(args.model_dir, exist_ok=True)
    transcribe(args)


if __name__ == "__main__":
    main()
