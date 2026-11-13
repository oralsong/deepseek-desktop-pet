/**
 * dsh-pet「陪玩」模块（0.3.8 补丁附带，独立文件，不参与打包）
 *
 * 职责：定时截一张小图做**画面变化检测**；变化够大时截一张大图，作为图片块喂给视觉模型，
 * 让它说一句"坐在旁边看你打游戏"的点评。真正的生成仍在宿主侧完成（复用桌宠的人设 + 气泡链路），
 * 这里只提供：配置、截屏、差分、图片附件、带图的一次生成。
 *
 * 设计约束（来自宿主现状）：
 * - 宿主只加载 lib/index.js（tsdown 单文件 bundle），所以新逻辑放在旁边的文件里，由补丁注入 import。
 * - 配置独立放 <dshHome>/dsh-pet/peek.json：**不碰** dsh-pet 自己的 main-config 校验器，升级也不会冲突。
 * - 截屏走 PowerShell + System.Drawing（无需任何 npm 依赖），DPI 感知在脚本里声明。
 * - 只在有变化时生成；失败一律原样返回结构化原因，不吞。
 */
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, unlink, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * 宿主自带的服务包（@deepseek-ai/dsh-llm）。
 * 这里**故意用动态 import**：dsh-pet 的 bundle 在文件顶部静态 import 同样的包，说明宿主有自己的解析器；
 * 万一解析不到，静态 import 会让整个桌宠加载失败，动态 import 只影响「陪玩说话」这一条路。
 */
let llmModule = null;
async function loadLlm() {
	if (llmModule) return llmModule;
	llmModule = await import("@deepseek-ai/dsh-llm");
	return llmModule;
}

/** 配置文件名（放在 dsh-pet 的用户目录里） */
export const PEEK_CONFIG_FILE = "peek.json";
/** 截屏脚本（与本文件同目录） */
export const PEEK_SCRIPT_FILE = "peek-capture.ps1";

/**
 * 最近一次 loadPeekConfig 的结果（目录 + 解析后的配置）。
 * 让 generatePeekLine / speakLine 这些"拿不到 cfg"的路径也能用配置（记忆文件就放在同一个目录）。
 */
let lastConfigDir = "";
let lastCfg = null;

/** 默认配置。字段都可以在 peek.json 里逐项覆盖。 */
export const PEEK_DEFAULTS = {
	/** 总开关 */
	enabled: false,
	/** 看哪只桌宠（留空 = 配置里的第一只） */
	petId: "",
	/** 多少秒看一眼（最小 2） */
	intervalSec: 4,
	/** 画面变化阈值（0~1，整屏平均像素差；越大越迟钝） */
	minChange: 0.04,
	/** 变化得"铺开"到多少格才算真的换了画面（整屏 8x6=48 格；桌宠自带动画只占几格） */
	minCells: 10,
	/** 单格算"变了"的门槛（0~1 的通道差） */
	cellDiff: 0.1,
	/** 说过一句之后多少秒内不再说话（最小 10） */
	cooldownSec: 15,
	/** 变化不够时安静（true）；false = 每次都生成 */
	silentWhenIdle: true,
	/** 送模型的那张图的宽度上限（0 = 原始分辨率） */
	maxWidth: 1280,
	/** 送模型的那张 JPEG 质量（40~95，越高越大越慢） */
	quality: 85,
	/** 变化检测用的小图尺寸 */
	smallWidth: 96,
	smallHeight: 54,
	/** 单次截屏超时（ms） */
	captureTimeoutMs: 15000,
	/** 生成超时（ms） */
	generateTimeoutMs: 45000,
	/** 写 peek-log.jsonl 便于调阈值 */
	debugLog: false,
	/** 自定义指令（留空用内置中文指令） */
	prompt: "",
	/** 手动指定模型 provider（留空 = 自动跟随宿主当前对话的模型） */
	provider: "",
	/** 手动指定模型 id */
	model: "",
	/** 前台全屏程序（打游戏）时把桌宠钉住不动，只说话不乱跑 */
	quietOnFullscreen: true,
	/** 让它念出气泡里的话（Windows SAPI 合成，离线） */
	speak: true,
	/** 音色（留空 = 自动挑一个中文语音） */
	speakVoice: "",
	/** 语速 -10~10 */
	speakRate: 1,
	/** 音量 0~100 */
	speakVolume: 90,
	/** 克隆音色服务地址（留空 = 只用 SAPI）。例：http://127.0.0.1:8848 */
	voiceService: "",
	/** 服务脚本路径（服务没起来时用它自启） */
	voiceServerScript: "",
	/** 启动服务用的解释器 */
	voicePython: "python",
	/** edge-tts 的音色名 */
	voiceName: "zh-CN-XiaoyiNeural",
	/** 换音色强度 0~1（越大越像目标音色、越含糊） */
	voiceTau: 0.45,
	/** 记一点事：在玩什么游戏 + 最近说过的话，省得每次都问「你在玩什么」 */
	memory: true,
	/** 记忆里保留多少条最近说的话（1~24） */
	memoryLines: 6
};

