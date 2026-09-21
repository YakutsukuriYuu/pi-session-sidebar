import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SidebarConfig {
  enabled: boolean;
  width: number;
  showAllProjects: boolean;
  /** Shortcut that moves focus onto the sidebar. */
  focusKey: string;
}

export const MIN_WIDTH = 20;
export const MAX_WIDTH = 60;
export const DEFAULT_WIDTH = 30;
export const DEFAULT_FOCUS_KEY = "ctrl+shift+h";

function configPath(): string {
  return join(homedir(), ".pi", "agent", "pi-session-sidebar.json");
}

/**
 * Focus cannot survive a session switch in memory: switching replaces the
 * session and reloads extensions. So "switch but stay in the sidebar" writes a
 * one-shot marker before switching, consumed on the next session_start.
 */
function statePath(): string {
  return join(homedir(), ".pi", "agent", "pi-session-sidebar-state.json");
}

export function setPendingRefocus(value: boolean): void {
  try {
    const path = statePath();
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ refocus: value }), "utf8");
  } catch {
    // Best effort.
  }
}

/** Read the marker once and clear it. */
export function takePendingRefocus(): boolean {
  try {
    const path = statePath();
    const raw = JSON.parse(readFileSync(path, "utf8")) as { refocus?: boolean };
    writeFileSync(path, JSON.stringify({ refocus: false }), "utf8");
    return raw.refocus === true;
  } catch {
    return false;
  }
}

export function loadConfig(): SidebarConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<SidebarConfig>;
    return {
      enabled: raw.enabled !== false,
      width: clampWidth(raw.width ?? DEFAULT_WIDTH),
      showAllProjects: raw.showAllProjects !== false,
      focusKey: typeof raw.focusKey === "string" && raw.focusKey ? raw.focusKey : DEFAULT_FOCUS_KEY,
    };
  } catch {
    return {
      enabled: true,
      width: DEFAULT_WIDTH,
      showAllProjects: true,
      focusKey: DEFAULT_FOCUS_KEY,
    };
  }
}

export function saveConfig(config: SidebarConfig): void {
  try {
    const path = configPath();
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  } catch {
    // Best effort; never break pi over a config write.
  }
}

export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(width)));
}
