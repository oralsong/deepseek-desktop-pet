/**
 * dsh-pet 0.3.8「独立版」补丁安装器 —— 给 lib/standalone.js 打同一套陪玩/语音/记忆补丁
 *
 * 与 apply-patch.mjs 的区别：
 *   - 目标是 lib/standalone.js（独立模式，不需要 DSH），不是 lib/index.js；
 *   - standalone 里没有 resolveActivePetId()，改用 flattenPetList 兜底；
 *   - 不注册 /peek 斜杠命令（独立模式没有 DSH 的命令面板），只用 HTTP 路由 + 右键菜单；
 *   - 额外注册 /peek-toggle 路由（右键「陪玩模式」开关）。
 *
 * 用法：
 *   node apply-standalone.mjs [--pkg <包目录>] [--dry-run]
 *   node apply-standalone.mjs --revert
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const T = (n) => "\t".repeat(n);

const argv = process.argv.slice(2);
function arg(name, fallback) {
	const i = argv.indexOf("--" + name);
	if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
	const eq = argv.find((a) => a.startsWith("--" + name + "="));
	if (eq) return eq.slice(name.length + 3);
	return fallback;
}
const REVERT = argv.includes("--revert");
const DRY = argv.includes("--dry-run");
const PKG = resolve(arg("pkg", "C:/Users/win11/.dsh/profiles/desktop/node_modules/dsh-pet"));
const NODE = arg("node", existsSync("C:/Users/win11/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe")
	? "C:/Users/win11/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe"
	: "node");

const log = (s) => console.log("[petstandalone] " + s);
function die(msg) {
	console.error("[petstandalone] 失败：" + msg);
	process.exit(1);
}

const pkgJsonPath = join(PKG, "package.json");
const targetPath = join(PKG, "lib", "standalone.js");
if (!existsSync(pkgJsonPath)) die("找不到包：" + PKG);
if (!existsSync(targetPath)) die("找不到 lib/standalone.js：" + targetPath);
const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
const version = String(pkg.version ?? "unknown");
const backupPath = join(PKG, "lib", "standalone.js.petpeek-" + version + ".orig");
log("dsh-pet " + version + " @ " + PKG);

if (REVERT) {
	const backups = existsSync(join(PKG, "lib"))
		? readdirSync(join(PKG, "lib")).filter((f) => /^standalone\.js\.petpeek-.*\.orig$/.test(f))
		: [];
	if (existsSync(backupPath)) {
		copyFileSync(backupPath, targetPath);
		log("已还原 standalone.js（备份保留）");
		process.exit(0);
	}
	if (backups.length > 0) {
		copyFileSync(join(PKG, "lib", backups[0]), targetPath);
		log("已还原自 " + backups[0]);
		process.exit(0);
	}
	die("没有可用的备份");
}

if (!existsSync(backupPath) && !DRY) {
	copyFileSync(targetPath, backupPath);
	log("已备份原版 → " + backupPath);
}
const pristine = existsSync(backupPath) ? readFileSync(backupPath, "utf8") : readFileSync(targetPath, "utf8");

/* ---------- 补丁片段 ---------- */
const GEN_CALL = 'await generateWhisper(ctx, system, meme, configuredModel(found.conf, "whisperModel"));';

const IMPORT_LINE = 'import * as __dshPetPeek from "./peek.js";';

const PUBLISH_SIGNATURE = "const publishWhisper = async (petId, peek) => {";

const GEN_REPLACEMENT = [
	"let result;",
	"if (peek && (peek.attachment || peek.imageBytes)) {",
	T(1) + "// 陪玩补丁：把这一帧截图塞进消息，让它看着屏幕说话（有图片块就用图片块，没有就直连服务商）",
	T(1) + "const r = await __dshPetPeek.generatePeekLine(ctx, system, {",
	T(2) + "modelCandidates,",
	T(2) + "supportsOff: (p, m) => supportsReasoningOff(ctx, p, m),",
	T(2) + "noTextReason,",
	T(2) + "modelLabel",
	T(1) + "}, {",
	T(2) + "attachment: peek.attachment,",
	T(2) + "imageBytes: peek.imageBytes,",
	T(2) + "memoryDir: userRoot,",
	T(2) + "hint: peek.hint,",
	T(2) + "candidates: peek.candidates,",
	T(2) + "preferred: configuredModel(found.conf, \"whisperModel\"),",
	T(2) + "timeoutMs: peek.timeoutMs",
	T(1) + "});",
	T(1) + "if (r.ok && r.skip) return { ok: true, skip: true };",
	T(1) + "result = r.ok ? { ok: true, text: r.text } : r;",
	"} else result = " + GEN_CALL
].join("\n");

