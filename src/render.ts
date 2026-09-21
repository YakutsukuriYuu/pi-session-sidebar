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

/** Columns in front of a row's body: a padding space, the marker and a space. */
const ROW_PREFIX = 3;

/**
 * Titles are never squeezed below this many columns. Together with the minimum
 * usable time budget (below) this puts the time column's threshold at a
 * 30-column sidebar, and wider dates degrade instead of eating into the title.
 */
const MIN_TITLE_COLS = 20;

/** Narrowest time column worth showing: "14:23". */
const MIN_TIME_BUDGET = 5;
/** Widest time column we ever reserve: "2024/12/31" style needs 8 at most. */
const MAX_TIME_BUDGET = 8;

/** The hierarchy guide column only earns its space once there is room to spare. */
const GUIDE_MIN_WIDTH = 30;

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
 * Format a Date as a short absolute label:
 *   - today:     "14:23"
 *   - this year: "9月3日"
 *   - older:     "2024/12/31"
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

/**
 * Format a Date as an absolute label that fits `budget` columns, degrading the
 * precision rather than the column width:
 *
 *   14:23  →  9月3日 / 12月31日  →  9/3 / 12/31  →  2024/12/31 → 24/12/31 → 24/12
 *
 * Keeping the column a fixed width per render (instead of following the widest
 * label in the list) means one old session can never shift or remove the time
 * column for every other row.
 */
function formatTimeFor(date: Date, now: Date, budget: number): string {
  const full = formatDate(date, now);
  if (visibleWidth(full) <= budget) return full;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const year = date.getFullYear();
  const candidates =
    year === now.getFullYear()
      ? [`${month}/${day}`]
      : [`${year}/${month}/${day}`, `${String(year).slice(2)}/${month}/${day}`, `${String(year).slice(2)}/${month}`];
  for (const candidate of candidates) {
    if (visibleWidth(candidate) <= budget) return candidate;
  }
  return clip(full, budget);
}

export interface RenderedSidebar {
  /** Lines to paint, not padded to the sidebar width. */
  lines: string[];
  /** Line index (0-based within lines) of the selected row, if visible. */
  selectedLineIndex: number | null;
  /** Scroll offset applied to flat rows. */
  scrollOffset: number;
}

/** Left text plus right-aligned text, padded to exactly `width` columns. */
function joinSides(left: string, right: string, width: number): string {
  const rightWidth = right ? visibleWidth(right) : 0;
  const fits = Boolean(right) && visibleWidth(left) + rightWidth + 2 <= width;
  if (!fits) return pad(clip(left, width), width);
  const leftWidth = Math.max(1, width - rightWidth);
  return pad(clip(left, leftWidth), leftWidth) + right;
}

/** One list row: ` marker body ………right`, inverted when it is the selection. */
function rowLine(
  marker: string,
  body: string,
  right: string,
  isSelected: boolean,
  width: number,
): string {
  const rightWidth = right ? visibleWidth(right) : 0;
  const gap = right ? 1 : 0;
  const bodyWidth = Math.max(1, width - ROW_PREFIX - rightWidth - gap);
  const content = ` ${marker} ${pad(clip(body, bodyWidth), bodyWidth)}${right ? " " + right : ""}`;
  return isSelected ? selected(pad(content, width)) : content;
}

/**
 * Render the sidebar into `width` columns × `rows` visible lines.
 *
 * Layout: one header line (state badge, title, counts), one search/hint line,
 * the session list, and one status line (scroll position and match count).
 */
