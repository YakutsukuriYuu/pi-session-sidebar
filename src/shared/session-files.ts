import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { canonicalizePath } from "./paths.ts";

export type DeleteResult = { ok: boolean; method: "trash" | "unlink"; error?: string };

/**
 * Delete a session file synchronously, trying the `trash` CLI first and falling
 * back to a permanent unlink. Synchronous on purpose: the unused-session cleanup
 * also runs while pi is shutting down, where async work may never complete.
 */
export function deleteSessionFile(sessionPath: string): DeleteResult {
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	const trashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) parts.push(trashResult.error.message);
		const stderr = trashResult.stderr?.trim();
		if (stderr) parts.push(stderr.split("\n")[0] ?? stderr);
		return parts.length === 0 ? null : `trash: ${parts.join(" · ").slice(0, 200)}`;
	};

	// Treat success, or a file that is already gone, as done.
	if (trashResult.status === 0 || !existsSync(sessionPath)) return { ok: true, method: "trash" };

	try {
		unlinkSync(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (error) {
		const unlinkError = error instanceof Error ? error.message : String(error);
		const hint = trashErrorHint();
		return { ok: false, method: "unlink", error: hint ? `${unlinkError} (${hint})` : unlinkError };
	}
}

/**
 * pi only persists a session once it has an assistant message; a file holding
 * nothing but its header (plus model/thinking records) counts as unused in the
 * same sense. Any other entry - a message, a name, a label, a custom entry -
 * means the user did something with it, so it is never treated as unused.
 */
const UNUSED_ENTRY_TYPES = new Set(["session", "model_change", "thinking_level_change"]);

export function isSessionUnused(sessionPath: string): boolean {
	try {
		if (!existsSync(sessionPath)) return false;
		return SessionManager.open(sessionPath).getEntries().every((entry) => UNUSED_ENTRY_TYPES.has(entry.type));
	} catch {
		return false; // never delete when unsure
	}
}

/**
 * Tracking must survive session replacement, which re-instantiates extensions
 * (module state is lost), so the tracked paths live in a per-PID state file -
 * the same pattern the active-session registry uses. A SIGKILLed pi also leaves
 * its state file behind, and the next run sweeps it (liveness-checked).
 */
const stateDir = (): string => join(getAgentDir(), "resume-plus-unused");
const stateFileFor = (pid: number): string => join(stateDir(), `${pid}.json`);

function readTrackedFile(file: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
	} catch {
		return [];
	}
}

function writeTrackedFile(file: string, paths: string[]): void {
	mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
	if (paths.length === 0) { dropStateFile(file); return; }
	const temporary = `${file}.tmp`;
	writeFileSync(temporary, JSON.stringify(paths), { mode: 0o600 });
	renameSync(temporary, file);
}

function dropStateFile(file: string): void {
	try { unlinkSync(file); } catch { /* already gone */ }
}

function pidIsAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Remember a session file this extension created so it can be cleaned up if unused. */
export function trackUnusedSession(sessionPath: string): void {
	const canonical = canonicalizePath(sessionPath) ?? sessionPath;
	const file = stateFileFor(process.pid);
	const paths = readTrackedFile(file);
	if (!paths.includes(canonical)) writeTrackedFile(file, [...paths, canonical]);
}

export function untrackUnusedSession(sessionPath: string): void {
	const canonical = canonicalizePath(sessionPath) ?? sessionPath;
	const file = stateFileFor(process.pid);
	writeTrackedFile(file, readTrackedFile(file).filter((path) => path !== canonical));
}

export function trackedUnusedCount(): number {
	return readTrackedFile(stateFileFor(process.pid)).length;
}

/**
 * Remove tracked sessions that never received anything. `currentFile` is kept
 * even if unused: the user may be sitting in a fresh session about to type.
 * Used sessions are simply untracked. State files of dead processes are swept
 * too, which cleans up after a hard kill.
 */
export function cleanupTrackedUnusedSessions(currentFile?: string): void {
	const keep = currentFile ? canonicalizePath(currentFile) : undefined;
	const consider = (path: string): boolean => {
		if (keep !== undefined && path === keep) return true; // keep tracking it
		if (isSessionUnused(path)) deleteSessionFile(path);
		return false;
	};

	const own = stateFileFor(process.pid);
	const remaining = readTrackedFile(own).filter(consider);
	writeTrackedFile(own, remaining);

	let entries: string[] = [];
	try { entries = readdirSync(stateDir()); } catch { return; }
	for (const entry of entries) {
		if (!/^\d+\.json$/.test(entry)) continue;
		const pid = Number(entry.slice(0, -5));
		if (pid === process.pid || !Number.isSafeInteger(pid) || pidIsAlive(pid)) continue;
		const file = join(stateDir(), entry);
		const orphans = readTrackedFile(file).filter(consider);
		writeTrackedFile(file, orphans);
	}
}
