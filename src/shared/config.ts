import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { SearchMode } from "../picker/session-selector-search.ts";

export type { SearchMode };

export type TerminalConfig = {
  type?: "system" | "Terminal.app" | "iTerm2" | "WezTerm" | "Kitty" | "Ghostty" | "Alacritty" | "x-terminal-emulator" | "gnome-terminal" | "konsole" | "xterm" | "custom";
  /** Terminal binary path, or .app path for macOS AppleScript terminals. */
  path?: string;
  executable?: string;
  args?: string[];
};
export type ShiftEnterConfig = {
  enabled: boolean;
  mode: "fork" | "same";
  piPath: string;
  terminal: TerminalConfig;
};
/** Folder-row Shift+Enter creates a new session in that folder. Independent of shiftEnter. */
export type FolderNewSessionConfig = {
  enabled: boolean;
  /** Remove sessions created this way if they never receive anything (default true). */
  cleanupUnused: boolean;
};

/** Persistent left-sidebar settings (user-editable). */
export type SidebarConfig = {
  enabled: boolean;
  width: number;
  showAllProjects: boolean;
  /** Shortcut that moves focus onto the sidebar. */
  focusKey: string;
};

export const MIN_WIDTH = 20;
export const MAX_WIDTH = 60;
export const DEFAULT_WIDTH = 30;
export const DEFAULT_FOCUS_KEY = "ctrl+shift+h";

export type MergedConfig = {
  sidebar: SidebarConfig;
  shiftEnter: ShiftEnterConfig;
  /** Bare-word matcher: "substring" (default) or "fuzzy" (native pi). */
  searchMode: SearchMode;
  folderNewSession: FolderNewSessionConfig;
};

/**
 * One config file at the package root, sections per feature. Hand edits are
 * validated strictly (fail-closed) like resume-plus; runtime changes made via
 * /session-sidebar commands update only the sidebar section.
 */
export const configPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "config.json",
);

const terminals = ["system", "Terminal.app", "iTerm2", "WezTerm", "Kitty", "Ghostty", "Alacritty", "x-terminal-emulator", "gnome-terminal", "konsole", "xterm", "custom"];

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须为对象`);
  return value as Record<string, unknown>;
}

export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(width)));
}

function parseSidebar(value: unknown): SidebarConfig {
  if (value === undefined) {
    return { enabled: true, width: DEFAULT_WIDTH, showAllProjects: true, focusKey: DEFAULT_FOCUS_KEY };
  }
  const section = object(value, "sidebar");
  if (section.enabled !== undefined && typeof section.enabled !== "boolean") throw new Error("sidebar.enabled 必须为 boolean");
  if (section.width !== undefined && (typeof section.width !== "number" || !Number.isFinite(section.width))) throw new Error("sidebar.width 必须为数字");
  if (section.showAllProjects !== undefined && typeof section.showAllProjects !== "boolean") throw new Error("sidebar.showAllProjects 必须为 boolean");
  if (section.focusKey !== undefined && (typeof section.focusKey !== "string" || !section.focusKey.trim())) throw new Error("sidebar.focusKey 必须为非空字符串");
  return {
    enabled: section.enabled === undefined ? true : (section.enabled as boolean),
    width: clampWidth(section.width === undefined ? DEFAULT_WIDTH : (section.width as number)),
    showAllProjects: section.showAllProjects === undefined ? true : (section.showAllProjects as boolean),
    focusKey: (section.focusKey as string) ?? DEFAULT_FOCUS_KEY,
  };
}

export function parseConfig(value: unknown): MergedConfig {
  const root = object(value, "config");
  const shift = root.shiftEnter === undefined ? {} : object(root.shiftEnter, "shiftEnter");
  const terminal = shift.terminal === undefined ? {} : object(shift.terminal, "shiftEnter.terminal");
  if (shift.enabled !== undefined && typeof shift.enabled !== "boolean") throw new Error("shiftEnter.enabled 必须为 boolean");
  if (shift.mode !== undefined && shift.mode !== "same" && shift.mode !== "fork") throw new Error("shiftEnter.mode 必须为 same 或 fork");
  for (const [key, value] of [["piPath", shift.piPath], ["terminal.path", terminal.path], ["terminal.executable", terminal.executable]] as const) {
    if (value !== undefined && (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value))) throw new Error(`${key} 必须为非空路径且不能含换行`);
  }
  if (terminal.type !== undefined && !terminals.includes(String(terminal.type))) throw new Error("不支持的 terminal.type");
  if (terminal.args !== undefined && (!Array.isArray(terminal.args) || terminal.args.some((arg) => typeof arg !== "string" || arg.includes("\0")))) throw new Error("terminal.args 必须为字符串数组");
  if (root.searchMode !== undefined && root.searchMode !== "substring" && root.searchMode !== "fuzzy") throw new Error('searchMode 必须为 "substring" 或 "fuzzy"');
  const folderNewSession = root.folderNewSession === undefined ? {} : object(root.folderNewSession, "folderNewSession");
  if (folderNewSession.enabled !== undefined && typeof folderNewSession.enabled !== "boolean") throw new Error("folderNewSession.enabled 必须为 boolean");
  if (folderNewSession.cleanupUnused !== undefined && typeof folderNewSession.cleanupUnused !== "boolean") throw new Error("folderNewSession.cleanupUnused 必须为 boolean");
  return {
    sidebar: parseSidebar(root.sidebar),
    shiftEnter: {
      enabled: shift.enabled === undefined ? true : (shift.enabled as boolean),
      mode: shift.mode === "fork" ? "fork" : "same",
      piPath: (shift.piPath as string) ?? "pi",
      terminal: { type: "system", ...terminal } as TerminalConfig,
    },
    searchMode: root.searchMode === "fuzzy" ? "fuzzy" : "substring",
    folderNewSession: {
      enabled: folderNewSession.enabled === undefined ? true : (folderNewSession.enabled as boolean),
      cleanupUnused: folderNewSession.cleanupUnused === undefined ? true : (folderNewSession.cleanupUnused as boolean),
    },
  };
}

export function readConfig(file = configPath): MergedConfig {
  try {
    return parseConfig(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseConfig({});
    throw new Error(`pi-session-sidebar 配置错误（${file}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Sidebar-facing loader: never throws; callers surface configError once. */