function num(raw, fallback, min, max) {
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/** 读配置（缺失/损坏都回落到默认值，绝不抛）。首次会自动写一份默认文件。 */
export async function loadPeekConfig(dir) {
	const path = join(dir, PEEK_CONFIG_FILE);
	let raw = null;
	let created = false;
	let error;
	try {
		raw = JSON.parse(await readFile(path, "utf8"));
	} catch (e) {
		if (e && e.code === "ENOENT") {
			created = true;
			try {
				await mkdir(dir, { recursive: true });
				await writeFile(path, JSON.stringify(PEEK_DEFAULTS, null, "\t") + "\n", "utf8");
				raw = {};
			} catch (e2) {
				error = e2 instanceof Error ? e2.message : String(e2);
				raw = {};
			}
		} else {
			error = "peek.json 解析失败，已按默认值运行：" + (e instanceof Error ? e.message : String(e));
			raw = {};
		}
	}
	const src = raw && typeof raw === "object" ? raw : {};
	const cfg = {
		enabled: src.enabled === true,
		petId: typeof src.petId === "string" ? src.petId.trim() : "",
		intervalSec: num(src.intervalSec, PEEK_DEFAULTS.intervalSec, 2, 3600),
		minChange: num(src.minChange, PEEK_DEFAULTS.minChange, 0, 1),
		minCells: num(src.minCells, PEEK_DEFAULTS.minCells, 0, GRID_COLS * GRID_ROWS),
		cellDiff: num(src.cellDiff, PEEK_DEFAULTS.cellDiff, 0.01, 1),
		cooldownSec: num(src.cooldownSec, PEEK_DEFAULTS.cooldownSec, 10, 86400),
		silentWhenIdle: src.silentWhenIdle !== false,
		maxWidth: num(src.maxWidth, PEEK_DEFAULTS.maxWidth, 0, 4096),
		quality: num(src.quality, PEEK_DEFAULTS.quality, 40, 95),
		smallWidth: num(src.smallWidth, PEEK_DEFAULTS.smallWidth, 32, 320),
		smallHeight: num(src.smallHeight, PEEK_DEFAULTS.smallHeight, 18, 240),
		captureTimeoutMs: num(src.captureTimeoutMs, PEEK_DEFAULTS.captureTimeoutMs, 2000, 60000),
		generateTimeoutMs: num(src.generateTimeoutMs, PEEK_DEFAULTS.generateTimeoutMs, 5000, 180000),
		debugLog: src.debugLog === true,
		prompt: typeof src.prompt === "string" ? src.prompt.trim() : "",
		provider: typeof src.provider === "string" ? src.provider.trim() : "",
		model: typeof src.model === "string" ? src.model.trim() : "",
		quietOnFullscreen: src.quietOnFullscreen !== false,
		speak: src.speak !== false,
		speakVoice: typeof src.speakVoice === "string" ? src.speakVoice.trim() : "",
		speakRate: num(src.speakRate, PEEK_DEFAULTS.speakRate, -10, 10),
		speakVolume: num(src.speakVolume, PEEK_DEFAULTS.speakVolume, 0, 100),
		voiceService: typeof src.voiceService === "string" ? src.voiceService.trim().replace(/\/+$/, "") : "",
		voiceServerScript: typeof src.voiceServerScript === "string" ? src.voiceServerScript.trim() : "",
		voicePython: typeof src.voicePython === "string" && src.voicePython.trim() ? src.voicePython.trim() : PEEK_DEFAULTS.voicePython,
		voiceName: typeof src.voiceName === "string" && src.voiceName.trim() ? src.voiceName.trim() : PEEK_DEFAULTS.voiceName,
		voiceTau: num(src.voiceTau, PEEK_DEFAULTS.voiceTau, 0, 1),
		memory: src.memory !== false,
		memoryLines: Math.round(num(src.memoryLines, PEEK_DEFAULTS.memoryLines, 1, 24))
	};
	lastConfigDir = dir;
	lastCfg = cfg;
	return { path, cfg, created, error };
}

/**
 * 改陪玩总开关（右击菜单用）。只动 peek.json 的 enabled 一项，其余原样保留。
 * 写盘必须是**无 BOM 的 UTF-8**：带 BOM 会让 JSON.parse 失败、整份配置回落默认值。
 * 返回 true / false（写失败）。
 */
export async function setPeekEnabled(dir, enabled) {
	const path = join(dir, PEEK_CONFIG_FILE);
	let raw = {};
	try {
		raw = JSON.parse(await readFile(path, "utf8"));
	} catch {
		raw = {};
	}
	if (!raw || typeof raw !== "object") raw = {};
	raw.enabled = enabled === true;
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(path, JSON.stringify(raw, null, "\t") + "\n", "utf8");
		return true;
	} catch {
		return false;
	}
}

/** 内置指令：只让它说"此刻新发生的事"，别念界面文字 */
export const PEEK_HINT = [
	"你是陪玩模式：用户正在电脑前打游戏，你坐在旁边陪他看屏幕。",
	"下面这张图是**此刻屏幕的一帧**。用一句中文说出来，15~30 字，像朋友在旁边随口点评。",
	"要求：",
	"1. 只说图里**正在发生**的具体事（战斗、血量、比分、死亡、加载、进入新场景、卡住、界面报错…）。",
	"2. 不要念界面上的文字/菜单/按钮名，不要提分辨率、窗口、桌面图标。",
	"3. 不要问“你在玩什么”，要像已经看懂了。",
	"4. 不要堆感叹号，不要 emoji，不加引号，直接给那一句话。",
	"5. 如果画面没有值得说的新变化（比如纯桌面、静止画面），**只回复 SKIP**。"
].join("\n");

function scriptPath() {
	return join(dirname(fileURLToPath(import.meta.url)), PEEK_SCRIPT_FILE);
}

function runPowerShell(args, timeoutMs) {
	return new Promise((resolve) => {
		let done = false;
		let child;
		try {
			// 不接 stdout/stderr 管道（宿主环境里管道可能被限制）：结果一律走 -Meta 文件
			child = spawn("powershell.exe", args, { windowsHide: true, stdio: "ignore" });
		} catch (e) {
			return resolve({ ok: false, code: null, error: e instanceof Error ? e.message : String(e) });
		}
		const timer = setTimeout(() => {
			if (done) return;
			done = true;
			try { child.kill(); } catch { }
			resolve({ ok: false, code: null, error: "截屏超时（" + timeoutMs + "ms）" });
		}, timeoutMs);
		child.on("error", (e) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ ok: false, code: null, error: e instanceof Error ? e.message : String(e) });
		});
		child.on("close", (code) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ ok: code === 0, code, error: code === 0 ? undefined : "截屏进程退出码 " + code });
		});
	});
}