const firstPetExpr = 'String(flattenPetList(readAllConfig(configPaths)).map((e) => e && e.id).find(Boolean) ?? "")';

const ROUTE_BLOCK = [
	T(2) + 'if (rest === "peek") {',
	T(3) + 'if (method !== "POST") return { kind: "json", status: 405, obj: { error: "method not allowed" } };',
	T(3) + "try {",
	T(4) + 'const wantPet = (url.searchParams.get("pet") ?? "").trim();',
	T(4) + 'const force = url.searchParams.get("force") !== "0";',
	T(4) + 'if (url.searchParams.get("debug") === "1") {',
	T(5) + "const loaded = await __dshPetPeek.loadPeekConfig(userRoot);",
	T(5) + "const env = await __dshPetPeek.peekEnv(ctx, {",
	T(6) + "modelCandidates,",
	T(6) + "supportsOff: (p, m) => supportsReasoningOff(ctx, p, m),",
	T(6) + "noTextReason,",
	T(6) + "modelLabel",
	T(5) + "}, loaded.cfg);",
	T(5) + 'return { kind: "json", status: 200, obj: { ok: true, debug: true, cfg: loaded.cfg, env } };',
	T(4) + "}",
	T(4) + "const r = await peekLook(wantPet, force);",
	T(4) + 'return { kind: "json", status: 200, obj: r };',
	T(3) + "} catch (e) {",
	T(4) + 'return { kind: "json", status: 200, obj: { ok: false, reason: "peek-error", message: e instanceof Error ? e.message : String(e) } };',
	T(3) + "}",
	T(2) + "}",
	T(2) + 'if (rest === "peek-toggle") {',
	T(3) + 'if (method !== "POST") return { kind: "json", status: 405, obj: { error: "method not allowed" } };',
	T(3) + "try {",
	T(4) + 'const wantPet = (url.searchParams.get("pet") ?? "").trim();',
	T(4) + 'const onParam = url.searchParams.get("on");',
	T(4) + "const loaded = await __dshPetPeek.loadPeekConfig(userRoot);",
	T(4) + 'const next = onParam === null ? loaded.cfg.enabled !== true : onParam === "1";',
	T(4) + "const w = await __dshPetPeek.setPeekEnabled(userRoot, next);",
	T(4) + 'if (!w.ok) return { kind: "json", status: 200, obj: { ok: false, reason: "write-failed", message: w.message } };',
	T(4) + 'let pid2 = wantPet || loaded.cfg.petId || "";',
	T(4) + "if (!pid2) { try { pid2 = " + firstPetExpr + "; } catch { pid2 = \"\"; } }",
	T(4) + "if (pid2) {",
	T(5) + "try {",
	T(6) + 'state.writePet(pid2, "say", { text: next ? "陪玩打开啦，我盯着屏幕陪你玩～" : "陪玩先关掉了，需要的时候再喊我。" });',
	T(5) + "} catch { }",
	T(4) + "}",
	T(4) + 'return { kind: "json", status: 200, obj: { ok: true, enabled: next } };',
	T(3) + "} catch (e) {",
	T(4) + 'return { kind: "json", status: 200, obj: { ok: false, reason: "peek-toggle-error", message: e instanceof Error ? e.message : String(e) } };',
	T(3) + "}",
	T(2) + "}"
].join("\n");

