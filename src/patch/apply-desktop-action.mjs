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

const DESKTOP_HELPERS = [
	T(1) + "const desktopActionBusy = new Set();",
	T(1) + "const desktopRunAnim = (found) => {",
	T(2) + "const actions = found?.conf?.animations?.moves?.actions;",
	T(2) + "if (!Array.isArray(actions)) return \"\";",
	T(2) + "const preferred = actions.find((item) => item && String(item.name || \"\").includes(\"\\u5954\\u8dd1\"));",
	T(2) + "const chosen = preferred || actions[0];",
	T(2) + "return chosen && typeof chosen.name === \"string\" ? chosen.name : \"\";",
	T(1) + "};",
	T(1) + "const desktopPointAnim = (found) => {",
	T(2) + "const candidates = [];",
	T(2) + "const events = found?.conf?.animations?.events?.workStatus;",
	T(2) + "if (Array.isArray(events)) {",
	T(3) + "for (const slot of events) {",
	T(4) + "if (Array.isArray(slot)) candidates.push(...slot);",
	T(4) + "else if (typeof slot === \"string\") candidates.push(slot);",
	T(3) + "}",
	T(2) + "}",
	T(2) + "const categories = found?.conf?.animations?.categories;",
	T(2) + "if (Array.isArray(categories)) {",
	T(3) + "for (const category of categories) {",
	T(4) + "if (category && Array.isArray(category.actions)) candidates.push(...category.actions);",
	T(3) + "}",
	T(2) + "}",
	T(2) + "return candidates.find((name) => /点按|\\u6572\\u51fb|\\u70b9\\u51fb/.test(String(name))) || \"\";",
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
	T(2) + "console.log(\"[dsh-pet:desktop] parsed command target=\" + query + \" pet=\" + petId);",
	T(2) + "if (desktopActionBusy.has(petId)) {",
	T(3) + "return { ok: false, reason: \"desktop-action-busy\", message: \"\\u6211\\u6b63\\u5728\\u5e2e\\u4f60\\u53bb\\u5f00\\u4e1c\\u897f\\uff0c\\u7b49\\u6211\\u5230\\u4e86\\u518d\\u8bf4\\u3002\" };",
	T(2) + "}",
	T(2) + "desktopActionBusy.add(petId);",
	T(2) + "try {",
	T(3) + "let foundIcon = await __dshPetDesktop.findDesktopTarget(query);",
	T(3) + "if (!foundIcon.ok || !foundIcon.match) {",
	T(4) + "console.log(\"[dsh-pet:desktop] local lookup failed, trying screen vision\");",
	T(4) + "try {",
	T(5) + "const peekCfg = (await __dshPetPeek.loadPeekConfig(userRoot)).cfg;",
	T(5) + "const frame = await __dshPetPeek.captureFrame({ ...peekCfg, maxWidth: Math.max(Number(peekCfg.maxWidth) || 0, 1600) });",
	T(5) + "if (frame.ok) {",
	T(6) + "const visual = await __dshPetPeek.locateScreenTarget(userRoot, petSystemPrompt(found), query, frame.shot, peekCfg.generateTimeoutMs);",
	T(6) + "console.log(\"[dsh-pet:desktop] vision=\" + JSON.stringify(visual));",
	T(6) + "if (visual.ok && visual.found && Number(visual.confidence) >= 0.35) {",
	T(7) + "const detailScreen = foundIcon.detail && foundIcon.detail.screen ? foundIcon.detail.screen : {};",
	T(7) + "const screenWidth = Number(frame.screenWidth) || Number(detailScreen.width) || 1920;",
	T(7) + "const screenHeight = Number(frame.screenHeight) || Number(detailScreen.height) || 1080;",
	T(7) + "const screenX = Number(detailScreen.x) || 0;",
	T(7) + "const screenY = Number(detailScreen.y) || 0;",
	T(7) + "foundIcon = {",
	T(8) + "ok: true,",
	T(8) + "match: {",
	T(9) + "name: visual.label || query,",
	T(9) + "path: \"\",",
	T(9) + "x: screenX + visual.x * screenWidth,",
	T(9) + "y: screenY + visual.y * screenHeight,",
	T(9) + "score: Math.round(Number(visual.confidence) * 1000),",
	T(9) + "visible: true,",
	T(9) + "source: \"vision\"",
	T(8) + "},",
	T(8) + "screen: { x: screenX, y: screenY, width: screenWidth, height: screenHeight },",
	T(8) + "foreground: { desktop: false },",
	T(8) + "source: \"vision\"",
	T(7) + "};",
	T(6) + "}",
	T(5) + "}",
	T(4) + "} catch (e) {",
	T(5) + "console.log(\"[dsh-pet:desktop] vision failed=\" + (e instanceof Error ? e.message : String(e)));",
	T(4) + "}",
	T(3) + "}",
	T(3) + "if (!foundIcon.ok || !foundIcon.match) {",
	T(4) + "console.log(\"[dsh-pet:desktop] lookup failed \" + JSON.stringify(foundIcon));",
	T(4) + "desktopActionBusy.delete(petId);",
	T(4) + "const text = \"\\u684c\\u9762\\u548c\\u5f53\\u524d\\u753b\\u9762\\u91cc\\u90fd\\u6ca1\\u627e\\u5230\\u201c\" + query + \"\\u201d\\uff0c\\u8bf7\\u786e\\u8ba4\\u5b83\\u6b63\\u5728\\u5c4f\\u5e55\\u4e0a\\u53ef\\u89c1\\u3002\";",
	T(4) + "const spoke = await desktopSay(petId, text);",
	T(4) + "return {",
	T(5) + "ok: false,",
	T(5) + "reason: foundIcon.reason || \"desktop-target-not-found\",",
	T(5) + "message: text,",
	T(5) + "...(spoke && spoke.ok ? { spoke: { ok: true, seconds: spoke.seconds, file: spoke.file } } : {})",
	T(4) + "};",
	T(3) + "}",
	T(3) + "const match = foundIcon.match;",
	T(3) + "const actionSource = String(match.source || foundIcon.source || \"desktop\");",
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
	T(3) + "console.log(\"[dsh-pet:desktop] target=\" + targetName + \" source=\" + actionSource + \" point=\" + (hasPoint ? iconX + \",\" + iconY : \"missing\") + \" path=\" + (targetPath || \"missing\"));",
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
	T(4) + "duration = current ? Math.max(1800, Math.min(7500, Math.round(distance / 0.28))) : 3600;",
	T(4) + "const runAnim = desktopRunAnim(found);",
	T(4) + "state.writePet(petId, \"position\", {",
	T(5) + "x: nx,",
	T(5) + "y: ny,",
	T(5) + "mode: \"line\",",
	T(5) + "duration,",
	T(5) + "motion: \"run\",",
	T(5) + "...(runAnim ? { anim: runAnim } : {}),",
	T(5) + "facing: leftHalf ? \"right\" : \"left\"",
	T(4) + "});",
	T(4) + "console.log(\"[dsh-pet:desktop] run position pet=\" + petId + \" x=\" + nx.toFixed(4) + \" y=\" + ny.toFixed(4) + \" duration=\" + duration);",
	T(3) + "}",
	T(3) + "const opening = hasPoint",
	T(4) + "? (actionSource === \"vision\" ? \"\\u6211\\u770b\\u5230\\u4e86\\uff0c\\u8fd9\\u5c31\\u8dd1\\u8fc7\\u53bb\\u70b9\" : \"\\u8fd9\\u5c31\\u8dd1\\u8fc7\\u53bb\\u5e2e\\u4f60\\u6253\\u5f00\") + targetName",
	T(4) + ": \"\\u684c\\u9762\\u56fe\\u6807\\u6682\\u65f6\\u6293\\u4e0d\\u5230\\u5750\\u6807\\uff0c\\u6211\\u76f4\\u63a5\\u5e2e\\u4f60\\u6253\\u5f00\" + targetName;",
	T(3) + "const spoke = await desktopSay(petId, opening);",
	T(3) + "const pointAnim = desktopPointAnim(found);",
	T(3) + "const finish = () => {",
	T(4) + "const run = async () => {",
	T(5) + "let clicked = false;",
	T(5) + "let launched = false;",
	T(5) + "try {",
	T(6) + "if (pointAnim) {",
	T(7) + "try { state.writePet(petId, \"anim\", { name: pointAnim }); } catch { }",
	T(7) + "console.log(\"[dsh-pet:desktop] point animation=\" + pointAnim);",
	T(7) + "await new Promise((resolve) => setTimeout(resolve, 650));",
	T(6) + "}",
	T(6) + "if (hasPoint) {",
	T(7) + "if (actionSource === \"vision\") {",
	T(8) + "clicked = (await __dshPetDesktop.clickScreenPoint(iconX, iconY)).ok === true;",
	T(7) + "} else {",
	T(8) + "clicked = (await __dshPetDesktop.invokeDesktopTarget(targetName)).ok === true;",
	T(8) + "if (!clicked) clicked = (await __dshPetDesktop.clickScreenPoint(iconX, iconY)).ok === true;",
	T(7) + "}",
	T(6) + "}",
	T(6) + "if (!clicked && targetPath) launched = (await __dshPetDesktop.launchDesktopTarget(targetPath)).ok === true;",
	T(6) + "console.log(\"[dsh-pet:desktop] finished clicked=\" + clicked + \" launched=\" + launched);",
	T(6) + "state.writePet(petId, \"say\", {",
	T(7) + "text: clicked || launched ? \"\\u5f00\\u597d\\u5566\\u3002\" : \"\\u70b9\\u4e0b\\u53bb\\u4f46\\u597d\\u50cf\\u6ca1\\u53cd\\u5e94\\uff0c\\u4f60\\u770b\\u4e00\\u4e0b\\u8fdb\\u7a0b\\u3002\"",
	T(6) + "});",
	T(5) + "} finally {",
	T(6) + "desktopActionBusy.delete(petId);",
	T(5) + "}",
	T(4) + "};",
	T(4) + "void run();",
	T(3) + "};",
	T(3) + "setTimeout(finish, Math.max(250, duration));",
	T(3) + "return {",
	T(4) + "ok: true,",
	T(4) + "text: opening,",
	T(4) + "action: { kind: \"desktop-open\", target: targetName, source: actionSource, moved: hasPoint, duration },",
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
