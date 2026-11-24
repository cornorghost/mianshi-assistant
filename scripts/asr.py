"""Persistent JSONL worker: 16 kHz PCM WAV -> local faster-whisper."""
import argparse
import base64
import io
import json
import os
import time
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")


def emit(kind, **fields):
    print(json.dumps({"type": kind, **fields}, ensure_ascii=False), flush=True)


def load_model(name):
    from faster_whisper import WhisperModel
    root = Path(__file__).resolve().parents[1] / ".models"
    local = root / name
    emit("loading", message=f"正在加载本地 {name} 模型…" if (local / "model.bin").exists() else f"正在下载并加载 {name} 模型…")
    # An explicit local model folder works offline and avoids remote lookups.
    source = str(local) if (local / "model.bin").exists() else name
    return WhisperModel(source, device="cpu", compute_type="int8", cpu_threads=max(2, min(8, (os.cpu_count() or 4) // 2)), download_root=str(root))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small", choices=["tiny", "base", "small"])
    parser.add_argument("--language", default="zh", choices=["zh", "en", "auto"])
    parser.add_argument("--download-only", action="store_true")
    args = parser.parse_args()
    try:
        model = load_model(args.model)
    except Exception as exc:
        emit("error", message=f"本地语音模型加载失败：{exc}")
        return 1
    emit("ready")
    if args.download_only:
        return 0
    previous_text = ""
    previous_utterance = None
    for line in sys.stdin:
        metadata = {}
        try:
            payload = json.loads(line)
            started = time.monotonic()
            metadata = {k: payload[k] for k in ("id", "utteranceId", "sessionId", "final") if k in payload}
            raw = base64.b64decode(payload["audio"], validate=True)
            if len(raw) > 2_000_000:
                raise ValueError("audio exceeds size limit")
            utterance_key = (payload.get("sessionId"),payload.get("utteranceId"))
            if utterance_key != previous_utterance:
                previous_text = ""
            prompt = "技术面试。Redis、MySQL、Java、React、数据库、缓存、分布式、线程池、索引、事务、慢查询、查询优化、并发、死锁、消息队列、垃圾回收。" + previous_text[-180:]
            from faster_whisper.audio import decode_audio
            import numpy as np
            audio = decode_audio(io.BytesIO(raw), sampling_rate=16000)
            peak = float(np.max(np.abs(audio))) if len(audio) else 0
            if peak < 0.000001:
                emit("empty", text="", processingMs=0, **metadata)
                continue
            rms = float(np.sqrt(np.mean(audio**2)))
            audio = audio * min(8.0, 0.07 / max(rms,0.000001), 0.95 / peak)
            segments, info = model.transcribe(audio, beam_size=2, best_of=1, temperature=0,
                language=None if args.language == "auto" else args.language, vad_filter=False,
                condition_on_previous_text=True, initial_prompt=prompt,
                hotwords="数据库 索引 慢查询 事务 Redis MySQL 线程池 缓存", hallucination_silence_threshold=1.2)
            # Retain recognized words. Confidence is metadata, never a silent text filter.
            accepted = list(segments)
            text = "".join(s.text for s in accepted).strip()
            previous_utterance = utterance_key
            previous_text += text
            emit("transcript" if text else "empty", text=text, language=info.language, processingMs=round((time.monotonic()-started)*1000), **metadata)
        except Exception as exc:
            emit("error", message=f"转写失败：{exc}", **metadata)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
