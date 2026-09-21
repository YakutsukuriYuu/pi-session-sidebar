import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Copied semantics: pi 0.85.1 utils/paths.ts. Missing paths retain their spelling. */
export function canonicalizePath(path: string | undefined): string | undefined {
  if (path === undefined) return path;
  try { return realpathSync(path); } catch { return path; }
}

/** Native path normalization needed by getDefaultSessionDirPath, without mkdir. */
function resolvePath(input: string): string {
  let path = input;
  if (process.platform === "win32" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")) {
    const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (match) path = `${match[1]!.toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (path === "~") path = homedir();
  else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) path = join(homedir(), path.slice(2));
  if (path.startsWith("file://")) path = fileURLToPath(path);
  return isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
}

/** Copied pure helper: core/session-manager.ts, pi 0.85.1 (MIT). */
export function defaultSessionDir(cwd: string, agentDir = getAgentDir()): string {
  const safePath = `--${resolvePath(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolvePath(agentDir), "sessions", safePath);
}