async function readMeta(path) {
	try {
		const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "").trim();
		if (!text) return null;
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/* ───────────────────────── 常驻截屏 worker ─────────────────────────
 * 一次性 powershell.exe 每次要付 ~1.2s 的进程启动费（抓屏本身只要 0.1s）。
 * 这里改成开局起一个常驻进程，System.Drawing / DPI / JPEG 编码器只加载一次，
 * 之后每帧只花真正的活：实测 120~170ms（旧路径 1700~1900ms）。
 * 协议见 peek-worker.ps1 文件头；worker 挂了就自动回落一次性进程。
 */

export const PEEK_WORKER_FILE = "peek-worker.ps1";

let workerProc = null;
let workerDir = null;
let workerChain = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveWorkerScript() {
	return join(dirname(fileURLToPath(import.meta.url)), PEEK_WORKER_FILE);
}

async function ensureWorker(cfg) {
	if (workerProc && workerProc.exitCode === null && !workerProc.killed) return { proc: workerProc, dir: workerDir };
	const script = resolveWorkerScript();
	if (!existsSync(script)) return null;
	// 独占一个目录：宿主用它自己那份，测试脚本可用 PEEK_WORKER_DIR 指到别处，免得互相抢同一个 req.json
	const dir = process.env.PEEK_WORKER_DIR || join(tmpdir(), "dsh-pet-peek-worker");
	await mkdir(dir, { recursive: true }).catch(() => { });
	// 上次进程被硬杀会留下 req/work 文件，清掉免得 worker 一启动就去做一单过期请求
	for (const f of ["req.json", "work.json", "stop"]) {
		try { await unlink(join(dir, f)); } catch { }
	}
	let proc;
	try {
		proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Dir", dir], { windowsHide: true, stdio: "ignore" });
	} catch {
		return null;
	}
	proc.on("error", () => { if (workerProc === proc) { workerProc = null; workerDir = null; } });
	proc.on("exit", () => { if (workerProc === proc) { workerProc = null; workerDir = null; } });
	workerProc = proc;
	workerDir = dir;
	return { proc, dir };
}

async function killWorker() {
	const proc = workerProc;
	workerProc = null;
	workerDir = null;
	if (!proc) return;
	try { proc.kill(); } catch { }
}

/** 提前把常驻 worker 拉起来（插件启动时调一次，第一帧就不用付 1.2s 启动费） */
export async function warmPeekWorker(cfg) {
	try {
		const st = await ensureWorker(cfg);
		return Boolean(st);
	} catch {
		return false;
	}
}

/** 关掉常驻 worker（插件 dispose 时调；不调也只是多留一个空转进程） */
export async function stopPeekWorker() {
	if (!workerProc || !workerDir) return;
	try { await writeFile(join(workerDir, "stop"), "", "utf8"); } catch { }
	await sleep(200);
	await killWorker();
}

async function captureViaWorker(cfg, fmt) {
	const st = await ensureWorker(cfg);
	if (!st) return null;
	const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
	const shotFile = join(st.dir, stamp + (fmt === "png" ? ".png" : ".jpg"));
	const smallFile = join(st.dir, stamp + ".bmp");
	const metaFile = join(st.dir, stamp + ".json");
	const req = {
		meta: metaFile,
		out: shotFile,
		small: smallFile,
		format: fmt,
		width: Math.round(cfg.smallWidth),
		height: Math.round(cfg.smallHeight),
		maxWidth: Math.round(cfg.maxWidth),
		quality: Math.round(cfg.quality ?? 85)
	};
	const cleanup = async () => {
		for (const f of [shotFile, smallFile, metaFile]) {
			try { await unlink(f); } catch { }
		}
	};
	try {
		await writeFile(join(st.dir, "req.tmp"), JSON.stringify(req), "utf8");
		await rename(join(st.dir, "req.tmp"), join(st.dir, "req.json"));
	} catch (e) {
		await killWorker();
		return { ok: false, reason: "capture-error", message: "投递截屏请求失败：" + (e instanceof Error ? e.message : String(e)) };
	}
	const deadline = Date.now() + Math.max(1000, cfg.captureTimeoutMs);
	let meta = null;
	while (Date.now() < deadline) {
		meta = await readMeta(metaFile);
		if (meta) break;
		await sleep(8);
	}
	if (!meta) {
		// worker 卡死/被杀：停掉它，下次调用会重新拉起，本次回落一次性进程
		await killWorker();
		await cleanup();
		return { ok: false, reason: "capture-timeout", message: "常驻截屏进程无响应（" + cfg.captureTimeoutMs + "ms）" };
	}
	let out;
	if (meta.ok !== true) {
		out = { ok: false, reason: "capture-error", message: "截屏失败" + (meta.error ? "：" + meta.error : "") };
	} else {
		try {
			const small = await readFile(smallFile);
			const shot = fmt === "none" ? null : await readFile(shotFile);
			out = small.length === 0 ? { ok: false, reason: "capture-error", message: "截屏结果为 0 字节" } : {
				ok: true,
				small,
				shot,
				format: fmt,
				screenWidth: Number(meta.width) || undefined,
				screenHeight: Number(meta.height) || undefined,
				ms: meta.ms,
				via: "worker"
			};
		} catch (e) {
			out = { ok: false, reason: "capture-error", message: "读不到截图文件：" + (e instanceof Error ? e.message : String(e)) };
		}
	}
	await cleanup();
	return out;
}

/**
 * 问常驻 worker：现在前台是不是一个全屏程序（打游戏）。
 * 返回 {ok:true, fullscreen:boolean, title, cls} 或 {ok:false, reason}。
 */
async function probeViaWorker(cfg) {
	const st = await ensureWorker(cfg);
	if (!st) return null;
	const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
	const metaFile = join(st.dir, stamp + "-probe.json");
	try {
		await writeFile(join(st.dir, "req.tmp"), JSON.stringify({ cmd: "probe", meta: metaFile }), "utf8");
		await rename(join(st.dir, "req.tmp"), join(st.dir, "req.json"));
	} catch {
		await killWorker();
		return null;
	}
	const deadline = Date.now() + Math.max(1000, cfg.captureTimeoutMs);
	let meta = null;
	while (Date.now() < deadline) {
		meta = await readMeta(metaFile);
		if (meta) break;
		await sleep(8);
	}
	try { await unlink(metaFile); } catch { }
	if (!meta || meta.ok !== true) return null;
	return { ok: true, fullscreen: meta.fullscreen === true, title: String(meta.title ?? ""), cls: String(meta.cls ?? "") };
}

/** 前台是否全屏（打游戏）。worker 起不来就返回 {ok:false}，调用方按"未知"处理。 */
export async function probeFullscreen(cfg) {
	const p = workerChain.then(() => probeViaWorker(cfg));
	workerChain = p.catch(() => { });
	const r = await p;
	return r ?? { ok: false, reason: "probe-unavailable" };
}

/**
 * 让它开口：把这句话交给常驻 worker 用 Windows SAPI 合成并播放（离线，不花 token）。
 * 播放是异步的，这里只等到合成完成（约 0.3~1s），不等整句念完。
 * speakLine 本体负责串行 + 失败换一个干净 worker 重试一次。
 */
/** 语音服务是否活着并已加载好模型 */
async function voiceServiceReady(cfg) {
	if (!cfg.voiceService) return false;
	try {
		const r = await fetch(cfg.voiceService + "/health", { signal: AbortSignal.timeout(1500) });
		if (!r.ok) return false;
		const j = await r.json();
		return Boolean(j && j.ready === true);
	} catch {
		return false;
	}
}

/** 服务没起来就拉起来（python 常驻，加载模型约 8~15 秒） */
async function ensureVoiceService(cfg) {
	if (await voiceServiceReady(cfg)) return true;
	if (!cfg.voiceServerScript) return false;
	if (!cfg.voicePython || !existsSync(cfg.voicePython) || !existsSync(cfg.voiceServerScript)) {
		console.warn("[dsh-pet:peek] 语音包未安装，跳过克隆语音服务，改用系统语音");
		return false;
	}
	const port = (cfg.voiceService.match(/:(\d+)/) || [, "8848"])[1];
	try {
		const child = spawn(cfg.voicePython, [cfg.voiceServerScript, "--port", port], { detached: true, stdio: "ignore", windowsHide: true });
		const started = await new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), 3000);
			child.once("spawn", () => {
				clearTimeout(timer);
				resolve(true);
			});
			child.once("error", (e) => {
				clearTimeout(timer);
				console.warn("[dsh-pet:peek] 拉起语音服务失败：" + (e && e.message ? e.message : String(e)));
				resolve(false);
			});
		});
		if (!started) {
			try { child.kill(); } catch { }
			return false;
		}
		child.unref();
		console.log("[dsh-pet:peek] 正在拉起语音服务 " + cfg.voiceService);
	} catch (e) {
		console.warn("[dsh-pet:peek] 拉起语音服务失败：" + (e && e.message ? e.message : String(e)));
		return false;
	}
	const deadline = Date.now() + 45000;
	while (Date.now() < deadline) {
		await sleep(700);
		if (await voiceServiceReady(cfg)) return true;
	}
	return false;
}

