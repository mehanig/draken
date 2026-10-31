#!/usr/bin/env python3
"""Local-only speech worker. JSONL on stdio; audio exists only in memory.

Models must already be installed. No runtime downloads, provider credentials,
transcript logging, or network transcription/synthesis services.
"""
import base64
import io
import json
import os
from pathlib import Path
import sys
import time
import wave

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

import numpy as np
import onnxruntime as ort
from faster_whisper import WhisperModel
from kokoro_onnx import Kokoro


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def pcm_wav(audio, rate):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    return output.getvalue()


def main():
    ort.disable_telemetry_events()
    root = Path(os.environ["DRAKEN_VOICE_DATA_DIR"]) / "models"
    threads = int(os.environ.get("DRAKEN_VOICE_THREADS", "4"))
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.log_severity_level = 3
    speech = Kokoro.from_session(
        ort.InferenceSession(str(root / "kokoro-v1.0.int8.onnx"), sess_options=options, providers=["CPUExecutionProvider"]),
        str(root / "voices-v1.0.bin"),
    )
    recognizer = WhisperModel(str(root / "whisper-base.en"), device="cpu", compute_type="int8", cpu_threads=threads, local_files_only=True)
    voice = os.environ.get("DRAKEN_VOICE_SPEAKER", "af_heart")
    if voice not in speech.voices:
        raise ValueError("Unknown local voice")
    emit({"type": "ready"})
    while True:
        line = sys.stdin.readline(3_000_000)
        if not line:
            break
        job = {}
        try:
            if not line.endswith("\n"):
                raise ValueError("Input too large")
            job = json.loads(line)
            start = time.perf_counter()
            if job["op"] == "transcribe":
                data = base64.b64decode(job["audio"], validate=True)
                with wave.open(io.BytesIO(data), "rb") as wav:
                    if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 16000 or wav.getcomptype() != "NONE":
                        raise ValueError("Expected mono 16 kHz PCM16 WAV")
                    count = wav.getnframes()
                    if not 4000 <= count <= 45 * 16000:
                        raise ValueError("Audio must be between 0.25 and 45 seconds")
                    frames = wav.readframes(count)
                    if len(frames) != count * 2:
                        raise ValueError("Incomplete audio")
                    audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768
                text = ""
                # Silence should never become a hallucinated question or a paid pi turn.
                if float(np.sqrt(np.mean(audio ** 2))) >= 0.002:
                    segments, _ = recognizer.transcribe(
                        audio, language="en", beam_size=1, vad_filter=True,
                        condition_on_previous_text=False,
                        initial_prompt="Draken, pi, GifGun, export tests, deployment, repository, sync, blockers.",
                    )
                    text = " ".join(segment.text.strip() for segment in segments if segment.no_speech_prob < 0.7).strip()
                result = {"text": text[:4000]}
            elif job["op"] == "synthesize":
                text = job["text"]
                if not isinstance(text, str) or not 1 <= len(text) <= 360:
                    raise ValueError("Speech chunk must be 1 to 360 characters")
                audio, rate = speech.create(text, voice=voice, speed=1.0, lang="en-us")
                result = {"audio": base64.b64encode(pcm_wav(audio, rate)).decode("ascii"), "duration": len(audio) / rate}
            else:
                raise ValueError("Unknown operation")
            emit({"id": job["id"], **result, "elapsed_ms": round((time.perf_counter() - start) * 1000)})
        except Exception as error:
            # Never echo audio, transcript text, model input, or environment values.
            emit({"id": job.get("id"), "error": "Local speech operation failed (" + type(error).__name__ + ")"})
        finally:
            # Do not hold the previous recording while the warm worker waits idle.
            line = ""
            job = result = data = frames = audio = segments = None


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"type": "error", "error": "Local audio could not start (" + type(error).__name__ + ")"})
        sys.exit(1)
