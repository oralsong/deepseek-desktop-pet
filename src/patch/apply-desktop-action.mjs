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
for (const file of [standalonePath, sharedPath, eventsPath]) {
	if (!existsSync(file)) die("找不到文件：" + file);
}

if (REVERT) {
	let restored = 0;
	for (const file of [standalonePath, sharedPath, eventsPath]) {
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

const DESKTOP_HELPERS = [
	T(1) + "const desktopActionBusy = new Set();",
	T(1) + "const desktopRunAnim = (found) => {",
	T(2) + "const actions = found?.conf?.animations?.moves?.actions;",
	T(2) + "if (!Array.isArray(actions)) return \"\";",
	T(2) + "const preferred = actions.find((item) => item && String(item.name || \"\").includes(\"\\u5954\\u8dd1\"));",
	T(2) + "const chosen = preferred || actions[0];",
	T(2) + "return chosen && typeof chosen.name === \"string\" ? chosen.name : \"\";",
	T(1) + "};",
	T(1) + "const desktopSay = async (petId, text) => {",
	T(2) + "let cfg = null;",
	T(2) + "try { cfg = (await __dshPetPeek.loadPeekConfig(userRoot)).cfg; } catch { }",
	T(2) + "let spoke = null;",
	T(2) + "if (cfg && cfg.speak === true && text && String(text).length <= 40) {",
	T(3) + "spoke = await __dshPetPeek.speakLine(cfg, text, { play: false }).catch((e) => ({ ok: false, reason: \"throw\", message: e instanceof Error ? e.message : String(e) }));",
	T(2) + "}",
	T(2) + "state.writePet(petId, \"say\", { text });",
	T(2) + "if (spoke && spoke.ok && spoke.file && cfg) void __dshPetPeek.playFile(cfg, spoke.file);",
	T(2) + "return spoke;",
	T(1) + "};",
	T(1) + "const tryDesktopOpenCommand = async (petId, text, found) => {",
	T(2) + "const query = __dshPetDesktop.parseDesktopOpenCommand(text);",
	T(2) + "if (!query) return null;",
	T(2) + "if (desktopActionBusy.has(petId)) {",
	T(3) + "return { ok: false, reason: \"desktop-action-busy\", message: \"\\u6211\\u6b63\\u5728\\u5e2e\\u4f60\\u53bb\\u5f00\\u4e1c\\u897f\\uff0c\\u7b49\\u6211\\u5230\\u4e86\\u518d\\u8bf4\\u3002\" };",
	T(2) + "}",
	T(2) + "desktopActionBusy.add(petId);",
	T(2) + "try {",
	T(3) + "const foundIcon = await __dshPetDesktop.findDesktopTarget(query);",
	T(3) + "if (!foundIcon.ok || !foundIcon.match) {",
	T(4) + "desktopActionBusy.delete(petId);",
	T(4) + "const text = \"\\u684c\\u9762\\u4e0a\\u6ca1\\u627e\\u5230\\u201c\" + query + \"\\u201d\\uff0c\\u53ef\\u4ee5\\u628a\\u5b83\\u653e\\u5230\\u684c\\u9762\\u6216\\u6539\\u4e2a\\u540d\\u5b57\\u3002\";",
	T(4) + "const spoke = await desktopSay(petId, text);",
	T(4) + "return {",
	T(5) + "ok: false,",
	T(5) + "reason: foundIcon.reason || \"desktop-target-not-found\",",
	T(5) + "message: text,",
	T(5) + "...(spoke && spoke.ok ? { spoke: { ok: true, seconds: spoke.seconds, file: spoke.file } } : {})",
	T(4) + "};",
	T(3) + "}",
	T(3) + "const match = foundIcon.match;",
	T(3) + "const screen = foundIcon.screen || {};",
	T(3) + "const targetName = String(match.name || query).replace(/\\.(?:exe|lnk|url)$/i, \"\");",
	T(3) + "const targetPath = typeof match.path === \"string\" ? match.path : \"\";",
	T(3) + "const screenX = Number(screen.x);",
	T(3) + "const screenY = Number(screen.y);",
	T(3) + "const screenW = Number(screen.width);",
	T(3) + "const screenH = Number(screen.height);",
	T(3) + "const iconX = Number(match.x);",
	T(3) + "const iconY = Number(match.y);",
	T(3) + "const hasPoint = Number.isFinite(iconX) && Number.isFinite(iconY) && screenW > 0 && screenH > 0;",
	T(3) + "const petSize = Number(found?.pet?.size) || 462;",
	T(3) + "let duration = 900;",
	T(3) + "if (hasPoint) {",
	T(4) + "const leftHalf = iconX < screenX + screenW / 2;",
	T(4) + "const offset = Math.max(54, petSize * 0.42);",
	T(4) + "const petX = Math.min(screenX + screenW * 0.9, Math.max(screenX + screenW * 0.1, iconX + (leftHalf ? offset : -offset)));",
	T(4) + "const petY = Math.min(screenY + screenH * 0.9, Math.max(screenY + screenH * 0.1, iconY));",
	T(4) + "const nx = (petX - screenX) / screenW;",
	T(4) + "const ny = (petY - screenY) / screenH;",
	T(4) + "const current = pose.get(petId);",
	T(4) + "const distance = current ? Math.hypot((nx - current.x) * screenW, (ny - current.y) * screenH) : 0;",
	T(4) + "duration = current ? Math.max(1400, Math.min(4600, Math.round(distance / 0.72))) : 2600;",
	T(4) + "const runAnim = desktopRunAnim(found);",
	T(4) + "state.writePet(petId, \"position\", {",
	T(5) + "x: nx,",
	T(5) + "y: ny,",
	T(5) + "mode: \"line\",",
	T(5) + "duration,",
	T(5) + "...(runAnim ? { anim: runAnim } : {}),",
	T(5) + "facing: leftHalf ? \"right\" : \"left\"",
	T(4) + "});",
	T(3) + "}",
	T(3) + "const opening = hasPoint",
	T(4) + "? \"\\u8fd9\\u5c31\\u8dd1\\u8fc7\\u53bb\\u5e2e\\u4f60\\u6253\\u5f00\" + targetName",
	T(4) + ": \"\\u684c\\u9762\\u56fe\\u6807\\u6682\\u65f6\\u6293\\u4e0d\\u5230\\u5750\\u6807\\uff0c\\u6211\\u76f4\\u63a5\\u5e2e\\u4f60\\u6253\\u5f00\" + targetName;",
	T(3) + "const spoke = await desktopSay(petId, opening);",
	T(3) + "const finish = () => {",
	T(4) + "const run = async () => {",
	T(5) + "let clicked = false;",
	T(5) + "let launched = false;",
	T(5) + "try {",
	T(6) + "const desktopForeground = foundIcon.foreground && foundIcon.foreground.desktop === true;",
	T(6) + "if (hasPoint && desktopForeground) clicked = (await __dshPetDesktop.clickDesktopPoint(iconX, iconY)).ok === true;",
	T(6) + "if (!clicked && targetPath) launched = (await __dshPetDesktop.launchDesktopTarget(targetPath)).ok === true;",
	T(6) + "state.writePet(petId, \"say\", {",
	T(7) + "text: clicked || launched ? \"\\u5f00\\u597d\\u5566\\u3002\" : \"\\u70b9\\u4e0b\\u53bb\\u4f46\\u597d\\u50cf\\u6ca1\\u53cd\\u5e94\\uff0c\\u4f60\\u770b\\u4e00\\u4e0b\\u8fdb\\u7a0b\\u3002\"",
	T(6) + "});",
	T(5) + "} finally {",
	T(6) + "desktopActionBusy.delete(petId);",
	T(5) + "}",
	T(4) + "};",
	T(4) + "void run();",
	T(3) + "};",
	T(3) + "setTimeout(finish, Math.max(250, duration + 120));",
	T(3) + "return {",
	T(4) + "ok: true,",
	T(4) + "text: opening,",
	T(4) + "action: { kind: \"desktop-open\", target: targetName, moved: hasPoint, duration },",
	T(4) + "...(spoke && spoke.ok ? { spoke: { ok: true, seconds: spoke.seconds, file: spoke.file } } : {})",
	T(3) + "};",
	T(2) + "} catch (e) {",
	T(3) + "desktopActionBusy.delete(petId);",
	T(3) + "return { ok: false, reason: \"desktop-action-error\", message: e instanceof Error ? e.message : String(e) };",
	T(2) + "}",
	T(1) + "};"
].join("\n");

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
		out = out.replace(anchor, DESKTOP_HELPERS + "\n" + anchor);
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
		"    s.moveToCenter(hit.x, hit.y, hit.mode, hit.duration);",
		"    if (hit.anim) s.playOnce(hit.anim);",
		"  }",
		"}"
	].join("\n");
	if (!source.includes(oldBlock)) throw new Error("events applyPositionLeaf anchor not found");
	return source.replace(oldBlock, newBlock);
}

const standalone = readFileSync(standalonePath, "utf8");
const shared = readFileSync(sharedPath, "utf8");
const events = readFileSync(eventsPath, "utf8");
let patchedStandalone;
let patchedShared;
let patchedEvents;
try {
	patchedStandalone = patchStandalone(standalone);
	patchedShared = patchSharedCore(shared);
	patchedEvents = patchEvents(events);
} catch (e) {
	die(e instanceof Error ? e.message : String(e));
}

if (DRY) {
	log("dry-run：standalone / shared-core / events 锚点全部命中（未写盘）");
	process.exit(0);
}

for (const file of [standalonePath, sharedPath, eventsPath]) {
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
for (const name of ["desktop-action.js", "desktop-action.ps1"]) {
	copyFileSync(join(HERE, name), join(PKG, "lib", name));
}
log("桌面命令补丁已应用 ✔");
