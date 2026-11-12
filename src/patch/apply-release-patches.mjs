/**
 * One-command patch pipeline for a freshly installed dsh-pet standalone package.
 *
 * Usage:
 *   node apply-release-patches.mjs --pkg <dsh-pet-package>
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function arg(name, fallback) {
	const i = argv.indexOf("--" + name);
	if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
	const eq = argv.find((a) => a.startsWith("--" + name + "="));
	if (eq) return eq.slice(name.length + 3);
	return fallback;
}

const PKG = resolve(arg("pkg", "C:/Users/win11/.dsh/profiles/desktop/node_modules/dsh-pet"));
const NODE = arg("node", process.execPath);
const standalone = join(PKG, "lib", "standalone.js");

function run(script, extra = []) {
	const result = spawnSync(NODE, [join(HERE, script), "--pkg", PKG, ...extra], {
		stdio: "inherit",
		windowsHide: false
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function runFile(script, file) {
	const result = spawnSync(NODE, [join(HERE, script), file], {
		stdio: "inherit",
		windowsHide: false
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(standalone)) {
	console.error("找不到 dsh-pet/lib/standalone.js：" + standalone);
	process.exit(1);
}

run("apply-standalone.mjs");
runFile("patch-sync.mjs", standalone);
runFile("fix-standalone-ear.mjs", standalone);
run("apply-desktop-action.mjs");
console.log("[petrelease] 所有补丁已应用。");
