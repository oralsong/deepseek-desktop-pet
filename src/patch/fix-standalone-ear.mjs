// 修 standalone.js 两处：peek-toggle 的返回值判断（boolean vs {ok}）+ 补 /ear 路由
import { readFile, writeFile } from "node:fs/promises";

const file = process.argv[2];
let src = await readFile(file, "utf8");
const before = src.length;

// 1) peek-toggle：setPeekEnabled 返回 boolean，不能再读 w.ok
const badOk = `				const w = await __dshPetPeek.setPeekEnabled(userRoot, next);
				if (!w.ok) return { kind: "json", status: 200, obj: { ok: false, reason: "write-failed", message: w.message } };`;
const goodOk = `				const w = await __dshPetPeek.setPeekEnabled(userRoot, next);
				const wOk = w === true || (w && w.ok === true);
				if (!wOk) return { kind: "json", status: 200, obj: { ok: false, reason: "write-failed", message: (w && w.message) || "", dir: userRoot } };`;
if (src.includes(badOk)) {
	src = src.replace(badOk, goodOk);
	console.log("patched peek-toggle return check");
} else if (src.includes("const wOk = w === true")) {
	console.log("peek-toggle already patched");
} else {
	console.log("WARN peek-toggle anchor not found");
}

// 2) /ear 路由：插在 peek-toggle 之前
const earAnchor = `		if (rest === "peek-toggle") {`;
const earBlock = `		if (rest === "ear") {
			if (method !== "POST") return { kind: "json", status: 405, obj: { error: "method not allowed" } };
			try {
				const wantPet = (url.searchParams.get("pet") ?? "").trim();
				const exeDir = process.execPath.replace(/[\\\\/][^\\\\/]+$/, "");
				const rootDir = exeDir.replace(/[\\\\/][^\\\\/]+$/, "");
				const earScript = join(rootDir, "app", "pet-voice", "ear.py");
				const earPython = join(rootDir, "runtime", "python", "python.exe");
				const earState = (globalThis.__dshPetEar ||= { child: null });
				const alive = Boolean(earState.child && earState.child.exitCode === null && !earState.child.killed);
				const sayIt = (text) => {
					let pid2 = wantPet;
					if (!pid2) { try { pid2 = String(flattenPetList(readAllConfig(configPaths)).map((e) => e && e.id).find(Boolean) ?? ""); } catch { pid2 = ""; } }
					if (pid2) { try { state.writePet(pid2, "say", { text }); } catch { } }
				};
				if (alive) {
					try { earState.child.kill(); } catch { }
					earState.child = null;
					sayIt("耳朵关上了。");
					return { kind: "json", status: 200, obj: { ok: true, running: false } };
				}
				const child = spawn(earPython, [earScript], {
					cwd: join(rootDir, "app", "pet-voice"),
					env: { ...process.env, PYTHONIOENCODING: "utf-8" },
					windowsHide: true,
					detached: false,
					stdio: "ignore"
				});
				earState.child = child;
				child.on("exit", () => { try { earState.child = null; } catch { } });
				child.on("error", (e) => { try { console.warn("[dsh-pet:ear] " + (e && e.message)); } catch { } });
				sayIt("耳朵打开了，你说话我听得见～");
				return { kind: "json", status: 200, obj: { ok: true, running: true, pid: child.pid, script: earScript } };
			} catch (e) {
				return { kind: "json", status: 200, obj: { ok: false, reason: "ear-error", message: e instanceof Error ? e.message : String(e) } };
			}
		}
`;
if (src.includes(`if (rest === "ear")`)) {
	console.log("ear route already present");
} else if (src.includes(earAnchor)) {
	src = src.replace(earAnchor, earBlock + earAnchor);
	console.log("inserted ear route");
} else {
	console.log("WARN ear anchor not found");
}

if (src.length !== before) {
	await writeFile(file, src, "utf8");
	console.log("written", before, "->", src.length);
} else {
	console.log("no change");
}
