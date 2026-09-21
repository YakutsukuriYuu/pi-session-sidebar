import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { canonicalizePath } from "./paths.ts";

type ActiveSession = { pid: number; path: string; cwd: string; startedAt: number };
const startedAt = Date.now() - process.uptime() * 1000;
const directory = () => join(getAgentDir(), "resume-plus-active");
const ownFile = () => join(directory(), `${process.pid}.json`);

/** One atomic file per PID: independent processes cannot overwrite one another. */
export function registerActiveSession(path: string | undefined, cwd: string): void {
  if (!path) { unregisterActiveSession(); return; }
  mkdirSync(directory(), { recursive: true, mode: 0o700 });
  const temporary = `${ownFile()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, path: canonicalizePath(path), cwd, startedAt }), { mode: 0o600 });
  renameSync(temporary, ownFile());
}
export function unregisterActiveSession(): void {
  try { unlinkSync(ownFile()); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
function live(entry: ActiveSession): boolean {
  if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0 || typeof entry.path !== "string") return false;
  try { process.kill(entry.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
export function isSessionActive(path: string, currentPath?: string): boolean {
  const canonical = canonicalizePath(path);
  if (currentPath && canonicalizePath(currentPath) === canonical) return true;
  let files: string[] = [];
  try { files = readdirSync(directory()).filter((name) => /^\d+\.json$/.test(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const entries: ActiveSession[] = [];
  for (const file of files) {
    try { entries.push(JSON.parse(readFileSync(join(directory(), file), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  // Read-only compatibility with processes that have not /reload'ed the old version.
  try {
    const legacy = JSON.parse(readFileSync(join(getAgentDir(), "resume-plus-active.json"), "utf8"));
    if (Array.isArray(legacy)) entries.push(...legacy);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return entries.some((entry) => entry && live(entry) && canonicalizePath(entry.path) === canonical);
}
