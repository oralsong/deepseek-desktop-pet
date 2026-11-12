r"""gsd特制大肥鱼桌宠 —— 绿色包启动器（不需要 DSH）

目录结构（打包后）：
  gsd-pet\
    gsd大肥鱼桌宠.exe      <- 本程序
    runtime\node.exe
    runtime\python\python.exe
    app\dsh-pet\lib\standalone.js
    app\pet-voice\server.py
"""
import io
import re
import json
import os
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

try:
    import psutil
except Exception:  # 绿色包里没装 psutil 也能跑
    psutil = None

TITLE = "gsd特制大肥鱼桌宠"
SUB = "会看屏幕陪你玩、会用自己的声音说话、还听得见你说话"
VOICE_PORT = 8848

EXE_DIR = os.path.dirname(os.path.abspath(sys.executable if getattr(sys, "frozen", False) else __file__))
BASE = EXE_DIR if os.path.exists(os.path.join(EXE_DIR, "runtime", "node.exe")) else os.path.dirname(EXE_DIR)

NODE = os.path.join(BASE, "runtime", "node.exe")
PYTHON = os.path.join(BASE, "runtime", "python", "python.exe")
PET_PKG = os.path.join(BASE, "app", "dsh-pet")
STANDALONE = os.path.join(PET_PKG, "lib", "standalone.js")
VOICE_DIR = os.path.join(BASE, "app", "pet-voice")
VOICE_SCRIPT = os.path.join(VOICE_DIR, "server.py")

# 所有可写数据都放在安装目录下，绝不碰 C:\\Users\\<别人>\\.dsh
DATA_DIR = os.path.join(BASE, "data")
DSH_HOME = DATA_DIR
PET_CONF_DIR = os.path.join(DSH_HOME, "dsh-pet")
AI_FILE = os.path.join(PET_CONF_DIR, "standalone-ai.json")
PEEK_FILE = os.path.join(PET_CONF_DIR, "peek.json")
RUNTIME_FILE = os.path.join(PET_CONF_DIR, "standalone-runtime.json")
CFG_FILE = os.path.join(DATA_DIR, "config.json")

DEFAULT_CFG = {
    "petName": "哦鲸鲸",
    "persona": "",
    "speechReference": "",
    "voiceRef": "",
    "apiKey": "",
    "model": "deepseek-flash",
    "baseUrl": "https://api.deepseek.com",
    "autostart": False,
}

DEFAULT_PEEK = {
    "enabled": True, "petId": "", "intervalSec": 4, "minChange": 0.04, "minCells": 10,
    "cellDiff": 0.1, "cooldownSec": 8, "silentWhenIdle": True, "maxWidth": 1280,
    "quality": 85, "smallWidth": 96, "smallHeight": 54, "captureTimeoutMs": 15000,
    "generateTimeoutMs": 45000, "debugLog": True, "prompt": "", "provider": "", "model": "",
    "quietOnFullscreen": True, "speak": True, "speakVoice": "", "speakRate": 1,
    "speakVolume": 90, "memory": True, "memoryLines": 6,
    "voiceService": "http://127.0.0.1:8848", "voiceServerScript": "",
    "voicePython": "", "voiceName": "zh-CN-XiaoyiNeural", "voiceTau": 0.45,
}


def write_json(path, obj):
    data = json.dumps(obj, ensure_ascii=False, indent=2)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    last = None
    for target in (path + ".tmp", path + ".new", path):
        try:
            with io.open(target, "w", encoding="utf-8", newline="\n") as f:
                f.write(data)
            if target != path:
                os.replace(target, path)
            return True
        except OSError as e:
            last = e
            sys.stderr.write("[write_json] %s -> %s\n" % (target, e))
    sys.stderr.write("[write_json] all attempts failed: %s\n" % last)
    return False


def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception:
        return dict(default)


def load_cfg():
    cfg = dict(DEFAULT_CFG)
    cfg.update(read_json(CFG_FILE, {}))
    return cfg


def save_cfg(cfg):
    write_json(CFG_FILE, cfg)


def kill_by_cmdline(pattern):
    if not psutil:
        return 0
    n = 0
    for p in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            cmd = " ".join(p.info.get("cmdline") or [])
            if pattern in cmd:
                p.kill()
                n += 1
        except Exception:
            pass
    return n