async function speakViaService(cfg, text, opts = {}) {
	if (!(await ensureVoiceService(cfg))) return { ok: false, reason: "voice-service-unavailable" };
	const play = opts.play !== false;
	const t0 = Date.now();
	try {
		const r = await fetch(cfg.voiceService + "/say", {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify({ text, voice: cfg.voiceName, tau: cfg.voiceTau, play, split: cfg.voiceSplit !== false }),
			signal: AbortSignal.timeout(60000)
		});
		const j = await r.json().catch(() => null);
		if (!r.ok || !j || j.ok !== true) {
			return { ok: false, reason: "voice-service-error", message: (j && (j.message || j.reason)) || "HTTP " + r.status };
		}
		return { ok: true, via: "service", ms: Date.now() - t0, seconds: j.seconds, edgeMs: j.edgeMs, convMs: j.convMs, file: j.file };
	} catch (e) {
		return { ok: false, reason: "voice-service-error", message: e && e.message ? e.message : String(e) };
	}
}

/** 播放已经合成好的 wav（配合 speakLine(cfg, text, { play:false }) 用：
 *  先合成、再和气泡一起出门，避免"文字先蹦出来、声音晚一秒到"）。 */
export async function playFile(cfg, file) {
	if (!cfg.voiceService || !file) return { ok: false, reason: "no-service" };
	try {
		const r = await fetch(cfg.voiceService + "/play", {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify({ file }),
			signal: AbortSignal.timeout(10000)
		});
		const j = await r.json().catch(() => null);
		return r.ok && j && j.ok === true ? { ok: true } : { ok: false, reason: "play-failed" };
	} catch (e) {
		return { ok: false, reason: "play-failed", message: e && e.message ? e.message : String(e) };
	}
}

export async function speakLine(cfg, text, opts = {}) {
	const t = String(text ?? "").trim();
	if (!t) return { ok: false, reason: "empty" };
	// 优先走克隆音色服务（Edge 出字 + OpenVoice 换嗓）
	if (cfg.voiceService) {
		const svc = await speakViaService(cfg, t, opts);
		if (svc.ok) return svc;
		console.warn("[dsh-pet:peek] 语音服务不可用（" + svc.reason + (svc.message ? "：" + svc.message : "") + "），回落 SAPI");
	}
	const first = workerChain.then(() => speakViaWorker(cfg, t));
	workerChain = first.catch(() => { });
	const r = await first;
	if (r && r.ok) return r;
	// 超时/worker 不可用：多半是上一个 worker 卡住或已被杀，换一个干净的重试一次
	if (r && (r.reason === "speak-timeout" || r.reason === "worker-unavailable")) {
		await killWorker();
		const second = workerChain.then(() => speakViaWorker(cfg, text));
		workerChain = second.catch(() => { });
		const r2 = await second;
		if (r2 && r2.ok) return r2;
		return { ok: false, reason: (r2 && r2.reason) || r.reason, message: (r2 && r2.message) || r.message };
	}
	return r;
}

async function speakViaWorker(cfg, text) {
	const t = String(text ?? "").trim();
	if (!t) return { ok: false, reason: "empty" };
	const st = await ensureWorker(cfg);
	if (!st) return { ok: false, reason: "worker-unavailable" };
	const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
	const metaFile = join(st.dir, stamp + "-tts.json");
	const req = { cmd: "speak", text: t, voice: cfg.speakVoice || "", rate: Math.round(cfg.speakRate ?? 0), volume: Math.round(cfg.speakVolume ?? 90), meta: metaFile };
	try {
		await writeFile(join(st.dir, "req.tmp"), JSON.stringify(req), "utf8");
		await rename(join(st.dir, "req.tmp"), join(st.dir, "req.json"));
	} catch {
		await killWorker();
		return { ok: false, reason: "speak-error" };
	}
	const deadline = Date.now() + Math.max(2000, (cfg.speakTimeoutMs ?? 15000));
	let meta = null;
	while (Date.now() < deadline) {
		meta = await readMeta(metaFile);
		if (meta) break;
		await sleep(8);
	}
	try { await unlink(metaFile); } catch { }
	if (!meta) return { ok: false, reason: "speak-timeout" };
	if (meta.ok !== true) return { ok: false, reason: "speak-error", message: meta.error };
	return { ok: true, ms: meta.ms, bytes: meta.bytes };
}

async function capture(cfg, opts) {
	const script = scriptPath();
	if (!existsSync(script)) return { ok: false, reason: "capture-missing", message: "缺少截屏脚本：" + script };
	const fmt = opts.format === "png" ? "png" : opts.format === "none" ? "none" : "jpg";
	// 先走常驻 worker（~0.15s）；worker 起不来/超时才回落一次性进程（~1.8s）
	const viaWorker = workerChain.then(() => captureViaWorker(cfg, fmt));
	workerChain = viaWorker.catch(() => { });
	const w = await viaWorker;
	if (w && w.ok) return w;
	// worker 起不来（null）或单帧失败 → 回落一次性进程；只有"超时"是明确别等第二次
	if (w && w.reason === "capture-timeout") return w;
	if (w && w.reason !== "capture-error") return w;
	return captureOnce(cfg, fmt);
}

async function captureOnce(cfg, fmt) {
	const script = scriptPath();
	const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
	// 一个进程只拷一次屏，同时产出：小图 BMP（差分） + 模型帧 JPEG（只有触发上传时才用）
	const shotFile = join(tmpdir(), "dsh-pet-peek-" + stamp + (fmt === "png" ? ".png" : ".jpg"));
	const smallFile = join(tmpdir(), "dsh-pet-peek-" + stamp + ".bmp");
	const metaFile = join(tmpdir(), "dsh-pet-peek-" + stamp + ".json");
	const args = [
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy", "Bypass",
		"-File", script,
		"-Out", shotFile,
		"-Small", smallFile,
		"-Meta", metaFile,
		"-Format", fmt,
		"-Width", String(Math.round(cfg.smallWidth)),
		"-Height", String(Math.round(cfg.smallHeight)),
		"-MaxWidth", String(Math.round(cfg.maxWidth)),
		"-Quality", String(Math.round(cfg.quality ?? 85))
	];
	const r = await runPowerShell(args, cfg.captureTimeoutMs);
	const meta = await readMeta(metaFile);
	let out;
	if (!r.ok) out = { ok: false, reason: "capture-error", message: r.error ?? "截屏失败" };
	else if (!meta || meta.ok !== true) out = { ok: false, reason: "capture-error", message: "截屏失败" + (meta && meta.error ? "：" + meta.error : "（没有结果文件）") };
	else {
		try {
			const small = await readFile(smallFile);
			const shot = fmt === "none" ? null : await readFile(shotFile);
			if (small.length === 0) out = { ok: false, reason: "capture-error", message: "截屏结果为 0 字节" };
			else out = {
				ok: true,
				small,
				shot,
				format: fmt,
				screenWidth: Number(meta.width) || undefined,
				screenHeight: Number(meta.height) || undefined,
				ms: meta.ms
			};
		} catch (e) {
			out = { ok: false, reason: "capture-error", message: "读不到截图文件：" + (e instanceof Error ? e.message : String(e)) };
		}
	}
	for (const f of [shotFile, smallFile, metaFile]) {
		try { await unlink(f); } catch { }
	}
	return out;
}

