import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SidebarRenderState } from "./model.ts";

// ANSI helpers — keep tiny and dependency-free.
const esc = (code: string): string => `\x1b[${code}m`;
export const ANSI = {
  reset: esc("0"),
  bold: esc("1"),
  dim: esc("2"),
  inverse: esc("7"),
  fgGray: esc("90"),
  fgCyan: esc("96"),
};

export function dim(text: string): string {
  return `${ANSI.dim}${text}${ANSI.reset}`;
}

export function bold(text: string): string {
  return `${ANSI.bold}${text}${ANSI.reset}`;
}

export function accent(text: string): string {
  return `${ANSI.fgCyan}${text}${ANSI.reset}`;
}

/** Highlight (selected row): inverted colors. */
export function selected(text: string): string {
  return `${ANSI.inverse}${text}${ANSI.reset}`;
}

/**
 * Truncate a string to at most `width` visible columns, appending "…" when
 * truncated. ANSI escape sequences in `text` are preserved.
 */
export function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  return truncateToWidth(text, width, "…", true);
}

/**
 * Format a Date as a short label:
 *   - today:     "14:23"
 *   - this year: "9月3日"
 *   - older:     "2024/9/3"
 */
export function formatDate(date: Date, now: Date = new Date()): string {
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

export interface RenderedSidebar {
  /** Lines to paint, not padded to the sidebar width. */
  lines: string[];
  /** Line index (0-based within lines) of the selected row, if visible. */
  selectedLineIndex: number | null;
  /** Scroll offset applied to flat rows. */
  scrollOffset: number;
}

/**
 * Render the sidebar into `width` columns × `rows` visible lines.
 */
export function renderSidebar(
  state: SidebarRenderState,
  width: number,
  rows: number,
): RenderedSidebar {
  const inner = Math.max(1, width - 1); // one column right padding
  const lines: string[] = [];

  // Header
  const headerTitle = state.focused ? " Pi 会话 ●" : " Pi 会话";
  lines.push(`${accent(bold(headerTitle))}`);
  lines.push("");

  // Search line
  if (state.searchQuery !== null) {
    lines.push(` ${dim("/")} ${clip(state.searchQuery, inner - 4)}${ANSI.fgGray}▏${ANSI.reset}`);
  } else if (state.focused) {
    lines.push(dim(" / 搜索  n 新建  Esc 退出"));
  } else {
    lines.push(dim(" Ctrl+Shift+H 导航"));
  }
  lines.push("");

  const listStart = lines.length;
  // Reserve one footer row at the bottom.
  const listRows = Math.max(0, rows - listStart - 1);

  const flat = state.flatRows;
  const selectedFlat = flat.length === 0
    ? 0
    : Math.min(Math.max(0, state.selectedIndex), flat.length - 1);

  // Scroll so the selected row stays visible.
  let scrollOffset = 0;
  if (flat.length > listRows && listRows > 0) {
    scrollOffset = Math.min(Math.max(0, selectedFlat - listRows + 1), flat.length - listRows);
    if (selectedFlat < scrollOffset) scrollOffset = selectedFlat;
  }

  let selectedLineIndex: number | null = null;
  const visible = listRows > 0 ? flat.slice(scrollOffset, scrollOffset + listRows) : [];

  for (let i = 0; i < visible.length; i++) {
    const row = visible[i];
    const group = state.groups[row.groupIndex];
    if (!group) continue;
    const isSelected = scrollOffset + i === selectedFlat && flat.length > 0;
    if (isSelected) selectedLineIndex = lines.length;

    if (row.kind === "group") {
      const icon = group.collapsed ? "▸" : "▾";
      const label = `${icon} ${group.label}`;
      const count = dim(` ${group.sessions.length}`);
      const text = clip(label, Math.max(1, inner - 4)) + count;
      lines.push(isSelected && state.focused ? selected(pad(` ${text}`, inner)) : ` ${text}`);
    } else {
      const session = group.sessions[row.sessionIndex ?? 0];
      if (!session) continue;
      const isCurrent =
        state.currentSessionFile !== undefined && session.path === state.currentSessionFile;
      const marker = isCurrent ? accent("●") : " ";
      const date = dim(formatDate(session.modified));
      const titleWidth = Math.max(1, inner - visibleWidth(formatDate(session.modified)) - 5);
      const title = clip(session.title, titleWidth);
      const line = `${marker} ${title} ${date}`;
      lines.push(isSelected && state.focused ? selected(pad(` ${line}`, inner)) : ` ${line}`);
    }
  }

  // Fill remaining rows so stale content is overwritten.
  while (lines.length < rows - 1) lines.push("");

  // Footer
  if (state.loading) {
    lines.push(dim(" 加载中…"));
  } else if (flat.length === 0) {
    lines.push(dim(" 暂无会话"));
  } else {
    lines.push(dim(` ${state.groups.length} 项目 · ${countSessions(state)} 会话`));
  }

  return { lines, selectedLineIndex, scrollOffset };
}

function countSessions(state: SidebarRenderState): number {
  return state.groups.reduce((n, g) => n + g.sessions.length, 0);
}

function pad(text: string, width: number): string {
  const w = visibleWidth(text);
  return w >= width ? text : text + " ".repeat(width - w);
}