def _pet_http_ok(port=3080):
    try:
        j = http_json("http://127.0.0.1:%d/dsh-pet-7340/config" % port, timeout=1.5)
    except Exception:
        return False
    return isinstance(j, dict)


def pet_running():
    """只要 3080 端口上真的有它在应答，就算在跑；否则再按进程路径找一次。"""
    if _pet_http_ok():
        return "port:3080"
    if not psutil:
        return None
    target = os.path.join(PET_PKG, "lib", "standalone.js").lower()
    for p in psutil.process_iter(["pid", "cmdline"]):
        try:
            cmd = " ".join(p.info.get("cmdline") or []).lower()
            if target in cmd:
                return p.info["pid"]
        except Exception:
            pass
    return None


def pet_port():
    """默认就是 3080；只有 3080 不通而运行时文件里的端口真的活着，才用那个。"""
    if _pet_http_ok(3080):
        return 3080
    try:
        with open(RUNTIME_FILE, "r", encoding="utf-8-sig") as f:
            j = json.load(f)
        port = int(j.get("port") or 0)
        if port and port != 3080 and _pet_http_ok(port):
            return port
    except Exception:
        pass
    return 3080


def http_json(url, timeout=2.0, payload=None):
    try:
        return _http_json_inner(url, timeout, payload)
    except Exception:
        return None


def _http_json_inner(url, timeout=2.0, payload=None):
    import urllib.request
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def voice_health():
    try:
        data = http_json("http://127.0.0.1:%d/health" % VOICE_PORT, 1.0)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def voice_ready():
    return bool(voice_health().get("ready"))


def start_voice(log, voice_ref=""):
    health = voice_health()
    current_ref = os.path.abspath(health.get("ref") or "") if health.get("ref") else ""
    wanted_ref = os.path.abspath(voice_ref) if voice_ref else ""
    if health.get("ready") or health.get("loading"):
        if wanted_ref and current_ref and wanted_ref != current_ref:
            log("音色参考已变化，重启语音服务…")
            kill_by_cmdline("pet-voice\\server.py")
            kill_by_cmdline("pet-voice/server.py")
            time.sleep(0.4)
        else:
            log("语音服务已在运行" if health.get("ready") else "语音服务正在加载模型，桌宠无需等待")
            return bool(health.get("ready"))
    if not os.path.exists(VOICE_SCRIPT):
        log("找不到语音服务脚本：" + VOICE_SCRIPT)
        return False
    flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    try:
        args = [PYTHON, VOICE_SCRIPT, "--port", str(VOICE_PORT)]
        if voice_ref and os.path.isfile(voice_ref):
            args.extend(["--ref", voice_ref])
            log("克隆音色参考：" + voice_ref)
        subprocess.Popen(args, cwd=VOICE_DIR,
                         creationflags=flags, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, close_fds=True)
    except Exception as e:
        log("启动语音服务失败：%s" % e)
        return False
    for _ in range(180):
        if voice_ready():
            log("语音服务就绪（%d）" % VOICE_PORT)
            return True
        time.sleep(0.5)
    log("语音服务启动超时（模型加载较慢，可以再等一会儿）")
    return False


def write_ai_config(cfg):
    ai = {
        "protocol": "openai-compatible",
        "baseUrl": cfg.get("baseUrl") or "https://api.deepseek.com",
        "model": cfg.get("model") or "deepseek-flash",
        "apiKey": cfg.get("apiKey") or "",
        "enabled": bool(cfg.get("apiKey")),
        "automaticWhispers": False,
        "whisperIntervalSec": 300,
        "maxTokens": 512,
        "timeoutMs": 45000,
    }
    write_json(AI_FILE, ai)
    return ai


def read_pet_identity():
    """从 main-config.jsonc 里读出名字和人设（读不到就给默认）。"""
    path = os.path.join(PET_CONF_DIR, "main-config.jsonc")
    name, persona = "", ""

    def unescape(raw):
        try:
            return json.loads('"' + raw + '"')
        except Exception:
            return raw

    if os.path.exists(path):
        try:
            text = io.open(path, encoding="utf-8").read()
            m = re.search(r'"name"\s*:\s*"((?:\\.|[^"\\])*)"', text)
            if m:
                name = unescape(m.group(1))
            m = re.search(r'"whisperPrompt"\s*:\s*"((?:\\.|[^"\\])*)"', text)
            if m:
                persona = unescape(m.group(1))
        except OSError:
            pass
    return name or "哦鲸鲸", persona