/** 采一帧：小图（差分用）+ 模型帧（JPEG，先拿在手里，只有真要说话才上传）。一次进程搞定。 */
export async function captureFrame(cfg) {
	return capture(cfg, { format: "jpg" });
}

/** 只要小图：最省的采样方式（不产模型帧，用于手动/测试） */
export async function captureSmall(cfg) {
	return capture(cfg, { format: "none" });
}

/** BMP 的像素数据偏移（跳过文件头，避免把时间戳/尺寸当变化） */
export function bmpPixelOffset(bytes) {
	if (!bytes || bytes.length < 54) return 0;
	const off = bytes.readUInt32LE(10);
	return off > 0 && off < bytes.length ? off : 54;
}

/**
 * 两帧小图的差异分数：0~1（整帧平均通道差 / 255）。
 * 尺寸不同（分辨率变了）直接当 1。
 */
export function frameScore(prev, cur) {
	if (!prev || !cur) return 1;
	const po = bmpPixelOffset(prev);
	const co = bmpPixelOffset(cur);
	const pn = prev.length - po;
	const cn = cur.length - co;
	if (pn <= 0 || pn !== cn) return 1;
	let sum = 0;
	for (let i = 0; i < pn; i++) sum += Math.abs(prev[po + i] - cur[co + i]);
	return sum / pn / 255;
}

/** 网格：8x6 = 48 格。桌宠自己那点动画只占 4~8 格，游戏画面变化会铺满十几格以上。 */
export const GRID_COLS = 8;
export const GRID_ROWS = 6;

/**
 * 差异 + 覆盖率。
 * 只算"整屏平均差"不够：桌宠/时钟/字幕这类局部动画会让整屏分数一直不为 0，
 * 结果没人玩游戏时它也在说话。所以再按网格统计"有多少格真的变了"。
 *
 * @param cellDiff 单格算"变了"的门槛（0~1 的通道差）
 * @returns { score, cells, changedCells } ；无基准时 score=1、全格算变化
 */
export function frameCoverage(prev, cur, cellDiff = 0.1) {
	const cells = GRID_COLS * GRID_ROWS;
	if (!prev || !cur) return { score: 1, cells, changedCells: cells };
	const po = bmpPixelOffset(prev);
	const co = bmpPixelOffset(cur);
	const pn = prev.length - po;
	const cn = cur.length - co;
	if (pn <= 0 || pn !== cn) return { score: 1, cells, changedCells: cells };
	const w = prev.length >= 26 ? prev.readInt32LE(18) : 0;
	const h = prev.length >= 26 ? Math.abs(prev.readInt32LE(22)) : 0;
	if (w <= 0 || h <= 0) return { score: frameScore(prev, cur), cells, changedCells: 0 };
	const perCell = new Float64Array(cells);
	const perCount = new Float64Array(cells);
	let sum = 0;
	let n = 0;
	// 32bpp BMP：每像素 4 字节，跳过 alpha（常量 255，不携带信息）
	for (let y = 0; y < h; y++) {
		const rowBase = y * w * 4;
		const gy = Math.min(GRID_ROWS - 1, Math.floor(y * GRID_ROWS / h));
		for (let x = 0; x < w; x++) {
			const i = rowBase + x * 4;
			if (i + 3 > pn) break;
			const d = Math.abs(prev[po + i] - cur[co + i]) + Math.abs(prev[po + i + 1] - cur[co + i + 1]) + Math.abs(prev[po + i + 2] - cur[co + i + 2]);
			sum += d;
			n += 3;
			const gx = Math.min(GRID_COLS - 1, Math.floor(x * GRID_COLS / w));
			const k = gy * GRID_COLS + gx;
			perCell[k] += d / 3;
			perCount[k] += 1;
		}
	}
	let changedCells = 0;
	const threshold = cellDiff * 255;
	for (let k = 0; k < cells; k++) {
		if (perCount[k] > 0 && perCell[k] / perCount[k] >= threshold) changedCells++;
	}
	return { score: n > 0 ? sum / n / 255 : 0, cells, changedCells };
}

/** 把一帧截图存成宿主附件，返回可直接塞进消息的 image 块 */
export async function attachImage(ctx, bytes, name, mediaType) {
	let att;
	try {
		att = typeof ctx?.get === "function" ? ctx.get("attachments") : ctx?.attachments;
	} catch {
		att = undefined;
	}
	// 插件没声明 inject 时 ctx.get 可能拿不到：退回根上下文再试一次（拿不到就明确报错，不静默降级）
	if (!att) {
		try {
			att = typeof ctx?.root?.get === "function" ? ctx.root.get("attachments") : undefined;
		} catch {
			att = undefined;
		}
	}
	if (!att || typeof att.saveImage !== "function") return {
		ok: false,
		reason: "attachment-unavailable",
		message: "宿主没有 attachments 服务，发不了图"
	};
	try {
		const ref = await att.saveImage({
			data: new Uint8Array(bytes),
			mediaType: mediaType || "image/jpeg",
			name
		});
		return { ok: true, attachment: ref };
	} catch (e) {
		return { ok: false, reason: "attachment-error", message: e instanceof Error ? e.message : String(e) };
	}
}

/** 记忆文件名（与 peek.json 同目录） */
export const PEEK_MEMORY_FILE = "peek-memory.json";

function memoryPath(dir) {
	return join(dir, PEEK_MEMORY_FILE);
}

/**
 * 读小记忆。结构：
 * { v:1, game:"在玩什么", gameAt:时间戳, gameSource:"window-title"|"model",
 *   lines:[{ t:时间戳, text:"说过的话" }], updatedAt:时间戳 }
 * 坏文件一律当空记忆，绝不让它把陪玩搞崩。
 */
export async function loadPeekMemory(dir) {
	const base = { v: 1, game: "", gameAt: 0, gameSource: "", lines: [], updatedAt: 0 };
	if (!dir) return base;
	try {
		const raw = JSON.parse(await readFile(memoryPath(dir), "utf8"));
		if (!raw || typeof raw !== "object") return base;
		const lines = (Array.isArray(raw.lines) ? raw.lines : [])
			.filter((x) => x && typeof x.text === "string" && x.text.trim())
			.map((x) => ({ t: Number(x.t) || 0, text: String(x.text).trim() }))
			.slice(-24);
		return {
			v: 1,
			game: typeof raw.game === "string" ? raw.game.trim() : "",
			gameAt: Number(raw.gameAt) || 0,
			gameSource: typeof raw.gameSource === "string" ? raw.gameSource : "",
			lines,
			updatedAt: Number(raw.updatedAt) || 0
		};
	} catch {
		return base;
	}
}

