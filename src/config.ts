import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SidebarConfig {
  enabled: boolean;
  width: number;
  showAllProjects: boolean;
}

export const MIN_WIDTH = 20;
export const MAX_WIDTH = 60;
export const DEFAULT_WIDTH = 30;

function configPath(): string {
  return join(homedir(), ".pi", "agent", "pi-session-sidebar.json");
}

export function loadConfig(): SidebarConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<SidebarConfig>;
    return {
      enabled: raw.enabled !== false,
      width: clampWidth(raw.width ?? DEFAULT_WIDTH),
      showAllProjects: raw.showAllProjects !== false,
    };
  } catch {
    return { enabled: true, width: DEFAULT_WIDTH, showAllProjects: true };
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