def compose_persona(persona, speech_reference):
    persona = (persona or "").strip()
    speech_reference = (speech_reference or "").strip()
    if persona and speech_reference:
        return persona + "\n\n说话方式参考：\n" + speech_reference
    return persona or speech_reference


def compose_peek_prompt(speech_reference):
    speech_reference = (speech_reference or "").strip()
    base = (
        "你是陪玩模式：用户正在电脑前操作，你坐在旁边看屏幕。"
        "只说画面里正在发生的一件具体事，15~30字，像朋友随口点评。"
        "不要念菜单和按钮，不要提截图、分辨率或桌面图标；没有值得说的变化就只回复 SKIP。"
    )
    if speech_reference:
        return base + "\n说话方式参考：" + speech_reference
    return base


def write_pet_config(name, persona, log=None):
    """把名字/人设写进 main-config.jsonc，保留文件里其它内容与注释。"""
    os.makedirs(PET_CONF_DIR, exist_ok=True)
    path = os.path.join(PET_CONF_DIR, "main-config.jsonc")
    if os.path.exists(path):
        try:
            text = io.open(path, encoding="utf-8").read()
        except OSError as e:
            if log:
                log("读取 main-config.jsonc 失败：%s" % e)
            return False
    else:
        text = (
            '{\n'
            '  // \u540d\u5b57\u4e0e\u4eba\u8bbe\uff1aApp \u91cc\u6539\u4e86\u4f1a\u5199\u56de\u8fd9\u91cc\n'
            '  "pets": [\n'
            '    {\n'
            '      "id": "main",\n'
            '      "name": "\u54e6\u9cb8\u9cb8",\n'
            '      "whisperPrompt": ""\n'
            '    }\n'
            '  ]\n'
            '}\n'
        )

    def esc(v):
        return json.dumps((v or "").strip(), ensure_ascii=False)[1:-1]

    nm = esc(name) or "哦鲸鲸"
    ps = esc(persona)

    if re.search(r'"name"\s*:', text):
        new = re.sub(r'("name"\s*:\s*")(?:\\.|[^"\\])*(")', lambda m: m.group(1) + nm + m.group(2), text, count=1)
    else:
        new = text.replace('"id": "main",', '"id": "main",\n      "name": "%s",' % nm, 1)

    if re.search(r'"whisperPrompt"\s*:', new):
        new = re.sub(r'("whisperPrompt"\s*:\s*")(?:\\.|[^"\\])*(")', lambda m: m.group(1) + ps + m.group(2), new, count=1)
    elif ps:
        new = re.sub(r'("name"\s*:\s*"[^"]*"\s*,)',
                     lambda m: m.group(1) + '\n      "whisperPrompt": "%s",' % ps, new, count=1)

    try:
        with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(new)
        return True
    except OSError as e:
        if log:
            log("写入 main-config.jsonc 失败：%s" % e)
        return False


def reload_pet(log=None):
    """让正在跑的桌宠重新读配置（独立版需要带 token）。"""
    port = pet_port()
    if not port:
        return False
    token = ""
    try:
        if os.path.exists(RUNTIME_FILE):
            token = (json.load(io.open(RUNTIME_FILE, encoding="utf-8")) or {}).get("token", "")
    except Exception:
        token = ""
    try:
        import urllib.request
        req = urllib.request.Request(
            "http://127.0.0.1:%d/dsh-pet-7340/reload" % port,
            data=b"{}",
            headers={"Content-Type": "application/json", "x-dsh-pet-token": token,
                     "Origin": "http://127.0.0.1:%d" % port},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=6) as r:
            r.read()
        return True
    except Exception as e:
        if log:
            log("重载桌宠失败：%s" % e)
        return False


def default_peek():
    """内置默认值 + 按安装位置算出语音服务路径（换台电脑也能直接用克隆音色）。"""
    cfg = dict(DEFAULT_PEEK)
    cfg["voiceServerScript"] = os.path.join(BASE, "app", "pet-voice", "server.py")
    cfg["voicePython"] = os.path.join(BASE, "runtime", "python", "python.exe")
    return cfg


