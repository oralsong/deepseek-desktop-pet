"""Ear: listen on the mic, transcribe, send to the pet, speak its reply.

Flow: mic -> voice activity detection -> faster-whisper -> POST /dsh-pet-7340/chat
-> reply text -> POST to the local voice service -> played out loud.

Run: python ear.py            (auto-detects the DSH port)
     python ear.py --device 3 --lang zh
"""
import argparse
import json
import os
import subprocess
import sys
import time

import numpy as np
import psutil
import requests
import sounddevice as sd

SR = 16000
BLOCK_MS = 30
BLOCK = int(SR * BLOCK_MS / 1000)

STATE = {"mute_until": 0.0}


def log(msg):
    line = time.strftime("[%H:%M:%S] ") + msg
    print(line, flush=True)
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "ear.log"), "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass


for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

def find_base(explicit=None):
    """Find the DSH web server port: any listening port that answers the pet API."""
    if explicit:
        return explicit.rstrip("/")
    candidates = []
    for p in psutil.process_iter(["name", "pid"]):
        name = p.info["name"] or ""
        if "DeepSeek" not in name:
            continue
        try:
            conns = p.net_connections(kind="tcp")
        except Exception:
            continue
        for c in conns:
            if c.status == "LISTEN" and c.laddr.port > 1024:
                candidates.append(c.laddr.port)
    for port in candidates:
        base = "http://127.0.0.1:%d" % port
        try:
            r = requests.get(base + "/dsh-pet-7340/state", timeout=1.5)
            if r.status_code == 200:
                return base
        except Exception:
            continue
    return None


def rms(x):
    return float(np.sqrt(np.mean(np.square(x))))