/** 写小记忆（失败静默：记忆丢了也不该影响说话） */
export async function savePeekMemory(dir, mem) {
	if (!dir || !mem) return false;
	try {
		const out = {
			v: 1,
			game: mem.game || "",
			gameAt: mem.gameAt || 0,
			gameSource: mem.gameSource || "",
			lines: (mem.lines || []).slice(-24),
			updatedAt: Date.now()
		};
		await mkdir(dir, { recursive: true });
		await writeFile(memoryPath(dir), JSON.stringify(out, null, "\t") + "\n", "utf8");
		return true;
	} catch {
		return false;
	}
}

/** 把记忆拼成给模型看的几句话（接在 PEEK_HINT 后面） */
export function peekMemoryHint(mem, cfg) {
	const parts = [];
	if (!mem) return "";
	if (mem.game) {
		parts.push("【记忆】老大已经在玩《" + mem.game + "》。按「你早就知道」来处理，**不要再问他在玩什么游戏**。");
	} else {
		parts.push("【记忆】你还不知道老大在玩什么：如果这一帧能看出来，第一行只写 `GAME: 游戏名`，第二行再写点评。");
	}
	const keep = Math.round(Number(cfg && cfg.memoryLines) || 6);
	const recent = (mem.lines || []).slice(-keep);
	if (recent.length) {
		parts.push("【记忆】你最近说过的话（不要重复，也不要自相矛盾）：");
		for (const l of recent) parts.push("- " + l.text);
	}
	return parts.join("\n");
}

/**
 * 吸收一次模型回复：剥掉 `GAME: xxx` 行（记进记忆），其余当正文。
 * 返回 { text, mem }（mem 已更新，需要调用方写盘）。
 */