MAIN_CONFIG_TEMPLATE = """// 桌宠名字与人设（改完在 App 里点「停止桌宠」再「运行」）
{
  "pets": [
    {
      "id": "main",
      "name": "哦鲸鲸",
      "size": 462,
      "display": "desktop",
      "fixedEnabled": false,
      "position": { "anchor": "corner", "corner": "bottom-right" },
      "whisperPrompt": "你是一只蓝鲸，我喊你蓝色大肥鱼，你喊我老大。说话像坐在旁边陪我玩游戏的朋友：短、自然、有点情绪，一句 20 字以内，不要重复上一句，不要提截图这两个字。"
    }
  ]
}
"""


def ensure_main_config():
    """首次启动写一份带名字/人设的配置，避免新装是默认的「蓝毛小女仆」。"""
    path = os.path.join(PET_CONF_DIR, "main-config.jsonc")
    if os.path.exists(path):
        return
    try:
        os.makedirs(PET_CONF_DIR, exist_ok=True)
        with io.open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(MAIN_CONFIG_TEMPLATE)
    except OSError:
        pass


def ensure_peek_cfg(speech_reference=None):
    if not os.path.exists(PEEK_FILE):
        initial = default_peek()
        if speech_reference is not None:
            initial["prompt"] = compose_peek_prompt(speech_reference)
        write_json(PEEK_FILE, initial)
        return
    # 老/别人机器上的 peek.json 可能缺语音路径 ⇒ 补齐，否则会退回机器人音色
    got = read_json(PEEK_FILE, None)
    if isinstance(got, dict):
        changed = False
        if not got.get("voiceServerScript"):
            got["voiceServerScript"] = os.path.join(BASE, "app", "pet-voice", "server.py")
            changed = True
        if not got.get("voicePython"):
            got["voicePython"] = os.path.join(BASE, "runtime", "python", "python.exe")
            changed = True
        if not got.get("voiceService"):
            got["voiceService"] = "http://127.0.0.1:8848"
            changed = True
        if not got.get("petId"):
            got["petId"] = "main"
            changed = True
        if speech_reference is not None:
            prompt = compose_peek_prompt(speech_reference)
            if got.get("prompt") != prompt:
                got["prompt"] = prompt
                changed = True
        if changed:
            write_json(PEEK_FILE, got)


def start_pet(cfg, log):
    if pet_running():
        log("桌宠已经在跑了")
        return pet_port()
    if not os.path.exists(NODE) or not os.path.exists(STANDALONE):
        log("安装包不完整：找不到 node 或 standalone.js")
        return 0
    ensure_peek_cfg(cfg.get("speechReference", ""))
    ensure_main_config()
    write_ai_config(cfg)
    env = dict(os.environ)
    env["DSH_HOME"] = DSH_HOME
    env["DSH_PET_ELECTRON_PATH"] = os.path.join(BASE, "runtime", "electron", "electron.exe")
    env["DSH_PET_CONFIG"] = PEEK_FILE
    os.makedirs(PET_CONF_DIR, exist_ok=True)
    flags = 0x00000008 | 0x00000200
    try:
        subprocess.Popen([NODE, STANDALONE, "--port", "3080"], cwd=PET_PKG,
                         creationflags=flags, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, env=env, close_fds=True)
    except Exception as e:
        log("启动桌宠失败：%s" % e)
        return 0
    for _ in range(120):
        port = pet_port()
        if port:
            log("桌宠起来了（127.0.0.1:%d）" % port)
            return port
        time.sleep(0.5)
    log("桌宠启动超时，看看是不是被安全软件拦了")
    return 0


def desktop_dir():
    return os.path.join(os.path.expanduser("~"), "Desktop")


def startup_dir():
    return os.path.join(os.path.expanduser("~"), "AppData", "Roaming", "Microsoft", "Windows",
                        "Start Menu", "Programs", "Startup")


def make_shortcut(lnk_path, target, args="", workdir="", icon=""):
    ps = (
        "$ws = New-Object -ComObject WScript.Shell;"
        "$s = $ws.CreateShortcut('%s');"
        "$s.TargetPath = '%s';$s.Arguments = '%s';$s.WorkingDirectory = '%s';$s.IconLocation = '%s';"
        "$s.Save()" % (lnk_path, target, args, workdir, icon)
    )
    subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
                   creationflags=0x08000000, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def launch_target():
    return sys.executable if getattr(sys, "frozen", False) else os.path.join(BASE, "gsd大肥鱼桌宠.exe")


