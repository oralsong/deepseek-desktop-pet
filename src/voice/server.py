"""Pet voice service: text -> Edge TTS -> OpenVoice tone-colour swap -> play.

Long lived: keeps the OpenVoice converter on the GPU and the target speaker
embedding cached. POST /say {"text": "...", "play": true} on 127.0.0.1:8848.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import winsound
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

import asyncio  # noqa: E402
import librosa  # noqa: E402
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(ROOT, "repos", "OpenVoice")
sys.path.insert(0, REPO)

from openvoice.api import ToneColorConverter  # noqa: E402

FFMPEG = os.path.join(ROOT, "bin", "ffmpeg.exe")
# Windows: never let a child console window flash on screen (every utterance would
# flash one because ffmpeg is a console app).
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
CKPT = os.path.join(ROOT, "models", "openvoice", "converter")
REF = os.path.join(ROOT, "ref-mv.wav")
CACHE = os.path.join(ROOT, "cache")
OUT = os.path.join(ROOT, "say")
os.makedirs(CACHE, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

LOCK = threading.Lock()
STATE = {"ready": False, "loading": True, "error": "", "tcc": None, "sr": 22050, "tgt_se": None, "ref": REF}


def init_engine(ref_path=None):
    ref_path = os.path.abspath(ref_path or REF)
    if not os.path.isfile(ref_path):
        raise FileNotFoundError("voice reference not found: " + ref_path)
    stat = os.stat(ref_path)
    ref_key = hashlib.sha1(
        ("%s|%s|%s" % (ref_path, stat.st_size, int(stat.st_mtime))).encode("utf-8")
    ).hexdigest()[:16]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    tcc = ToneColorConverter(os.path.join(CKPT, "config.json"), device=device)
    tcc.load_ckpt(os.path.join(CKPT, "checkpoint.pth"))
    State_sr = tcc.hps.data.sampling_rate
    se_path = os.path.join(CACHE, "target_se-%s.pt" % ref_key)
    if os.path.exists(se_path):
        tgt_se = torch.load(se_path, map_location=device)
    else:
        tgt_se = tcc.extract_se([ref_path])
        torch.save(tgt_se.detach().cpu(), se_path)
    dev = getattr(tcc, "device", device)
    if hasattr(tgt_se, "to"):
        tgt_se = tgt_se.to(dev)
    STATE.update(ready=True, loading=False, error="", tcc=tcc, sr=State_sr, tgt_se=tgt_se, ref=ref_path)
    print("engine ready sr=%d device=%s ref=%s" % (State_sr, device, ref_path), flush=True)


def edge_mp3(text, voice, mp3):
    import edge_tts

    async def run():
        await edge_tts.Communicate(text, voice).save(mp3)

    asyncio.run(run())


def say(text, voice, tau=0.3):
    t0 = time.time()
    mp3 = os.path.join(OUT, "tts-src.mp3")
    edge_mp3(text, voice, mp3)
    t_edge = time.time() - t0

    src_wav = os.path.join(OUT, "tts-src.wav")
    subprocess.run(
        [FFMPEG, "-y", "-loglevel", "error", "-i", mp3, "-ac", "1", "-ar", str(STATE["sr"]), src_wav],
        check=True,
        creationflags=NO_WINDOW,
    )
    t1 = time.time()
    tcc, sr = STATE["tcc"], STATE["sr"]
    src_se = tcc.extract_se([src_wav])
    out = os.path.join(OUT, "tts-out.wav")
    tcc.convert(audio_src_path=src_wav, src_se=src_se, tgt_se=STATE["tgt_se"], output_path=out, tau=tau)
    data, _ = librosa.load(out, sr=sr)
    idx = np.where(np.abs(data) > 0.01)[0]
    if len(idx):
        a = max(0, idx[0] - int(0.03 * sr))
        b = min(len(data), idx[-1] + int(0.08 * sr))
        data = data[a:b]
    data = data / (np.abs(data).max() or 1.0) * 0.89
    sf.write(out, data, sr, subtype="PCM_16")
    t_conv = time.time() - t1
    return out, len(data) / sr, t_edge, t_conv


def _split_clauses(text):
    """把一句话按标点切成小块：先念第一块，剩下的边合成边念，首句能早 ~0.6 秒出声。"""
    parts = [p.strip() for p in re.split(r"[，,。.！!？?；;：:、\s]+", text) if p and p.strip()]
    if not parts:
        return [text]
    # 太碎的块并到下一块，避免一句一两个字
    merged = []
    i = 0
    while i < len(parts):
        cur = parts[i]
        while len(cur) < 6 and i + 1 < len(parts):
            i += 1
            cur += "，" + parts[i]
        merged.append(cur)
        i += 1
    return merged


SEQ = {"gen": 0}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._json(
                200,
                {
                    "ok": True,
                    "ready": STATE["ready"],
                    "loading": STATE["loading"],
                    "error": STATE["error"],
                    "ref": STATE["ref"],
                },
            )
        self._json(404, {"ok": False, "reason": "not-found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json(400, {"ok": False, "reason": "bad-json"})
        if self.path.startswith("/play"):
            wav = str(payload.get("file") or "").strip()
            if not wav or not os.path.isfile(wav):
                return self._json(400, {"ok": False, "reason": "no-such-file"})
            winsound.PlaySound(wav, winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT)
            return self._json(200, {"ok": True, "played": wav})
        if not self.path.startswith("/say"):
            return self._json(404, {"ok": False, "reason": "not-found"})
        if not STATE["ready"]:
            return self._json(503, {"ok": False, "reason": "not-ready"})
        text = str(payload.get("text") or "").strip()
        if not text:
            return self._json(400, {"ok": False, "reason": "empty"})
        voice = str(payload.get("voice") or "zh-CN-XiaoyiNeural")
        tau = float(payload.get("tau") or 0.3)
        play = payload.get("play", True)
        split = bool(payload.get("split"))
        if split:
            parts = _split_clauses(text)
            SEQ["gen"] += 1
            gen = SEQ["gen"]
            with LOCK:
                try:
                    wav, dur, t_edge, t_conv = say(parts[0], voice, tau)
                except Exception as e:  # noqa: BLE001
                    return self._json(500, {"ok": False, "reason": "synth-error", "message": str(e)[:200]})
            if play:
                winsound.PlaySound(wav, winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT)

            def bg(rest=parts[1:], delay=dur, g=gen):
                wait = delay
                for p in rest:
                    time.sleep(max(0.05, wait))
                    if SEQ["gen"] != g:  # 有新的一句了，旧的别再念
                        return
                    with LOCK:
                        try:
                            w2, d2, _, _ = say(p, voice, tau)
                        except Exception:  # noqa: BLE001
                            return
                    winsound.PlaySound(w2, winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT)
                    wait = d2

            if parts[1:]:
                threading.Thread(target=bg, daemon=True).start()
            return self._json(
                200,
                {
                    "ok": True,
                    "file": wav,
                    "seconds": round(dur, 2),
                    "edgeMs": int(t_edge * 1000),
                    "convMs": int(t_conv * 1000),
                    "split": len(parts),
                    "playing": bool(play),
                },
            )
        with LOCK:
            try:
                wav, dur, t_edge, t_conv = say(text, voice, tau)
            except Exception as e:  # noqa: BLE001
                return self._json(500, {"ok": False, "reason": "synth-error", "message": str(e)[:200]})
            if play:
                winsound.PlaySound(wav, winsound.SND_FILENAME | winsound.SND_ASYNC)
            return self._json(
                200,
                {
                    "ok": True,
                    "file": wav,
                    "seconds": round(dur, 2),
                    "edgeMs": int(t_edge * 1000),
                    "convMs": int(t_conv * 1000),
                },
            )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8848)
    ap.add_argument("--ref", default=REF, help="voice-cloning reference wav")
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("listening on %d" % args.port, flush=True)

    def load():
        try:
            init_engine(args.ref)
        except Exception as exc:  # noqa: BLE001
            STATE.update(loading=False, error=str(exc)[:300])
            print("engine load failed: %s" % exc, flush=True)

    threading.Thread(target=load, daemon=True, name="voice-model-loader").start()
    srv.serve_forever()


if __name__ == "__main__":
    main()