export function peekMemoryAbsorb(mem, text) {
	const next = {
		v: 1,
		game: mem && mem.game ? mem.game : "",
		gameAt: mem && mem.gameAt ? mem.gameAt : 0,
		gameSource: mem && mem.gameSource ? mem.gameSource : "",
		lines: mem && Array.isArray(mem.lines) ? mem.lines.slice() : [],
		updatedAt: Date.now()
	};
	let body = String(text ?? "").trim();
	const m = /(?:^|\n)\s*GAME\s*[:：]\s*([^\n]{1,120})/i.exec(body);
	if (m) {
		let name = String(m[1]).replace(/[《》<>"'“”]/g, "").trim();
		// 模型有时把游戏名和正文写在同一行（没有换行）：按标点切开，剩下的还回正文
		const cut = name.search(/[，。！？；、,;!?]/);
		if (cut > 0 || name.length > 24) {
			const idx = cut > 0 ? cut : 24;
			const rest = name.slice(idx + (cut > 0 ? 1 : 0)).trim();
			name = name.slice(0, idx).trim();
			if (rest) body = rest + "\n" + body.replace(/(?:^|\n)\s*GAME\s*[:：][^\n]*/gi, "\n").trim();
			else body = body.replace(/(?:^|\n)\s*GAME\s*[:：][^\n]*/gi, "\n").trim();
		} else {
			body = body.replace(/(?:^|\n)\s*GAME\s*[:：][^\n]*/gi, "\n").trim();
		}
		if (name) {
			next.game = name;
			next.gameAt = Date.now();
			next.gameSource = "model";
		}
	}
	const clean = stripLine(body);
	if (clean) {
		next.lines.push({ t: Date.now(), text: clean });
		if (next.lines.length > 24) next.lines = next.lines.slice(-24);
	}
	return { text: clean, mem: next };
}

export function stripLine(text) {	let t = String(text ?? "");
	// 模型偶尔会把 Markdown/HTML 抄进正文：<img src="https://..."> / ![](url) / [文字](url)
	t = t.replace(/<[^>\n]{0,300}>/g, " ");
	t = t.replace(/!\[[^\]\n]{0,80}\]\([^)\n]{0,300}\)/g, " ");
	t = t.replace(/\[([^\]\n]{0,80})\]\([^)\n]{0,300}\)/g, "$1");
	// 裸链接
	t = t.replace(/https?:\/\/\S+/g, " ");
	// HTML 实体
	t = t.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
	// Markdown 强调/代码标记
	t = t.replace(/[*_`~]{1,3}/g, "");
	// 空白归一
	t = t.replace(/\s+/g, " ").trim();
	// 首尾引号
	t = t.replace(/^["'“”「」『』]+/, "").replace(/["'“”「」『』]+$/, "");
	t = t.trim();
	// 气泡放不下太长的句子：截到 80 字，尽量断在标点后
	if (t.length > 80) {
		const cut = t.slice(0, 80);
		t = cut.replace(/[，、,;；:：\s]+$/, "") + "…";
	}
	return t;
}

/**
 * 带图生成一句陪玩点评。
 * bridge: { modelCandidates(preferred), supportsOff(provider, model), noTextReason(finish), modelLabel(sel) }
 * opts:   { attachment, hint?, preferred?, candidates?, timeoutMs? }
 * 返回 { ok:true, text } | { ok:true, skip:true } | { ok:false, reason, message, tried? }
 */
export async function generatePeekLine(ctx, system, bridge, opts) {
	// 独立模式没有 attachments 服务 ⇒ 拿不到图片块，只能自己把截图直接发给服务商
	const direct = !opts?.attachment && Boolean(opts?.imageBytes);
	// 候选来源：peek.json 里写死的 provider/model（最可靠）→ 桌宠自己的偏好 → 宿主当前选择
	const candidates = [];
	const push = (m) => {
		if (!m || typeof m.provider !== "string" || typeof m.model !== "string") return;
		const provider = m.provider.trim();
		const model = m.model.trim();
		if (!provider || !model) return;
		if (candidates.some((x) => x.provider === provider && x.model === model)) return;
		candidates.push({ provider, model });
	};
	if (Array.isArray(opts?.candidates)) opts.candidates.forEach(push);
	let fromBridge = [];
	try {
		fromBridge = typeof bridge?.modelCandidates === "function" ? bridge.modelCandidates(opts?.preferred) : [];
	} catch { fromBridge = []; }
	if (Array.isArray(fromBridge)) fromBridge.forEach(push);
	const tried = typeof bridge?.modelLabel === "function" ? candidates.map((m) => bridge.modelLabel(m)) : candidates.map((m) => m.provider + "/" + m.model);
	if (!direct && candidates.length === 0) return {
		ok: false,
		reason: "provider-missing",
		message: "没拿到模型。可在 peek.json 里写 \"provider\": \"deepseek-account\", \"model\": \"...\" 手动指定"
	};
	const llm = ctx?.llm;
	if (!direct && (!llm || typeof llm.stream !== "function")) return {
		ok: false,
		reason: "generate-error",
		message: "LLM 服务不可用"
	};
	// ── 小记忆：知道在玩什么、最近说过啥（省得每次都问"你在玩什么"） ──
	const cfg = opts?.cfg && typeof opts.cfg === "object" ? opts.cfg : lastCfg;
	const memDir = typeof opts?.memoryDir === "string" && opts.memoryDir ? opts.memoryDir : lastConfigDir;
	let mem = null;
	let hint = typeof opts?.hint === "string" && opts.hint ? opts.hint : PEEK_HINT;
	if (cfg && cfg.memory !== false && memDir) {
		try {
			mem = await loadPeekMemory(memDir);
			// 还不知道是什么游戏时，用前台窗口标题猜一次（例如 "Phantom Blade Zero"）
			if (!mem.game) {
				try {
					const pr = await probeFullscreen(cfg);
					const title = pr && pr.ok && pr.fullscreen && typeof pr.title === "string" ? pr.title.trim() : "";
					if (title && title.length >= 2) {
						mem.game = title;
						mem.gameAt = Date.now();
						mem.gameSource = "window-title";
						void savePeekMemory(memDir, mem);
					}
				} catch { }
			}
			const memHint = peekMemoryHint(mem, cfg);
			if (memHint) hint = hint + "\n\n" + memHint;
		} catch {
			mem = null;
		}
	}
	const timeoutMs = Number(opts?.timeoutMs) > 0 ? Number(opts.timeoutMs) : 45000;
	let last = {
		ok: false,
		reason: "generate-error",
		message: "生成失败"
	};
	const queue = direct ? [{ provider: "direct", model: "vision" }] : candidates;
	for (const sel of queue) {
		const r = direct
			? await visionDirect(await loadStandaloneAi(memDir), system, hint, opts.imageBytes, timeoutMs)
			: await generateOnce(ctx, llm, sel, system, hint, opts, timeoutMs, bridge);
		if (r.ok) {
			if (mem && memDir && !r.skip && typeof r.text === "string" && r.text) {
				try {
					const abs = peekMemoryAbsorb(mem, r.text);
					if (abs.mem.game !== mem.game && abs.mem.game) abs.mem.gameSource = abs.mem.gameSource || "model";
					mem = abs.mem;
					void savePeekMemory(memDir, mem);
					return { ...r, text: abs.text, game: mem.game };
				} catch { }
			}
			return r;
		}
		last = r;
	}
	return { ...last, tried };
}

/** 独立模式（dsh-pet-standalone）的 AI 设置文件名：与 peek.json 同目录 */
export const STANDALONE_AI_FILE = "standalone-ai.json";

/** 读独立模式的 AI 设置（协议 / 地址 / 模型 / 密钥）。读不到就返回 null。 */
export async function loadStandaloneAi(dir) {
	if (!dir) return null;
	try {
		const raw = JSON.parse(await readFile(join(dir, STANDALONE_AI_FILE), "utf8"));
		const protocol = raw && raw.protocol === "anthropic" ? "anthropic" : "openai-compatible";
		const baseUrl = typeof raw?.baseUrl === "string" ? raw.baseUrl.trim().replace(/\/+$/, "") : "";
		const model = typeof raw?.model === "string" ? raw.model.trim() : "";
		const apiKey = typeof raw?.apiKey === "string" ? raw.apiKey.trim() : "";
		if (!baseUrl || !model || !apiKey) return null;
		return { protocol, baseUrl, model, apiKey, maxTokens: Number(raw?.maxTokens) > 0 ? Number(raw.maxTokens) : 512 };
	} catch {
		return null;
	}
}

/**
 * 独立模式下直接调服务商的视觉接口（没有宿主的 attachments/图片块，只能自己发 base64）。
 * 支持 OpenAI 兼容（image_url）与 Anthropic（base64 source）两种形状。
 */
async function visionDirect(ai, system, hint, bytes, timeoutMs) {
	if (!ai) {
		return {
			ok: false,
			reason: "no-api-key",
			message: "还没有配置 API：请在 App 里填 API Key / 接口地址 / 模型，或点桌宠右键「打开 AI 设置」"
		};
	}
	const b64 = Buffer.from(bytes).toString("base64");
	const dir = ai.protocol === "anthropic" ? "/v1/messages" : "/chat/completions";
	const url = ai.baseUrl + dir;
	let body;
	let headers = { "content-type": "application/json" };
	if (ai.protocol === "anthropic") {
		headers["x-api-key"] = ai.apiKey;
		headers["anthropic-version"] = "2023-06-01";
		body = {
			model: ai.model,
			max_tokens: Math.max(1024, Number(ai.maxTokens) || 0),
			system,
			messages: [{
				role: "user",
				content: [
					{ type: "text", text: hint },
					{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } }
				]
			}]
		};
	} else {
		headers.authorization = "Bearer " + ai.apiKey;
		body = {
			model: ai.model,
			max_tokens: Math.max(1024, Number(ai.maxTokens) || 0),
			messages: [
				{ role: "system", content: system },
				{
					role: "user",
					content: [
						{ type: "text", text: hint },
						{ type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64 } }
					]
				}
			]
		};
	}
	let res;
	try {
		res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(Number(timeoutMs) > 0 ? Number(timeoutMs) : 45000)
		});
	} catch (e) {
		return { ok: false, reason: "generate-error", message: "连不上接口：" + (e instanceof Error ? e.message : String(e)) };
	}
	const raw = await res.text().catch(() => "");
	if (!res.ok) {
		return { ok: false, reason: "generate-error", message: "接口返回 " + res.status + "：" + raw.slice(0, 200) };
	}
	let j;
	try {
		j = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "generate-error", message: "接口返回不是 JSON：" + raw.slice(0, 120) };
	}
	let text = "";
	if (ai.protocol === "anthropic") {
		text = (Array.isArray(j?.content) ? j.content : []).filter((c) => c && c.type === "text").map((c) => c.text || "").join("");
	} else {
		const msg = j?.choices?.[0]?.message;
		text = typeof msg?.content === "string" ? msg.content : Array.isArray(msg?.content) ? msg.content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("") : "";
		// deepseek-flash 是推理模型：正文可能为空，思考写在 reasoning_content 里
		if (!String(text).trim() && typeof msg?.reasoning_content === "string") {
			const rc = msg.reasoning_content;
			const m = rc.match(/["“]([^"”]{4,80})["”]/) || rc.match(/[：:]\s*([^\n]{4,60})$/);
			text = (m ? m[1] : rc).trim();
		}
	}
	text = String(text).trim();
	if (!text) return { ok: false, reason: "generate-error", message: "模型没有返回文本" };
	// 注意：这里**不能**用 stripLine —— 它会把换行压成空格，而记忆吸收要靠「GAME: xxx」独立成行
	// 才能把游戏名和正文分开；清洗留到 peekMemoryAbsorb 之后统一做。
	if (/^skip$/i.test(stripLine(text))) return { ok: true, skip: true };
	return { ok: true, text };
}

/**
 * 环境自检：把"有没有 attachments / 当前模型是什么 / agents 服务长什么样"一次性问清楚。
 * 只读、不抛。给 /peek?debug=1 用。
 */
/**
 * Vision locator for screen actions. Returns normalized center coordinates.
 * Desktop shortcuts and UI Automation are preferred; this is the fallback for
 * controls that expose no accessibility name.
 */
export async function locateScreenTarget(dir, system, query, bytes, timeoutMs) {
	const ai = await loadStandaloneAi(dir);
	if (!ai) return { ok: false, reason: "no-api-key", message: "视觉定位需要先配置 API Key" };
	const hint = [
		"You are locating one clickable target in a Windows screenshot.",
		"Target requested by the user: " + JSON.stringify(String(query || "")),
		"Return ONLY a JSON object, no markdown:",
		'{"found":true,"label":"visible label","x":0.5,"y":0.5,"confidence":0.9}',
		"x and y are the target center normalized to 0..1 relative to the full screenshot.",
		"If the target is not clearly visible, return {\"found\":false,\"confidence\":0}."
	].join("\n");
	const result = await visionDirect(ai, system, hint, bytes, timeoutMs);
	if (!result.ok) return result;
	const match = String(result.text || "").match(/\{[\s\S]*\}/);
	if (!match) return { ok: false, reason: "invalid-vision-response", message: "视觉模型没有返回定位 JSON" };
	let data;
	try {
		data = JSON.parse(match[0]);
	} catch {
		return { ok: false, reason: "invalid-vision-response", message: "视觉定位 JSON 无法解析" };
	}
	const x = Number(data.x);
	const y = Number(data.y);
	const confidence = Number(data.confidence);
	if (data.found !== true || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
		return { ok: true, found: false, confidence: Number.isFinite(confidence) ? confidence : 0 };
	}
	return {
		ok: true,
		found: true,
		x,
		y,
		confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
		label: typeof data.label === "string" ? data.label.slice(0, 120) : ""
	};
}

export async function peekEnv(ctx, bridge, cfg) {
	const out = { attachments: false, llm: false, agentDefaultModel: null, agents: null, resolveModelInfo: null, configModel: null };
	try {
		let att;
		try { att = ctx?.get?.("attachments"); } catch { att = undefined; }
		if (!att) { try { att = ctx?.root?.get?.("attachments"); } catch { att = undefined; } }
		out.attachments = Boolean(att && typeof att.saveImage === "function");
	} catch { }
	try {
		const sel = ctx?.agentDefaultModel?.currentSelection?.();
		out.agentDefaultModel = sel ? { provider: sel.provider ?? null, model: sel.model ?? null } : null;
	} catch (e) {
		out.agentDefaultModel = "err:" + (e instanceof Error ? e.message : String(e));
	}
	try {
		const agents = ctx?.get?.("agents");
		if (agents) {
			const keys = new Set();
			for (const k in agents) keys.add(k);
			for (const k of Object.getOwnPropertyNames(agents)) keys.add(k);
			const info = { keys: [...keys].slice(0, 24), selectionFor: typeof agents.selectionFor, current: null, available: null };
			if (typeof agents.selectionFor === "function") {
				try { info.current = agents.selectionFor()?.current ?? null; } catch (e) { info.current = "err:" + (e instanceof Error ? e.message : String(e)); }
			}
			if (typeof agents.availableModels === "function") {
				try { info.available = agents.availableModels(); } catch { }
			}
			out.agents = info;
		}
	} catch (e) {
		out.agents = "err:" + (e instanceof Error ? e.message : String(e));
	}
	try {
		out.llm = Boolean(ctx?.llm && typeof ctx.llm.stream === "function");
		if (typeof ctx?.llm?.resolveModelInfo === "function") {
			const probe = cfg.provider && cfg.model ? { provider: cfg.provider, model: cfg.model } : null;
			const target = probe ?? out.configModel ?? (out.agentDefaultModel?.provider ? out.agentDefaultModel : null);
			if (target?.provider && target?.model) {
				try {
					const info = await ctx.llm.resolveModelInfo(target.provider, target.model);
					out.resolveModelInfo = { for: target, inputModalities: info?.inputModalities ?? null };
				} catch (e) {
					out.resolveModelInfo = { for: target, error: e instanceof Error ? e.message : String(e) };
				}
			}
		}
	} catch { }
	out.configModel = cfg.provider && cfg.model ? { provider: cfg.provider, model: cfg.model } : null;
	if (typeof bridge?.modelCandidates === "function") {
		try {
			const list = bridge.modelCandidates(cfg.provider && cfg.model ? { provider: cfg.provider, model: cfg.model } : undefined);
			out.candidates = Array.isArray(list) ? list.map((m) => m.provider + "/" + m.model) : [];
		} catch (e) {
			out.candidates = "err:" + (e instanceof Error ? e.message : String(e));
		}
	}
	return out;
}

async function generateOnce(ctx, llm, sel, system, hint, opts, timeoutMs, bridge) {
	let BlockAssembler;
	let ReasoningEffortId;
	let createUserMessage;
	try {
		({ BlockAssembler, ReasoningEffortId, createUserMessage } = await loadLlm());
	} catch (e) {
		return {
			ok: false,
			reason: "generate-error",
			message: "拿不到宿主的 dsh-llm（" + (e instanceof Error ? e.message : String(e)) + "）"
		};
	}
	let supportsOff = false;
	try {
		supportsOff = Boolean(await bridge?.supportsOff?.(sel.provider, sel.model));
	} catch {
		supportsOff = false;
	}
	const options = {
		provider: sel.provider,
		model: sel.model,
		sessionId: "dsh-pet",
		messages: [createUserMessage({
			// 文字放前面、图片放后面：前缀缓存按从头匹配，文字固定 ⇒ 这 200+ token 每轮都能命中缓存价
			content: [
				{ type: "text", text: hint },
				{ type: "image", attachment: opts.attachment }
			],
			source: { kind: "user" }
		})],
		system,
		temperature: 1,
		...supportsOff ? { reasoningEffort: ReasoningEffortId("off") } : {},
		signal: AbortSignal.timeout(timeoutMs)
	};
	const assembler = new BlockAssembler();
	try {
		for await (const chunk of llm.stream(options)) assembler.push(chunk);
	} catch (e) {
		return {
			ok: false,
			reason: "generate-error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
	const text = assembler.blocks().filter((b) => b.type === "text").map((b) => ("text" in b ? b.text : "")).join("").trim();
	if (!text) return {
		ok: false,
		reason: "generate-error",
		message: typeof bridge?.noTextReason === "function" ? bridge.noTextReason(assembler.finish) : "模型未返回文本"
	};
	const line = stripLine(text);
	if (!line) return { ok: true, skip: true };
	if (/^skip$/i.test(line)) return { ok: true, skip: true };
	return { ok: true, text: line };
}

/** 追加一行调试日志（只在 cfg.debugLog 打开时写；超过 200KB 直接重置） */
export async function appendPeekLog(dir, cfg, entry) {
	if (!cfg.debugLog) return;
	const path = join(dir, "peek-log.jsonl");
	try {
		let cur = "";
		try {
			cur = await readFile(path, "utf8");
		} catch { }
		if (cur.length > 200 * 1024) cur = "";
		await writeFile(path, cur + JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
	} catch { }
}
