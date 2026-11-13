/**
 * Add local desktop-icon commands to dsh-pet standalone mode.
 *
 * A user can say "打开PCL2". The host matches a shortcut on the Desktop,
 * moves the pet to its real UI Automation coordinates, then clicks it. When
 * the Desktop is not foreground, the matched shortcut is launched directly.
 *
 * Usage:
 *   node apply-desktop-action.mjs --pkg <dsh-pet-package>
 *   node apply-desktop-action.mjs --pkg <dsh-pet-package> --dry-run
 *   node apply-desktop-action.mjs --pkg <dsh-pet-package> --revert
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
const NODE = arg("node", "node");
const log = (text) => console.log("[petdesktop] " + text);
function die(text) {
	console.error("[petdesktop] 失败：" + text);
	process.exit(1);
}

const standalonePath = join(PKG, "lib", "standalone.js");
const sharedPath = join(PKG, "runtime", "electron-helper", "shared-core.js");
const eventsPath = join(PKG, "runtime", "electron-helper", "events.js");
const spritePath = join(PKG, "runtime", "electron-helper", "sprite.js");
for (const file of [standalonePath, sharedPath, eventsPath, spritePath]) {
	if (!existsSync(file)) die("找不到文件：" + file);
}

if (REVERT) {
	let restored = 0;
	for (const file of [standalonePath, sharedPath, eventsPath, spritePath]) {
		const backup = file + ".petdesktop.orig";
		if (!existsSync(backup)) continue;
		copyFileSync(backup, file);
		restored += 1;
	}
	if (!restored) die("没有 apply-desktop-action 生成的备份");
	log("已还原 " + restored + " 个文件");
	process.exit(0);
}

const DESKTOP_IMPORT = 'import * as __dshPetDesktop from "./desktop-action.js";';
const DESKTOP_HELPER_SOURCE = readFileSync(join(HERE, "desktop-helper-block.js"), "utf8").trimEnd();


function patchStandalone(source) {
	let out = source;
	if (!out.includes(DESKTOP_IMPORT)) {
		const anchor = 'import * as __dshPetPeek from "./peek.js";';
		if (!out.includes(anchor)) throw new Error("standalone import anchor not found");
		out = out.replace(anchor, anchor + "\n" + DESKTOP_IMPORT);
	}
	if (!out.includes("const tryDesktopOpenCommand = async")) {
		const anchor = "\t/**\n\t* 当前生效宠物列表";
		if (!out.includes(anchor)) throw new Error("chatWithPet tail anchor not found");
		out = out.replace(anchor, DESKTOP_HELPER_SOURCE + "\n" + anchor);
	}
	const oldCall = "\t\t\t\t\tconst result = await chatWithPet(petId$1, text);";
	const newCall = [
		T(5) + "const action = await tryDesktopOpenCommand(petId$1, text, who);",
		T(5) + "const result = action || await chatWithPet(petId$1, text);"
	].join("\n");
	if (out.includes(oldCall) && !out.includes("const action = await tryDesktopOpenCommand")) {
		out = out.replace(oldCall, newCall);
	}
	if (!out.includes("const action = await tryDesktopOpenCommand")) {
		throw new Error("chat route anchor not found");
	}
	return out;
}

function patchSharedCore(source) {
	if (source.includes("const extra = {};\n\tif (typeof d.anim === \"string\"")) return source;
	const oldBlock = [
		"function readPosition(leaf$1) {",
		"\tif (!leaf$1.data || typeof leaf$1.data !== \"object\") return null;",
		"\tconst d = leaf$1.data;",
		"\tif (typeof d.x !== \"number\" || !Number.isFinite(d.x)) return null;",
		"\tif (typeof d.y !== \"number\" || !Number.isFinite(d.y)) return null;",
		"\tif (d.mode !== \"instant\" && d.mode !== \"spring\" && d.mode !== \"line\") return null;",
		"\tif (d.mode === \"line\") {",
		"\t\tif (typeof d.duration !== \"number\" || !Number.isFinite(d.duration) || d.duration < 0) return null;",
		"\t\treturn {",
		"\t\t\tx: d.x,",
		"\t\t\ty: d.y,",
		"\t\t\tmode: \"line\",",
		"\t\t\tduration: d.duration",
		"\t\t};",
		"\t}",
		"\treturn {",
		"\t\tx: d.x,",
		"\t\ty: d.y,",
		"\t\tmode: d.mode,",
		"\t\tduration: 0",
		"\t};",
		"}"
	].join("\n");
	const newBlock = [
		"function readPosition(leaf$1) {",
		"\tif (!leaf$1.data || typeof leaf$1.data !== \"object\") return null;",
		"\tconst d = leaf$1.data;",
		"\tif (typeof d.x !== \"number\" || !Number.isFinite(d.x)) return null;",
		"\tif (typeof d.y !== \"number\" || !Number.isFinite(d.y)) return null;",
		"\tif (d.mode !== \"instant\" && d.mode !== \"spring\" && d.mode !== \"line\") return null;",
		"\tconst extra = {};",
		"\tif (typeof d.anim === \"string\" && d.anim) extra.anim = d.anim;",
		"\tif (d.facing === \"left\" || d.facing === \"right\") extra.facing = d.facing;",
		"\tif (d.motion === \"run\" || d.motion === \"walk\") extra.motion = d.motion;",
		"\tif (d.mode === \"line\") {",
		"\t\tif (typeof d.duration !== \"number\" || !Number.isFinite(d.duration) || d.duration < 0) return null;",
		"\t\treturn { x: d.x, y: d.y, mode: \"line\", duration: d.duration, ...extra };",
		"\t}",
		"\treturn { x: d.x, y: d.y, mode: d.mode, duration: 0, ...extra };",
		"}"
	].join("\n");
	if (!source.includes(oldBlock)) throw new Error("shared-core readPosition anchor not found");
	return source.replace(oldBlock, newBlock);
}

function patchEvents(source) {
	if (source.includes("if (hit.anim) s.playOnce(hit.anim);")) return source;
	const oldBlock = [
		"function applyPositionLeaf(petId, leaf) {",
		"  const hit = S.readPosition(leaf);",
		"  if (!hit) return;",
		"  for (const s of sprites) {",
		"    if (s.pet.id === petId) s.moveToCenter(hit.x, hit.y, hit.mode, hit.duration);",
		"  }",
		"}"
	].join("\n");
	const newBlock = [
		"function applyPositionLeaf(petId, leaf) {",
		"  const hit = S.readPosition(leaf);",
		"  if (!hit) return;",
		"  for (const s of sprites) {",
		"    if (s.pet.id !== petId) continue;",
		"    if (hit.facing) s.facing = hit.facing;",
		"    s.moveToCenter(hit.x, hit.y, hit.mode, hit.duration, hit.motion);",
		"    if (hit.anim) s.playOnce(hit.anim);",
		"  }",
		"}"
	].join("\n");
	if (!source.includes(oldBlock)) throw new Error("events applyPositionLeaf anchor not found");
	return source.replace(oldBlock, newBlock);
}

function patchSprite(source) {
	if (source.includes("motion === 'run' || motion === 'walk'")) return source;
	const oldSignature = "  moveToCenter(rx, ry, mode, duration) {";
	const newSignature = "  moveToCenter(rx, ry, mode, duration, motion) {";
	if (!source.includes(oldSignature)) throw new Error("sprite moveToCenter signature anchor not found");
	let out = source.replace(oldSignature, newSignature);
	const oldStep = [
		"        const p = Math.min((performance.now() - t0) / duration, 1);",
		"        if (p >= 1) {",
		"          // 精确落位：终点不留残余偏差（弹簧那条靠收敛阈值收尾，这条靠 p 到 1）",
		"          this.posFollow = null;",
		"          this.sendBounds(px, py);",
		"          this.customPos = { rx: fx, ry: fy };",
		"          return;",
		"        }",
		"        this.sendBounds(fromX + (px - fromX) * p, fromY + (py - fromY) * p);"
	].join("\n");
	const newStep = [
		"        const raw = Math.min((performance.now() - t0) / duration, 1);",
		"        if (raw >= 1) {",
		"          // 精确落位：终点不留残余偏差（弹簧那条靠收敛阈值收尾，这条靠 p 到 1）",
		"          this.posFollow = null;",
		"          this.sendBounds(px, py);",
		"          this.customPos = { rx: fx, ry: fy };",
		"          return;",
		"        }",
		"        const p = motion === 'run' || motion === 'walk' ? raw * raw * (3 - 2 * raw) : raw;",
		"        const bob = motion === 'run'",
		"          ? Math.sin(raw * Math.PI * 8) * Math.min(5, this.size * 0.012) * Math.sin(Math.PI * raw)",
		"          : 0;",
		"        this.sendBounds(fromX + (px - fromX) * p, fromY + (py - fromY) * p + bob);"
	].join("\n");
	if (!out.includes(oldStep)) throw new Error("sprite moveToCenter step anchor not found");
	return out.replace(oldStep, newStep);
}

const standalone = readFileSync(standalonePath, "utf8");
const shared = readFileSync(sharedPath, "utf8");
const events = readFileSync(eventsPath, "utf8");
let patchedStandalone;
let patchedShared;
let patchedEvents;
let patchedSprite;
try {
	patchedStandalone = patchStandalone(standalone);
	patchedShared = patchSharedCore(shared);
	patchedEvents = patchEvents(events);
	patchedSprite = patchSprite(readFileSync(spritePath, "utf8"));
} catch (e) {
	die(e instanceof Error ? e.message : String(e));
}

if (DRY) {
log("dry-run：standalone / shared-core / events / sprite 锚点全部命中（未写盘）");
	process.exit(0);
}

for (const file of [standalonePath, sharedPath, eventsPath, spritePath]) {
	const backup = file + ".petdesktop.orig";
	if (!existsSync(backup)) copyFileSync(file, backup);
}
const probe = join(PKG, "lib", ".petdesktop-probe.mjs");
writeFileSync(probe, patchedStandalone, "utf8");
const check = spawnSync(NODE, ["--check", probe], { encoding: "utf8" });
try { unlinkSync(probe); } catch { }
if (check.status !== 0) {
	die("补丁后 standalone.js 语法检查失败：\n" + ((check.stdout || "") + (check.stderr || "")).trim().slice(0, 2000));
}
writeFileSync(standalonePath, patchedStandalone, "utf8");
writeFileSync(sharedPath, patchedShared, "utf8");
writeFileSync(eventsPath, patchedEvents, "utf8");
writeFileSync(spritePath, patchedSprite, "utf8");
for (const name of ["desktop-action.js", "desktop-action.ps1"]) {
	copyFileSync(join(HERE, name), join(PKG, "lib", name));
}
const inputSource = join(HERE, "..", "tools", "DesktopInput.cs");
const inputExe = join(PKG, "lib", "desktop-input.exe");
const csc = join(process.env.WINDIR || "C:/Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
if (existsSync(inputSource) && existsSync(csc)) {
	const built = spawnSync(csc, ["/nologo", "/target:exe", "/optimize+", "/out:" + inputExe, inputSource], {
		encoding: "utf8",
		windowsHide: true
	});
	if (built.status !== 0) die("desktop-input.exe 编译失败：" + ((built.stdout || "") + (built.stderr || "")).slice(0, 1200));
}
log("桌面命令补丁已应用 ✔");
