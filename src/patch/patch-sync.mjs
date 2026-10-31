// 给独立版补「先合成再冒泡」的同步逻辑（peek + chat 两条链路）
import { readFile, writeFile } from "node:fs/promises";

const file = process.argv[2];
let src = await readFile(file, "utf8");
const before = src.length;
let changes = [];

// 1) 全局持有变量
const anchor1 = "\tlet peekPrevSmall = null;";
if (!src.includes("let peekHoldSay = null;")) {
	if (!src.includes(anchor1)) throw new Error("anchor1 not found");
	src = src.replace(anchor1, anchor1 + "\n\tlet peekHoldSay = null;");
	changes.push("added peekHoldSay");
} else changes.push("peekHoldSay exists");

// 2) publishWhisper 写 say 处：先交给 hold
const oldSay = `\t\tstate.writePet(petId, "say", result.image ? {`;
if (src.includes(oldSay)) {
	const idx = src.indexOf(oldSay);
	const endMark = "\t\t\timage: result.image\n\t\t} : { text: result.text });";
	const end = src.indexOf(endMark, idx);
	if (end < 0) throw new Error("result say tail not found");
	const replacement = `\t\tif (peekHoldSay) peekHoldSay.text = result.text;\n\t\telse state.writePet(petId, "say", result.image ? {\n\t\t\ttext: result.text,\n\t\t\timage: result.image\n\t\t} : { text: result.text });`;
	const blockEnd = end + endMark.length;
	// 找到整段（从 oldSay 到 endMark 结束）一起替换
	src = src.slice(0, idx) + replacement + src.slice(blockEnd);
	changes.push("publishWhisper hold");
} else changes.push("WARN publishWhisper say anchor missing");

// 3) peekLook：先合成（play:false）→ 冒泡 → 起播
const oldPeek = `\t\tconst r = await publishWhisper(petId, { ...peekImage, hint: cfg.prompt || undefined, timeoutMs: cfg.generateTimeoutMs, candidates: peekCandidates(cfg) });`;
const newPeek = `\t\tconst holdSay = { text: "" };\n\t\tpeekHoldSay = holdSay;\n\t\tlet r;\n\t\ttry {\n\t\t\tr = await publishWhisper(petId, { ...peekImage, hint: cfg.prompt || undefined, timeoutMs: cfg.generateTimeoutMs, candidates: peekCandidates(cfg) });\n\t\t} finally {\n\t\t\tpeekHoldSay = null;\n\t\t}`;
if (src.includes(oldPeek)) {
	src = src.replace(oldPeek, newPeek);
	changes.push("peekLook hold");
} else changes.push("WARN peekLook anchor missing");

const oldSpeak = `\t\t\tspoke = await __dshPetPeek.speakLine(cfg, r.text).catch((e) => ({ ok: false, reason: "throw", message: e instanceof Error ? e.message : String(e) }));\n\t\t\tif (!spoke.ok) console.warn("[dsh-pet:peek] 语音失败：" + spoke.reason + " " + (spoke.message ?? ""));`;
const newSpeak = `\t\t\tspoke = await __dshPetPeek.speakLine(cfg, r.text, { play: false }).catch((e) => ({ ok: false, reason: "throw", message: e instanceof Error ? e.message : String(e) }));\n\t\t\tif (!spoke.ok) console.warn("[dsh-pet:peek] 语音失败：" + spoke.reason + " " + (spoke.message ?? ""));\n\t\t\tstate.writePet(petId, "say", { text: String(holdSay.text || r.text) });\n\t\t\tif (spoke.ok && spoke.file) void __dshPetPeek.playFile(cfg, spoke.file);`;
if (src.includes(oldSpeak)) {
	src = src.replace(oldSpeak, newSpeak);
	changes.push("peekLook say+play");
} else changes.push("WARN peek speak anchor missing");

// 4) chatWithPet：短回复先合成再冒泡
const oldChat = `\t\tawait writeMemory(mem);\n\t\tstate.writePet(petId, "say", generated.image ? {\n\t\t\ttext: generated.text,\n\t\t\timage: generated.image\n\t\t} : { text: generated.text });\n\t\treturn {\n\t\t\tok: true,\n\t\t\ttext: generated.text,\n\t\t\t...generated.image ? { image: generated.image } : {}\n\t\t};`;
const newChat = `\t\tawait writeMemory(mem);\n\t\tlet spokeChat = null;\n\t\tlet cfgChat = null;\n\t\ttry {\n\t\t\tcfgChat = (await __dshPetPeek.loadPeekConfig(userRoot)).cfg;\n\t\t} catch { cfgChat = null; }\n\t\tif (cfgChat && cfgChat.speak === true && generated.text && String(generated.text).length <= 40) {\n\t\t\tspokeChat = await __dshPetPeek.speakLine(cfgChat, generated.text, { play: false }).catch((e) => ({ ok: false, reason: "throw", message: e instanceof Error ? e.message : String(e) }));\n\t\t\tif (!spokeChat.ok) console.warn("[dsh-pet:chat] 语音失败：" + spokeChat.reason + " " + (spokeChat.message ?? ""));\n\t\t}\n\t\tstate.writePet(petId, "say", generated.image ? {\n\t\t\ttext: generated.text,\n\t\t\timage: generated.image\n\t\t} : { text: generated.text });\n\t\tif (spokeChat && spokeChat.ok && spokeChat.file && cfgChat) void __dshPetPeek.playFile(cfgChat, spokeChat.file);\n\t\treturn {\n\t\t\tok: true,\n\t\t\ttext: generated.text,\n\t\t\t...generated.image ? { image: generated.image } : {},\n\t\t\t...spokeChat && spokeChat.ok ? { spoke: { ok: true, seconds: spokeChat.seconds, file: spokeChat.file } } : {}\n\t\t};`;
if (src.includes(oldChat)) {
	src = src.replace(oldChat, newChat);
	changes.push("chat sync voice");
} else changes.push("WARN chat anchor missing");

await writeFile(file, src, "utf8");
console.log(changes.join("\n"));
console.log("size " + before + " -> " + src.length);