const PEEK_BLOCK = [
	T(1) + "//#region dsh-pet peek（独立版陪玩补丁：定时截屏 + 变化检测 + 带图说一句；逻辑在 lib/peek.js）",
	T(1) + "let peekPrevSmall = null;",
	T(1) + "let peekLastSpokeAt = 0;",
	T(1) + "let peekPrimed = false;",
	T(1) + "let peekLastScore = 0;",
	T(1) + "let peekLastError = \"\";",
	T(1) + "let peekQuietFullscreen = false;",
	T(1) + "let peekQuietLock = \"\";",
	T(1) + "async function peekSyncQuiet(petId, cfg) {",
	T(2) + "if (cfg.quietOnFullscreen !== true || !petId) return null;",
	T(2) + "const p = await __dshPetPeek.probeFullscreen(cfg);",
	T(2) + "const wantQuiet = p && p.ok === true && p.fullscreen === true;",
	T(2) + "if (wantQuiet) {",
	T(3) + "peekQuietFullscreen = true;",
	T(3) + "try {",
	T(4) + "if (peekQuietLock) {",
	T(5) + "const r = lock.acquire({ petId, lockId: peekQuietLock, ttl: 20000 });",
	T(5) + "if (!r.ok) peekQuietLock = \"\";",
	T(4) + "}",
	T(4) + "if (!peekQuietLock) {",
	T(5) + "const r = lock.acquire({ petId, ttl: 20000 });",
	T(5) + "if (r.ok && r.lockId) peekQuietLock = r.lockId;",
	T(4) + "}",
	T(3) + "} catch { }",
	T(2) + "} else {",
	T(3) + "peekQuietFullscreen = false;",
	T(3) + "if (peekQuietLock) {",
	T(4) + "try { lock.release({ petId, lockId: peekQuietLock, force: false }); } catch { }",
	T(4) + "peekQuietLock = \"\";",
	T(3) + "}",
	T(2) + "}",
	T(2) + "return p;",
	T(1) + "}",
	T(1) + "function peekCandidates(cfg) {",
	T(2) + "const out = [];",
	T(2) + "if (cfg && cfg.provider && cfg.model) out.push({ provider: cfg.provider, model: cfg.model });",
	T(2) + "try {",
	T(3) + "const svc = ctx.get(\"agents\");",
	T(3) + "if (svc && typeof svc.selectionFor === \"function\") {",
	T(4) + "let cur = null;",
	T(4) + "try { cur = svc.selectionFor()?.current ?? null; } catch { }",
	T(4) + "if (cur && cur.provider && cur.model) out.push({ provider: cur.provider, model: cur.model });",
	T(3) + "}",
	T(2) + "} catch { }",
	T(2) + "return out;",
	T(1) + "}",
	T(1) + "async function peekLook(reqPetId, force) {",
	T(2) + "const loaded = await __dshPetPeek.loadPeekConfig(userRoot);",
	T(2) + "const cfg = loaded.cfg;",
	T(2) + "if (!cfg.enabled && !force) return { ok: true, silent: true, reason: \"disabled\" };",
	T(2) + "const frame = await __dshPetPeek.captureFrame(cfg);",
	T(2) + "if (!frame.ok) {",
	T(3) + "peekLastError = frame.message ?? frame.reason;",
	T(3) + "console.warn(\"[dsh-pet:peek] 截屏失败 reason=\" + frame.reason + \" \" + (frame.message ?? \"\"));",
	T(3) + "return { ok: false, reason: frame.reason, message: frame.message };",
	T(2) + "}",
	T(2) + "const cov = __dshPetPeek.frameCoverage(peekPrevSmall, frame.small, cfg.cellDiff);",
	T(2) + "peekPrevSmall = frame.small;",
	T(2) + "peekLastScore = cov.score;",
	T(2) + "const base = { score: Number(cov.score.toFixed(4)), changedCells: cov.changedCells, cells: cov.cells, intervalSec: cfg.intervalSec, captureMs: frame.ms ? frame.ms.total : undefined };",
	T(2) + "if (!peekPrimed && !force) {",
	T(3) + "peekPrimed = true;",
	T(3) + "return { ok: true, silent: true, reason: \"prime\", ...base };",
	T(2) + "}",
	T(2) + "peekPrimed = true;",
	T(2) + "if (!force && cfg.silentWhenIdle && (cov.score < cfg.minChange || cov.changedCells < cfg.minCells)) return { ok: true, silent: true, reason: \"idle\", ...base };",
	T(2) + "const now = Date.now();",
	T(2) + "if (!force && cfg.cooldownSec > 0 && now - peekLastSpokeAt < cfg.cooldownSec * 1000) return { ok: true, silent: true, reason: \"cooldown\", ...base };",
	T(2) + 'let petId = String(reqPetId ?? "").trim() || cfg.petId;',
	T(2) + "if (!petId) { try { petId = " + firstPetExpr + "; } catch { petId = \"\"; } }",
	T(2) + 'if (!petId) return { ok: false, reason: "unknown-pet", message: "没有可交互的桌宠", ...base };',
	T(2) + "let locked = false;",
	T(2) + "try { locked = lock.locked(petId); } catch { }",
	T(2) + "if (!force && locked && !peekQuietFullscreen) return { ok: true, silent: true, reason: \"locked\", petId, ...base };",
	T(2) + 'const att = await __dshPetPeek.attachImage(ctx, frame.shot, "peek-" + Date.now() + (frame.format === "png" ? ".png" : ".jpg"), frame.format === "png" ? "image/png" : "image/jpeg");',
	T(2) + "let peekImage = {};",
	T(2) + "if (att.ok) peekImage = { attachment: att.attachment };",
	T(2) + "else {",
	T(3) + "// 独立模式没有 attachments 服务：把这一帧原样交给 peek，让它直连服务商发 base64",
	T(3) + 'peekImage = { imageBytes: frame.shot };',
	T(3) + 'if (att.reason !== "attachment-unavailable") console.warn("[dsh-pet:peek] 附件失败 reason=" + att.reason + " " + (att.message ?? "") + "，改走直连");',
	T(2) + "}",
	T(2) + 'const r = await publishWhisper(petId, { ...peekImage, hint: cfg.prompt || undefined, timeoutMs: cfg.generateTimeoutMs, candidates: peekCandidates(cfg) });',
	T(2) + "let spoke = null;",
	T(2) + "if (r.ok && !r.skip) peekLastSpokeAt = Date.now();",
	T(2) + "if (r.ok && !r.skip && cfg.speak === true && r.text) {",
	T(3) + 'spoke = await __dshPetPeek.speakLine(cfg, r.text).catch((e) => ({ ok: false, reason: "throw", message: e instanceof Error ? e.message : String(e) }));',
	T(3) + 'if (!spoke.ok) console.warn("[dsh-pet:peek] 语音失败：" + spoke.reason + " " + (spoke.message ?? ""));',
	T(2) + "}",
	T(2) + "if (!r.ok) peekLastError = r.message ?? r.reason;",
	T(2) + 'await __dshPetPeek.appendPeekLog(userRoot, cfg, { kind: force ? "manual" : "auto", petId, score: base.score, ok: r.ok === true, skipped: r.skip === true, reason: r.reason, message: r.message, text: r.text, spoke });',
	T(2) + "return { ok: r.ok === true, petId, text: r.text, skipped: r.skip === true, reason: r.reason, message: r.message, spoke, ...base };",
	T(1) + "}",
	T(1) + "ctx.effect(() => {",
	T(2) + "let disposed = false;",
	T(2) + "let timer = null;",
	T(2) + "function arm(sec) {",
	T(3) + "if (disposed) return;",
	T(3) + "timer = setTimeout(() => void run(), Math.max(1000, sec * 1000));",
	T(2) + "}",
	T(2) + "async function run() {",
	T(3) + "let next = 6;",
	T(3) + "try {",
	T(4) + "const loaded = await __dshPetPeek.loadPeekConfig(userRoot);",
	T(4) + 'if (loaded.error) console.warn("[dsh-pet:peek] " + loaded.error);',
	T(4) + "const cfg = loaded.cfg;",
	T(4) + "next = cfg.intervalSec;",
	T(4) + "if (cfg.quietOnFullscreen === true) {",
	T(5) + 'let qid = String(cfg.petId ?? "").trim();',
	T(5) + "if (!qid) { try { qid = " + firstPetExpr + "; } catch { qid = \"\"; } }",
	T(5) + "if (qid) await peekSyncQuiet(qid, cfg);",
	T(4) + "}",
	T(4) + "if (cfg.enabled) {",
	T(5) + 'const r = await peekLook("", false);',
	T(5) + 'if (r && !r.silent) console.warn("[dsh-pet:peek] " + (r.ok ? (r.skipped ? "跳过（SKIP）" : "说了：" + r.text) : "失败 " + (r.message ?? r.reason)) + "｜变化 " + Math.round((r.score ?? 0) * 100) + "%");',
	T(4) + "}",
	T(3) + "} catch (e) {",
	T(4) + 'console.warn("[dsh-pet:peek] 轮询异常：" + (e instanceof Error ? e.message : String(e)));',
	T(3) + "}",
	T(3) + "arm(next);",
	T(2) + "}",
	T(2) + "run();",
	T(2) + "void (async () => {",
	T(3) + "try {",
	T(4) + "const l = await __dshPetPeek.loadPeekConfig(userRoot);",
	T(4) + "if (l.cfg.enabled) await __dshPetPeek.warmPeekWorker(l.cfg);",
	T(3) + "} catch { }",
	T(2) + "})();",
	T(2) + "return () => {",
	T(3) + "disposed = true;",
	T(3) + "if (timer !== null) clearTimeout(timer);",
	T(3) + "void __dshPetPeek.stopPeekWorker();",
	T(2) + "};",
	T(1) + '}, "dsh-pet: peek poll");',
	T(1) + "//#endregion"
].join("\n");