def set_autostart(on):
    lnk = os.path.join(startup_dir(), TITLE + ".lnk")
    if on:
        make_shortcut(lnk, launch_target(), "--autostart", BASE, launch_target())
    else:
        try:
            os.remove(lnk)
        except Exception:
            pass


def pad(text, width):
    w = 0
    for ch in text:
        w += 2 if ord(ch) > 0x2E80 else 1
    return text + " " * max(0, width - w)


class App:
    def __init__(self, root):
        self.root = root
        self.cfg = load_cfg()
        self.identity_name, self.identity_persona = read_pet_identity()
        if not self.cfg.get("persona"):
            self.cfg["persona"] = self.identity_persona
        self.lines = []
        self.state_lines = []
        self.refresh_inflight = False
        self.run_inflight = False
        self.stopping = False
        root.title(TITLE)
        root.configure(bg="#12161f")
        root.geometry("760x900")
        root.minsize(700, 760)
        try:
            root.iconbitmap(os.path.join(BASE, "pet.ico"))
        except Exception:
            pass

        tk.Label(root, text=TITLE, font=("Microsoft YaHei UI", 21, "bold"), fg="#4ea3ff",
                 bg="#12161f").pack(anchor="w", padx=24, pady=(16, 0))
        tk.Label(root, text=SUB, font=("Microsoft YaHei UI", 9), fg="#8899b0",
                 bg="#12161f").pack(anchor="w", padx=24, pady=(2, 10))

        identity = self.section(root, "人设与说话")
        name_row = tk.Frame(identity, bg="#1b2130")
        name_row.pack(fill="x", padx=14, pady=(10, 6))
        tk.Label(name_row, text="名字", width=8, anchor="w", fg="#c9d6e8", bg="#1b2130",
                 font=("Microsoft YaHei UI", 9)).pack(side="left")
        self.name_var = tk.StringVar(value=self.cfg.get("petName") or self.identity_name)
        self.entry(name_row, self.name_var).pack(side="left", fill="x", expand=True, ipady=3)

        tk.Label(identity, text="人设 / 关系（它怎么看自己和你）", anchor="w", fg="#8fa3bf", bg="#1b2130",
                 font=("Microsoft YaHei UI", 8)).pack(fill="x", padx=14)
        self.persona_text = self.textbox(identity, height=4)
        self.persona_text.pack(fill="x", padx=14, pady=(4, 8))
        self.persona_text.insert("1.0", self.cfg.get("persona", ""))

        tk.Label(identity, text="说话参考（语气、长度、称呼、口头禅、不要说什么）", anchor="w",
                 fg="#8fa3bf", bg="#1b2130", font=("Microsoft YaHei UI", 8)).pack(fill="x", padx=14)
        self.speech_text = self.textbox(identity, height=3)
        self.speech_text.pack(fill="x", padx=14, pady=(4, 8))
        self.speech_text.insert("1.0", self.cfg.get("speechReference", ""))

        ref_row = tk.Frame(identity, bg="#1b2130")
        ref_row.pack(fill="x", padx=14, pady=(0, 12))
        tk.Label(ref_row, text="音色参考", width=8, anchor="w", fg="#c9d6e8", bg="#1b2130",
                 font=("Microsoft YaHei UI", 9)).pack(side="left")
        self.voice_ref_var = tk.StringVar(value=self.cfg.get("voiceRef", ""))
        self.entry(ref_row, self.voice_ref_var).pack(side="left", fill="x", expand=True, ipady=3)
        tk.Button(ref_row, text="选择 WAV", command=self.choose_voice_ref, bg="#2c3547", fg="#dce8f7",
                  activebackground="#39465d", activeforeground="#ffffff", relief="flat",
                  font=("Microsoft YaHei UI", 8)).pack(side="left", padx=(8, 0), ipady=3)

        model = self.section(root, "模型连接")
        row1 = tk.Frame(model, bg="#1b2130")
        row1.pack(fill="x", padx=14, pady=(10, 6))
        tk.Label(row1, text="API Key", width=9, anchor="w", fg="#c9d6e8", bg="#1b2130",
                 font=("Microsoft YaHei UI", 9)).pack(side="left")
        self.key_var = tk.StringVar(value=self.cfg.get("apiKey", ""))
        self.key_entry = self.entry(row1, self.key_var, show="•")
        self.key_entry.pack(side="left", fill="x", expand=True, ipady=3)
        self.show_var = tk.BooleanVar(value=False)
        tk.Checkbutton(row1, text="显示", variable=self.show_var, command=self.toggle_show,
                       bg="#1b2130", fg="#8fa3bf", selectcolor="#0f1420", activebackground="#1b2130",
                       font=("Microsoft YaHei UI", 8)).pack(side="left", padx=(6, 0))

        row2 = tk.Frame(model, bg="#1b2130")
        row2.pack(fill="x", padx=14, pady=6)
        tk.Label(row2, text="模型", width=9, anchor="w", fg="#c9d6e8", bg="#1b2130",
                 font=("Microsoft YaHei UI", 9)).pack(side="left")
        self.model_var = tk.StringVar(value=self.cfg.get("model", "deepseek-flash"))
        self.entry(row2, self.model_var).pack(side="left", fill="x", expand=True, ipady=3)

        row3 = tk.Frame(model, bg="#1b2130")
        row3.pack(fill="x", padx=14, pady=(6, 12))
        tk.Label(row3, text="API 地址", width=9, anchor="w", fg="#c9d6e8", bg="#1b2130",
                 font=("Microsoft YaHei UI", 9)).pack(side="left")
        self.base_var = tk.StringVar(value=self.cfg.get("baseUrl", "https://api.deepseek.com"))
        self.entry(row3, self.base_var).pack(side="left", fill="x", expand=True, ipady=3)

        self.run_btn = tk.Button(root, text="保存并运行", command=self.on_run, bg="#2f6df6", fg="#ffffff",
                                 activebackground="#3b79ff", activeforeground="#ffffff", relief="flat",
                                 font=("Microsoft YaHei UI", 15, "bold"))
        self.run_btn.pack(fill="x", padx=24, pady=(10, 8), ipady=7)

        self.auto_var = tk.BooleanVar(value=bool(self.cfg.get("autostart")))
        tk.Checkbutton(root, text="开机自启动（登录后自动把桌宠拉起来）", variable=self.auto_var,
                       command=self.on_autostart, bg="#12161f", fg="#a9b8ce", selectcolor="#1b2130",
                       activebackground="#12161f", font=("Microsoft YaHei UI", 9)).pack(anchor="w", padx=22)

        tk.Label(root, text="状态", fg="#5d6d85", bg="#12161f",
                 font=("Microsoft YaHei UI", 8)).pack(anchor="w", padx=24, pady=(8, 2))
        stbox = tk.Frame(root, bg="#1b2130", highlightbackground="#2c3547", highlightthickness=1)
        stbox.pack(fill="both", expand=True, padx=24)
        self.status = tk.Text(stbox, height=9, bg="#1b2130", fg="#b7c7dd", relief="flat",
                              font=("Consolas", 9), wrap="none")
        self.status.pack(fill="both", expand=True, padx=10, pady=8)

        bar = tk.Frame(root, bg="#12161f")
        bar.pack(fill="x", padx=24, pady=10)
        tk.Button(bar, text="创建桌面快捷方式", command=self.on_shortcut, bg="#1b2130", fg="#c9d6e8",
                  relief="flat", font=("Microsoft YaHei UI", 8)).pack(side="left")
        tk.Button(bar, text="停止桌宠", command=self.on_stop, bg="#1b2130", fg="#c9d6e8",
                  relief="flat", font=("Microsoft YaHei UI", 8)).pack(side="left", padx=8)
        tk.Button(bar, text="刷新状态", command=self.refresh, bg="#1b2130", fg="#c9d6e8",
                  relief="flat", font=("Microsoft YaHei UI", 8)).pack(side="right")

        self.render()
        self.root.after(100, self.auto_refresh)
        if "--autostart" in sys.argv:
            self.root.after(1200, self.on_run)

    def section(self, parent, title):
        frame = tk.Frame(parent, bg="#1b2130", highlightbackground="#2c3547", highlightthickness=1)
        frame.pack(fill="x", padx=24, pady=(0, 10))
        tk.Label(frame, text=title, anchor="w", fg="#7f92ad", bg="#1b2130",
                 font=("Microsoft YaHei UI", 8, "bold")).pack(fill="x", padx=14, pady=(8, 0))
        return frame

    def entry(self, parent, variable, show=""):
        return tk.Entry(parent, textvariable=variable, show=show, bg="#0f1420", fg="#e6eefc",
                        insertbackground="#e6eefc", relief="flat")

    def textbox(self, parent, height):
        return tk.Text(parent, height=height, bg="#0f1420", fg="#e6eefc", insertbackground="#e6eefc",
                       relief="flat", wrap="word", font=("Microsoft YaHei UI", 9),
                       padx=8, pady=6)

    def choose_voice_ref(self):
        path = filedialog.askopenfilename(title="选择克隆音色参考音频",
                                          filetypes=[("WAV 音频", "*.wav"), ("所有文件", "*.*")])
        if path:
            self.voice_ref_var.set(path)

    def toggle_show(self):
        self.key_entry.config(show="" if self.show_var.get() else "•")

    def log(self, msg):
        try:
            with io.open(os.path.join(BASE, "launcher.log"), "a", encoding="utf-8") as lf:
                lf.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))
        except OSError:
            pass
        self.root.after(0, self._append_log, str(msg))

    def _append_log(self, msg):
        self.lines.append(time.strftime("%H:%M:%S ") + msg)
        self.lines = self.lines[-12:]
        self.render()

    def render(self):
        if not hasattr(self, "status"):
            return
        self.status.delete("1.0", "end")
        for line in self.state_lines + [""] + self.lines:
            self.status.insert("end", line + "\n")

    def collect(self):
        self.cfg.update({
            "petName": self.name_var.get().strip() or "哦鲸鲸",
            "persona": self.persona_text.get("1.0", "end").strip(),
            "speechReference": self.speech_text.get("1.0", "end").strip(),
            "voiceRef": self.voice_ref_var.get().strip(),
            "apiKey": self.key_var.get().strip(),
            "model": self.model_var.get().strip() or "deepseek-flash",
            "baseUrl": self.base_var.get().strip() or "https://api.deepseek.com",
            "autostart": bool(self.auto_var.get()),
        })
        return self.cfg

    def prepare_runtime(self, cfg):
        ensure_main_config()
        ensure_peek_cfg(cfg.get("speechReference", ""))
        write_pet_config(
            cfg.get("petName", "哦鲸鲸"),
            compose_persona(cfg.get("persona", ""), cfg.get("speechReference", "")),
            self.log,
        )
        write_ai_config(cfg)

    def probe_status(self, cfg):
        port = 0
        pid = None
        if _pet_http_ok(3080):
            port, pid = 3080, "port:3080"
        else:
            try:
                runtime = read_json(RUNTIME_FILE, {})
                candidate = int(runtime.get("port") or 0)
                if candidate and candidate != 3080 and _pet_http_ok(candidate):
                    port, pid = candidate, "port:%d" % candidate
            except Exception:
                pass
        if not port and psutil:
            target = os.path.join(PET_PKG, "lib", "standalone.js").lower()
            for proc in psutil.process_iter(["pid", "cmdline"]):
                try:
                    if target in " ".join(proc.info.get("cmdline") or []).lower():
                        pid = proc.info["pid"]
                        break
                except Exception:
                    pass
        health = http_json("http://127.0.0.1:%d/health" % VOICE_PORT, 0.8) or {}
        return {
            "pid": pid,
            "port": port,
            "voice": health,
            "peek": read_json(PEEK_FILE, DEFAULT_PEEK),
            "model": cfg.get("model", "deepseek-flash"),
            "has_key": bool(cfg.get("apiKey")),
        }

    def apply_status(self, status):
        self.refresh_inflight = False
        voice = status.get("voice") or {}
        if voice.get("ready"):
            voice_text = "就绪  :%d" % VOICE_PORT
        elif voice.get("loading"):
            voice_text = "模型加载中（桌宠可先用）"
        elif voice.get("error"):
            voice_text = "加载失败：" + str(voice.get("error"))[:36]
        else:
            voice_text = "未运行（会用系统语音）"
        self.state_lines = [
            pad("桌宠", 10) + ("运行中  pid %s" % status.get("pid") if status.get("pid") else "未运行"),
            pad("桌宠接口", 10) + ("127.0.0.1:%d/dsh-pet-7340" % status["port"] if status.get("port") else "还没起来"),
            pad("语音服务", 10) + voice_text,
            pad("AI", 10) + ("已配置  %s" % status.get("model") if status.get("has_key") else "未填 API Key"),
            pad("陪玩模式", 10) + ("开（右键桌宠可关）" if (status.get("peek") or {}).get("enabled") else "关"),
        ]
        self.render()

    def refresh(self):
        if self.refresh_inflight:
            return
        self.refresh_inflight = True
        cfg = dict(self.collect())

        def work():
            try:
                status = self.probe_status(cfg)
            except Exception:
                status = {"pid": None, "port": 0, "voice": {}, "peek": {}, "model": cfg.get("model"), "has_key": bool(cfg.get("apiKey"))}
            self.root.after(0, self.apply_status, status)

        threading.Thread(target=work, daemon=True, name="status-probe").start()

    def auto_refresh(self):
        self.refresh()
        if not self.stopping:
            self.root.after(3000, self.auto_refresh)

    def on_run(self):
        if self.run_inflight:
            return
        cfg = self.collect()
        save_cfg(cfg)
        if not cfg.get("apiKey") and "--autostart" not in sys.argv:
            if not messagebox.askokcancel("还没填 API Key",
                                          "没填 API Key 也能把桌宠拉起来，但它看不见画面、也不会说话。\n"
                                          "要它陪玩，请填一个能看图的 API（DeepSeek 的 deepseek-flash 就支持看图）。\n\n"
                                          "现在先不填，直接运行吗？"):
                return
        self.run_inflight = True
        self.run_btn.config(state="disabled", text="启动中…")
        self.log("开始启动（桌宠和语音并行加载）…")

        def work():
            try:
                self.prepare_runtime(cfg)
                voice = threading.Thread(target=self.start_voice_worker, args=(cfg,), daemon=True,
                                         name="voice-start")
                voice.start()
                start_pet(cfg, self.log)
            except Exception:
                import traceback
                self.log("运行出错：" + traceback.format_exc().replace("\n", " | ")[:500])
            finally:
                self.root.after(0, self.finish_run)

        threading.Thread(target=work, daemon=True, name="pet-start").start()

    def start_voice_worker(self, cfg):
        if not os.path.exists(PYTHON):
            self.log("没有安装语音包：先用系统语音，克隆音色稍后安装语音包即可")
            return
        start_voice(self.log, cfg.get("voiceRef", ""))

    def finish_run(self):
        self.run_inflight = False
        self.run_btn.config(state="normal", text="保存并运行")
        self.refresh()

    def on_stop(self):
        if self.run_inflight:
            return
        self.run_inflight = True
        self.run_btn.config(state="disabled", text="正在停止…")

        def work():
            n = kill_by_cmdline("standalone.js") + kill_by_cmdline("pet-voice\\server.py") + kill_by_cmdline("pet-voice/server.py")
            self.log("已停掉 %d 个进程" % n)
            self.root.after(0, self.finish_run)

        threading.Thread(target=work, daemon=True, name="pet-stop").start()

    def on_autostart(self):
        cfg = self.collect()
        save_cfg(cfg)
        set_autostart(cfg["autostart"])
        self.log("开机自启动：" + ("开" if cfg["autostart"] else "关"))

    def on_shortcut(self):
        lnk = os.path.join(desktop_dir(), TITLE + ".lnk")
        make_shortcut(lnk, launch_target(), "", BASE, launch_target())
        self.log("桌面快捷方式已创建")


def _main_guarded():
    try:
        main()
    except Exception:
        import traceback
        try:
            with open(os.path.join(BASE, 'launcher.log'), 'a', encoding='utf-8') as fh:
                fh.write('[FATAL] ' + traceback.format_exc().replace(chr(10), ' | ') + chr(10))
        except Exception:
            pass

def main():
    root = tk.Tk()
    ui = App(root)
    if "--selftest" in sys.argv:
        root.after(1500, ui.on_run)
        root.after(45000, root.destroy)
    root.mainloop()


if __name__ == "__main__":
    _main_guarded()