export function renderSidebar(
  state: SidebarRenderState,
  width: number,
  rows: number,
): RenderedSidebar {
  const inner = Math.max(1, width - 1); // one column right padding
  const lines: string[] = [];

  // --- header: badge + title on the left, project/session counts on the right
  const title = accent(bold("Pi 会话"));
  const headerLeft = state.focused ? `${selected(bold(" 导航 "))} ${title}` : ` ${title}`;
  const sessions = countSessions(state);
  // Counts degrade with the available room so the header never pushes the badge
  // or title out at narrow widths.
  const countsCandidates = [
    `${state.groups.length}项目·${sessions}会话`,
    `${sessions}会话`,
  ];
  const counts = countsCandidates.find(
    (candidate) => visibleWidth(headerLeft) + visibleWidth(candidate) + 2 <= inner,
  );
  lines.push(joinSides(headerLeft, counts ? dim(counts) : "", inner));

  // --- search box while searching, otherwise a short hint --------------------
  if (state.focused && state.searchQuery !== null) {
    lines.push(` ${dim("/")} ${clip(state.searchQuery, Math.max(1, inner - 4))}${accent("▏")}`);
  } else if (state.focused) {
    lines.push(dim(` ${clip("Enter 切换 · Esc 返回", Math.max(1, inner - 1))}`));
  } else {
    lines.push(dim(` ${clip(`${state.focusKey ?? "Ctrl+Shift+H"} 聚焦`, Math.max(1, inner - 1))}`));
  }

  const listStart = lines.length;
  // Reserve one row at the bottom for the status line.
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

  // The time column is one decision per render: it gets whatever is left after
  // the title budget, capped to a sane width.
  const timeBudget = Math.min(MAX_TIME_BUDGET, inner - ROW_PREFIX - 1 - MIN_TITLE_COLS);
  const showTime = timeBudget >= MIN_TIME_BUDGET;
  const showGuide = width >= GUIDE_MIN_WIDTH;
  const now = new Date();

  let selectedLineIndex: number | null = null;
  const visible = listRows > 0 ? flat.slice(scrollOffset, scrollOffset + listRows) : [];

  for (let i = 0; i < visible.length; i++) {
    const row = visible[i];
    const group = state.groups[row.groupIndex];
    if (!group) continue;
    const isSelected = scrollOffset + i === selectedFlat && flat.length > 0;
    if (isSelected) selectedLineIndex = lines.length;

    if (row.kind === "group") {
      // A left bar marks the project pi is currently running in; the collapse
      // affordance and the session count sit right-aligned.
      const isCurrentProject = group.cwd === state.currentCwd;
      const marker = isCurrentProject ? accent("▌") : " ";
      const icon = group.collapsed ? "▸" : "▾";
      const right = dim(`${icon}${group.sessions.length}`);
      const body = isCurrentProject ? accent(bold(group.label)) : bold(group.label);
      lines.push(rowLine(marker, body, right, isSelected && state.focused, inner));
    } else {
      const session = group.sessions[row.sessionIndex ?? 0];
      if (!session) continue;
      const isCurrent =
        state.currentSessionFile !== undefined && session.path === state.currentSessionFile;
      // `●` for the session pi is in, `│` as the hierarchy guide for the rest.
      let marker = " ";
      if (isCurrent) marker = accent("●");
      else if (showGuide) marker = dim("│");
      const right = showTime ? dim(formatTimeFor(session.modified, now, timeBudget)) : "";
      const body = isCurrent ? accent(session.title) : session.title;
      lines.push(rowLine(marker, body, right, isSelected && state.focused, inner));
    }
  }

  // Fill remaining rows so stale content is overwritten.
  while (lines.length < rows - 1) lines.push("");

  // --- status line: scroll position, match count, or loading/empty -----------
  const above = scrollOffset;
  const below = Math.max(0, flat.length - (scrollOffset + visible.length));
  const searching = Boolean(state.searchQuery && state.searchQuery.trim());
  const parts: string[] = [];
  if (above > 0) parts.push(`↑${above}`);
  if (searching) parts.push(`${sessions}/${state.totalSessions ?? sessions} 匹配`);
  if (below > 0) parts.push(`↓${below}`);

  let status: string;
  if (state.loading) {
    status = "加载中…";
  } else if (flat.length === 0) {
    status = searching ? "无匹配" : "暂无会话";
  } else {
    status = parts.join("  ");
  }
  lines.push(status ? dim(` ${clip(status, Math.max(1, inner - 1))}`) : "");

  return { lines, selectedLineIndex, scrollOffset };
}

function countSessions(state: SidebarRenderState): number {
  return state.groups.reduce((n, g) => n + g.sessions.length, 0);
}

function pad(text: string, width: number): string {
  const w = visibleWidth(text);
  return w >= width ? text : text + " ".repeat(width - w);
}