function mustFind(lines, test, label) {
	const hits = [];
	for (let i = 0; i < lines.length; i++) if (test(lines[i])) hits.push(i);
	if (hits.length !== 1) die("锚点「" + label + "」命中 " + hits.length + " 处（应为 1 处）");
	return hits[0];
}

function applyPatch(code) {
	const eol = code.includes("\r\n") ? "\r\n" : "\n";
	const lines = code.split(/\r?\n/);

	const importAnchor = mustFind(lines, (l) => l === 'import { downloadArtifact } from "@electron/get";', "import");
	lines.splice(importAnchor + 1, 0, IMPORT_LINE);

	const sigIdx = mustFind(lines, (l) => /^\tconst publishWhisper = async \(petId\) => \{$/.test(l), "publishWhisper 签名");
	lines[sigIdx] = T(1) + PUBLISH_SIGNATURE;

	const callIdx = mustFind(lines, (l) => l.trim() === "const result = " + GEN_CALL, "generateWhisper 调用");
	const callIndent = /^\t*/.exec(lines[callIdx])[0];
	lines.splice(callIdx, 1, ...GEN_REPLACEMENT.split("\n").map((l) => (l ? callIndent + l : l)));

	const pollIdx = mustFind(lines, (l) => /^\t\}, "dsh-pet: whisper poll"\);$/.test(l), "whisper poll 结束");
	lines.splice(pollIdx + 1, 0, ...PEEK_BLOCK.split("\n"));

	const routeIdx = mustFind(lines, (l) => /^\t\tif \(rest === "whisper"\) \{$/.test(l), "whisper 路由");
	lines.splice(routeIdx, 0, ...ROUTE_BLOCK.split("\n"));

	return lines.join(eol);
}

let patched;
try {
	patched = applyPatch(pristine);
} catch (e) {
	die(e instanceof Error ? e.message : String(e));
}

if (DRY) {
	log("dry-run：锚点全部命中（未写盘）");
	process.exit(0);
}

const probe = join(PKG, "lib", ".petstandalone-probe.mjs");
writeFileSync(probe, patched, "utf8");
const check = spawnSync(NODE, ["--check", probe], { encoding: "utf8" });
try { unlinkSync(probe); } catch { }
if (check.status !== 0) {
	die("补丁后语法检查失败，未改动原文件：\n" + ((check.stdout || "") + (check.stderr || "")).trim().slice(0, 2000));
}

for (const [from, to] of [
	[HERE + "/peek.mjs", join(PKG, "lib", "peek.js")],
	[HERE + "/peek-worker.ps1", join(PKG, "lib", "peek-worker.ps1")],
	[HERE + "/peek-capture.ps1", join(PKG, "lib", "peek-capture.ps1")]
]) {
	if (existsSync(from)) copyFileSync(from, to);
}

writeFileSync(targetPath, patched, "utf8");
log("standalone.js 补丁已应用 ✔  " + targetPath);
log("用法：node lib/standalone.js --port 3080");