export function loadConfig(): { config: SidebarConfig; error: string | null } {
  try {
    return { config: readConfig().sidebar, error: null };
  } catch (error) {
    return {
      config: { enabled: true, width: DEFAULT_WIDTH, showAllProjects: true, focusKey: DEFAULT_FOCUS_KEY },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Persist runtime sidebar changes (width/enabled/... from commands) back into
 * the shared config.json, preserving every other section and unknown keys.
 * A malformed file is left untouched and reported, matching the fail-closed
 * philosophy: never clobber user configuration.
 */
export function saveConfig(sidebar: SidebarConfig): string | null {
  let root: Record<string, unknown> = {};
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) root = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return `配置文件无法解析，未写入：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  root.sidebar = {
    enabled: sidebar.enabled,
    width: sidebar.width,
    showAllProjects: sidebar.showAllProjects,
    focusKey: sidebar.focusKey,
  };
  try {
    writeFileSync(configPath, JSON.stringify(root, null, 2) + "\n", "utf8");
    return null;
  } catch (error) {
    return `配置写入失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Focus cannot survive a session switch in memory: switching replaces the
 * session and reloads extensions. So "switch but stay in the sidebar" writes a
 * one-shot marker before switching, consumed on the next session_start.
 */
function statePath(): string {
  return path.join(homedir(), ".pi", "agent", "pi-session-sidebar-state.json");
}

export function setPendingRefocus(value: boolean): void {
  try {
    const file = statePath();
    if (!existsSync(path.dirname(file))) mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ refocus: value }), "utf8");
  } catch {
    // Best effort.
  }
}

/** Read the marker once and clear it. */
export function takePendingRefocus(): boolean {
  try {
    const file = statePath();
    const raw = JSON.parse(readFileSync(file, "utf8")) as { refocus?: boolean };
    writeFileSync(file, JSON.stringify({ refocus: false }), "utf8");
    return raw.refocus === true;
  } catch {
    return false;
  }
}
