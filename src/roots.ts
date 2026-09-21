import { dirname, join } from "node:path";

export interface SessionRootInput {
  /** `getAgentDir()` — the configured agent directory. */
  agentDir: string;
  /** The user's home directory. */
  homeDir: string;
  /** `ctx.sessionManager.getSessionDir()` — the current session's directory. */
  sessionDir?: string;
  /** `ctx.sessionManager.getSessionFile()` — the file pi is writing right now. */
  sessionFile?: string;
  /** When false, only the current project is listed. */
  showAllProjects: boolean;
}

/**
 * Directories to scan for session files.
 *
 * `getAgentDir()` is the obvious source, but it is not always the truth: a
 * plugin can move the agent directory (or pi can run with a custom one), and
 * the sidebar then scans a directory that holds no sessions and renders "no
 * sessions" while pi happily keeps writing them elsewhere.
 *
 * The current session file is the one source that cannot be wrong — pi is
 * writing to it — so its project directory and the sessions root above it are
 * always scanned as well. Extra roots are harmless: duplicates are removed by
 * path and a root that does not exist is skipped.
 */
export function resolveSessionRoots(input: SessionRootInput): string[] {
  const roots: string[] = [];
  const add = (dir: string | undefined): void => {
    if (!dir || roots.includes(dir)) return;
    roots.push(dir);
  };

  const defaultRoot = join(input.agentDir, "sessions");
  // `<root>/<encoded-cwd>/<session>.jsonl`
  const fileDir = input.sessionFile ? dirname(input.sessionFile) : undefined;
  const fileRoot = fileDir ? dirname(fileDir) : undefined;

  if (input.showAllProjects) {
    add(defaultRoot);
    add(fileRoot);
    add(fileDir);
    add(input.sessionDir);
    return roots;
  }

  // Current project only: the session's own directory is what matters, with the
  // configured dirs kept as a fallback.
  add(fileDir);
  add(input.sessionDir);
  add(defaultRoot);
  add(fileRoot);
  return roots;
}

/**
 * Last-resort root: the stock agent directory.
 *
 * Only consulted when the preferred roots yield no sessions at all, so an
 * isolated run (a different agent directory on purpose) is never mixed with the
 * user's real sessions — but a sidebar whose configured root went stale can
 * still find them.
 */
export function fallbackSessionRoot(homeDir: string): string {
  return join(homeDir, ".pi", "agent", "sessions");
}
