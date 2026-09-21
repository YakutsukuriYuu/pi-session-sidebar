import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * User-configurable shortcuts. Any key id that pi understands can be used
 * (e.g. "ctrl+shift+h", "alt+s", "f5"). Keys bound by pi or by pi-tui's editor
 * should be avoided: the sidebar consumes them globally, so pi would stop
 * seeing them.
 */
export interface SidebarKeyConfig {
  /** Focus the sidebar (and unfocus it again). */
  focus: string;
  /** Show / hide the sidebar panel. */
  toggle: string;
  /** Grow / shrink the sidebar width by one column. */
  wider: string;
  narrower: string;
}

export interface SidebarConfig {
  enabled: boolean;
  width: number;
  showAllProjects: boolean;
  keys: SidebarKeyConfig;
}

export const MIN_WIDTH = 20;
export const MAX_WIDTH = 60;
export const DEFAULT_WIDTH = 30;

export const DEFAULT_KEYS: SidebarKeyConfig = {
  focus: "ctrl+shift+h",
  // `b` (bar) is free in pi, pi-tui's editor and the fullscreen viewport.
  toggle: "ctrl+shift+b",
  // Shift+= produces "+" on most layouts; the base key id is "=" — see
  // matchesConfiguredKey in keys.ts for the terminals that report the
  // produced character instead.
  wider: "ctrl+shift+=",
  narrower: "ctrl+shift+-",
};

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

/** A non-empty string is a usable key id; anything else falls back. */
function keyOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function parseKeys(raw: Record<string, unknown>): SidebarKeyConfig {
  const section =
    raw.keys && typeof raw.keys === "object" && !Array.isArray(raw.keys)
      ? (raw.keys as Record<string, unknown>)
      : {};
  return {
    focus: keyOr(section.focus ?? raw.focusKey, DEFAULT_KEYS.focus),
    toggle: keyOr(section.toggle, DEFAULT_KEYS.toggle),
    wider: keyOr(section.wider, DEFAULT_KEYS.wider),
    narrower: keyOr(section.narrower, DEFAULT_KEYS.narrower),
  };
}

export function loadConfig(): SidebarConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
    return {
      enabled: raw.enabled !== false,
      width: clampWidth(typeof raw.width === "number" ? raw.width : DEFAULT_WIDTH),
      showAllProjects: raw.showAllProjects !== false,
      keys: parseKeys(raw),
    };
  } catch {
    return {
      enabled: true,
      width: DEFAULT_WIDTH,
      showAllProjects: true,
      keys: { ...DEFAULT_KEYS },
    };
  }
}

/** Persist the sidebar section (the file holds only sidebar settings). */
export function saveConfig(config: SidebarConfig): void {
  try {
    const path = configPath();
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    const payload = {
      enabled: config.enabled,
      width: config.width,
      showAllProjects: config.showAllProjects,
      keys: config.keys,
    };
    writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
  } catch {
    // Best effort; never break pi over a config write.
  }
}

export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(width)));
}