class Asr:
    """Two backends: whisper (accurate, model on disk) and SAPI (offline, instant)."""

    def __init__(self, engine, device, compute_type, model_dir):
        self.engine = engine
        self.device = device
        self.compute_type = compute_type
        self.model_dir = model_dir
        self.model = None
        self.tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "say", "ear-tmp.wav")
        if engine == "whisper":
            from faster_whisper import WhisperModel

            dev = device
            ctype = compute_type
            if dev == "auto":
                # ctranslate2 在 CUDA 上需要 torhc 自带的 cudnn/cublas，先把 torch\lib 挂进 PATH
                try:
                    import torch

                    libdir = os.path.join(os.path.dirname(torch.__file__), "lib")
                    os.environ["PATH"] = libdir + os.pathsep + os.environ.get("PATH", "")
                    dev, ctype = "cuda", "float16"
                    m = WhisperModel(model_dir, device=dev, compute_type=ctype)
                    log("whisper 用显卡加速 (%s/%s)" % (dev, ctype))
                except Exception as e:  # noqa: BLE001
                    log("显卡转录不可用（%s），改用 CPU" % str(e)[:80])
                    dev, ctype = "cpu", "int8"
                    m = WhisperModel(model_dir, device=dev, compute_type=ctype)
            else:
                ctype = ctype or ("float16" if dev == "cuda" else "int8")
                m = WhisperModel(model_dir, device=dev, compute_type=ctype)
            self.model = m
            self.device = dev
            self.compute_type = ctype
            log("whisper ready (%s/%s, model %s)" % (dev, ctype, model_dir))
        else:
            log("SAPI dictation ready (offline)")

    def transcribe(self, audio, lang):
        if self.engine == "whisper":
            segments, _info = self.model.transcribe(
                audio,
                language=lang,
                beam_size=5,
                vad_filter=False,
                condition_on_previous_text=False,
                initial_prompt="以下是普通话的句子。",
            )
            text = "".join(s.text for s in segments).strip()
            return filter_echo(text)
        return self._sapi(audio)

    def _sapi(self, audio):
        import struct
        import wave

        pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
        with wave.open(self.tmp, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(pcm.tobytes())
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sapi-asr.ps1")
        out = subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Wav", self.tmp],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return (out.stdout or "").strip()


PROMPT_ECHO = ("请用简体中文转写", "以下是普通话的句子", "普通话的句子", "简体中文转写")


def filter_echo(text):
    """Whisper 在近乎静音时会复读 initial_prompt，把这类输出当没听见。"""
    t = (text or "").strip()
    if not t:
        return ""
    core = t.strip("，。,.!?！？、 ")
    for frag in PROMPT_ECHO:
        core = core.replace(frag, "")
    core = core.strip("，。,.!?！？、 ")
    if not core:
        return ""
    if len(core) >= 6 and core[: len(core) // 2] == core[len(core) // 2 :]:
        core = core[: len(core) // 2]
    return core if len(core) >= 2 else ""


def _load_pet_token():
    """独立模式（lib/standalone.js）给所有 POST 加了 token 校验，从 runtime 文件读出来。"""
    try:
        home = os.environ.get("DSH_HOME") or ""
        if not home:
            return ""
        path = os.path.join(home, "dsh-pet", "standalone-runtime.json")
        with open(path, "r", encoding="utf-8") as fh:
            return str(json.load(fh).get("token") or "")
    except Exception:  # noqa: BLE001
        return ""


def ask_pet(base, pet, text, timeout=90):
    url = base + "/dsh-pet-7340/chat?pet=" + pet + "&surface=desktop"
    headers = {"Origin": base, "Referer": base + "/"}
    token = _load_pet_token()
    if token:
        headers["x-dsh-pet-token"] = token
    r = requests.post(url, json={"text": text}, headers=headers, timeout=timeout)
    data = r.json()
    reply = data.get("text") or data.get("reply") or ""
    return data.get("ok") is True, str(reply), data


def speak(text, voice_url, voice, tau):
    if not text:
        return None
    try:
        r = requests.post(
            voice_url.rstrip("/") + "/say",
            json={"text": text, "voice": voice, "tau": tau, "play": True},
            timeout=120,
        )
        return r.json()
    except Exception as e:  # noqa: BLE001
        log("voice service error: %s" % e)
        return None


def list_mics():
    rows = []
    for i, d in enumerate(sd.query_devices()):
        if d["max_input_channels"] > 0:
            rows.append("%3d | %s | %s" % (i, d["name"], sd.query_hostapis(d["hostapi"])["name"]))
    return rows


def resolve_mic(spec):
    """--device 可以是索引(1)、索引字串("1")、名称片段("麦克风阵列"/"Steam"/"CABLE")。"""
    if spec is None or spec == "":
        return None
    s = str(spec).strip()
    if s.isdigit():
        return int(s)
    low = s.lower()
    for i, d in enumerate(sd.query_devices()):
        if d["max_input_channels"] > 0 and low in d["name"].lower():
            log("麦克风匹配到 #%d %s" % (i, d["name"]))
            return i
    log("没找到名字含「%s」的麦克风，改用系统默认" % s)
    return None


def meter(device, seconds):
    """实时显示音量，用来确认哪个麦克风听得见你说话。"""
    log("测音量 %.0f 秒，请正常说话…" % seconds)
    with sd.InputStream(samplerate=SR, channels=1, dtype="float32", blocksize=BLOCK, device=device) as st:
        t0 = time.time()
        peak = 0.0
        while time.time() - t0 < seconds:
            data, _ = st.read(BLOCK)
            lv = rms(data)
            peak = max(peak, lv)
            bar = "#" * int(min(40, lv * 200))
            print("rms %.4f %-40s" % (lv, bar), flush=True)
            time.sleep(0.05)
    log("最大 rms %.4f%s" % (peak, "" if peak > 0.02 else "  ← 太小了，这个麦克风基本没收到声音"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default=None, help="麦克风：索引(1) 或名称片段(麦克风阵列 / Steam / CABLE)")
    ap.add_argument("--list", action="store_true", help="列出所有输入设备后退出")
    ap.add_argument("--meter", type=float, default=0.0, help="测这个麦克风的音量 N 秒后退出")
    ap.add_argument("--base", default=None, help="http://127.0.0.1:PORT (default: auto detect)")
    ap.add_argument("--pet", default="main")
    ap.add_argument("--engine", default="auto", choices=["auto", "sapi", "whisper"])
    ap.add_argument("--model-dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "whisper-fw-small"))
    ap.add_argument("--asr-device", default="auto", choices=["auto", "cpu", "cuda"])
    ap.add_argument("--compute", default="")
    ap.add_argument("--say", default="", help="skip the mic, send this text to the pet once")
    ap.add_argument("--lang", default="zh")
    ap.add_argument("--silence", type=float, default=0.35, help="seconds of silence that ends a phrase")
    ap.add_argument("--min-speech", type=float, default=0.30)
    ap.add_argument("--max-utterance", type=float, default=15.0)
    ap.add_argument("--threshold", type=float, default=0.0, help="0 = adaptive")
    ap.add_argument("--voice-url", default="http://127.0.0.1:8848")
    ap.add_argument("--voice", default="zh-CN-XiaoyiNeural")
    ap.add_argument("--tau", type=float, default=0.45)
    args = ap.parse_args()

    base = find_base(args.base)
    if not base:
        log("找不到 DSH 端口，用 --base http://127.0.0.1:PORT 手动指定")
        sys.exit(2)
    log("pet API: " + base)

    engine = args.engine
    if engine == "auto":
        weight = os.path.join(args.model_dir, "model.bin")
        big_enough = os.path.exists(weight) and os.path.getsize(weight) > 400 * 1024 * 1024
        engine = "whisper" if big_enough else "sapi"
    log("ASR engine: " + engine)

    if args.say:
        ok, reply, raw = ask_pet(base, args.pet, args.say)
        log("你：%s" % args.say)
        log(("它：%s" % reply) if ok else ("失败：%s" % json.dumps(raw, ensure_ascii=False)[:200]))
        if ok and reply:
            res = speak(reply, args.voice_url, args.voice, args.tau)
            log("语音：%s" % json.dumps(res, ensure_ascii=False)[:160])
        return

    asr = Asr(engine, args.asr_device, args.compute, args.model_dir)

    noise = 0.006
    speaking = False
    silence_run = 0.0
    buf = []
    speech_time = 0.0
    log("listening... (Ctrl+C to stop)")

    def callback(indata, frames, t, status):  # noqa: ARG001
        buf.append(indata.copy())

    with sd.InputStream(
        samplerate=SR, channels=1, dtype="float32", blocksize=BLOCK, device=args.device, callback=callback
    ):
        while True:
            time.sleep(BLOCK_MS / 1000.0)
            if time.time() < STATE["mute_until"]:
                buf.clear()
                speaking = False
                continue
            if not buf:
                continue
            chunk = np.concatenate(buf)
            buf.clear()
            level = rms(chunk)

            if not speaking:
                noise = noise * 0.97 + min(level, 0.05) * 0.03
                thr = args.threshold or max(0.060, noise * 4.0)
                if level > thr:
                    speaking = True
                    silence_run = 0.0
                    speech_time = BLOCK_MS / 1000.0
                    audio = [chunk]
                    log(".. 听到声音 (rms=%.3f thr=%.3f)" % (level, thr))
                continue

            audio.append(chunk)
            speech_time += BLOCK_MS / 1000.0
            if level > (args.threshold or max(0.030, noise * 2.5)):
                silence_run = 0.0
            else:
                silence_run += BLOCK_MS / 1000.0

            done = silence_run >= args.silence or speech_time >= args.max_utterance
            if not done:
                continue

            clip = np.concatenate(audio).flatten()
            speaking = False
            if speech_time < args.min_speech:
                continue
            peak = float(np.max(np.abs(clip))) if clip.size else 0.0
            if peak > 1e-4:
                clip = clip * min(6.0, 0.9 / peak)
            t0 = time.time()
            text = asr.transcribe(clip, args.lang)
            if not text or len(text.strip("，。,.!?！？")) < 2:
                log("(没听清，忽略)")
                continue
            log("你说：%s   (asr %.2fs)" % (text, time.time() - t0))

            ok, reply, raw = ask_pet(base, args.pet, text)
            if not ok:
                log("桌宠没回答：%s" % json.dumps(raw, ensure_ascii=False)[:160])
                continue
            log("它说：%s" % reply)
            served_voice = isinstance(raw, dict) and bool((raw.get("spoke") or {}).get("ok"))
            if served_voice:
                # 宿主已经把这句话念了（气泡与声音同步），这边只负责闭嘴别抢
                STATE["mute_until"] = time.time() + max(1.5, len(reply) * 0.22)
                continue
            res = speak(reply, args.voice_url, args.voice, args.tau)
            if res and res.get("ok"):
                log("语音 %.2fs (edge %dms / conv %dms)" % (res["seconds"], res["edgeMs"], res["convMs"]))
                STATE["mute_until"] = time.time() + float(res["seconds"]) + 0.8
            elif res:
                log("语音失败：%s" % json.dumps(res, ensure_ascii=False)[:160])


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("bye")
