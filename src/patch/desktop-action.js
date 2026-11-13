/**
 * Local desktop icon finder / clicker used by the standalone pet command path.
 *
 * The model is allowed to understand intent, but it never supplies a shell
 * command or an executable path. This module only opens a shortcut that was
 * found in the user's own Desktop folders.
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "desktop-action.ps1");

function runPowerShell(args, timeoutMs = 15000) {
	return new Promise((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args],
			{ windowsHide: true, encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024 },
			(error, stdout, stderr) => {
				resolve({
					ok: !error,
					error: error instanceof Error ? error.message : error ? String(error) : "",
					stdout: String(stdout || "").trim(),
					stderr: String(stderr || "").trim()
				});
			}
		);
	});
}

async function runWithResult(args, timeoutMs) {
	const run = await runPowerShell(args, timeoutMs);
	try {
		return JSON.parse(String(run.stdout || "").replace(/^\uFEFF/, ""));
	} catch {
		return {
			ok: false,
			reason: "desktop-helper-error",
			message: run.stderr || run.error || run.stdout || "桌面操作脚本没有返回结果"
		};
	}
}

/** Extract a target from commands such as 「打开PCL2」「帮我启动一下微信」. */
export function parseDesktopOpenCommand(text) {
	const raw = String(text || "").trim();
	if (!raw || raw.length > 200) return null;
	const normalized = raw
		.replace(/^[，,。.!！?？\s]+/, "")
		.replace(/[，,。.!！?？\s]+$/, "")
		.replace(/^(?:请|麻烦你?|帮我|给我|快去|去|立刻|马上)\s*/i, "");
	const match = normalized.match(
		/^(?:打开|启动|运行|点开|开一下|open|launch|start)\s*(?:一下|下)?\s*(.+?)(?:吧|呀|啊|呗)?$/i
	);
	if (!match) return null;
	const target = match[1]
		.replace(/^(?:桌面上的?|电脑上的?|那个)\s*/i, "")
		.replace(/(?:这个|那个)?(?:图标|快捷方式|软件|程序)$/i, "")
		.replace(/[，,。.!！?？"'“”‘’]/g, "")
		.trim();
	return target || null;
}

export async function findDesktopTarget(query) {
	const result = await runWithResult(["-Action", "find", "-Query", query], 15000);
	if (!result || result.ok !== true || !result.match) {
		return { ok: false, reason: "desktop-target-not-found", message: result?.message || "桌面上没找到这个快捷方式", detail: result };
	}
	return { ok: true, ...result };
}

export async function clickDesktopPoint(x, y) {
	if (process.env.DSH_PET_DESKTOP_DRY_RUN === "1") return { ok: true, dryRun: true, action: "click", x, y };
	return runWithResult(["-Action", "click", "-X", String(Math.round(x)), "-Y", String(Math.round(y))], 5000);
}

export async function invokeDesktopTarget(query) {
	if (process.env.DSH_PET_DESKTOP_DRY_RUN === "1") return { ok: true, dryRun: true, action: "invoke", query };
	return runWithResult(["-Action", "invoke", "-Query", query], 10000);
}

export async function launchDesktopTarget(path) {
	if (process.env.DSH_PET_DESKTOP_DRY_RUN === "1") return { ok: true, dryRun: true, action: "launch", path };
	return runWithResult(["-Action", "launch", "-Target", path], 10000);
}

export function desktopTargetLabel(result) {
	const name = result?.match?.name;
	return typeof name === "string" && name ? name : "";
}
