export interface SessionListEntry {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  title: string;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

export interface ProjectGroup {
  cwd: string;
  label: string;
  sessions: SessionListEntry[];
  collapsed: boolean;
}

export interface SidebarRenderState {
  width: number;
  searchQuery: string | null;
  groups: ProjectGroup[];
  /** Flattened rows derived from groups. */
  flatRows: FlatRow[];
  selectedIndex: number;
  currentSessionFile: string | undefined;
  currentCwd: string;
  loading: boolean;
  /** True when the sidebar has keyboard focus (nav mode). */
  focused: boolean;
  /** Unfiltered session count, for the "3/7 匹配" footer. */
  totalSessions?: number;
  /** Configured focus shortcut, so the hint line shows the real key. */
  focusKey?: string;
}

export interface FlatRow {
  kind: "group" | "session";
  groupIndex: number;
  sessionIndex?: number;
}

export function projectLabel(cwd: string): string {
  if (!cwd) return "(unknown)";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/**
 * Build the flattened row list (groups + sessions), skipping collapsed groups.
 */
export function flattenRows(groups: ProjectGroup[]): FlatRow[] {
  const rows: FlatRow[] = [];
  groups.forEach((group, groupIndex) => {
    rows.push({ kind: "group", groupIndex });
    if (!group.collapsed) {
      group.sessions.forEach((_, sessionIndex) => {
        rows.push({ kind: "session", groupIndex, sessionIndex });
      });
    }
  });
  return rows;
}

/**
 * Group sessions by their working directory. Current project's group is
 * always expanded and sorted first; the rest are sorted by most recent
 * activity. Sessions inside a group are sorted by modification time (newest
 * first).
 */
export function groupSessions(
  sessions: SessionListEntry[],
  currentCwd: string,
  collapsedCwds: Set<string>,
  showAllProjects: boolean,
): ProjectGroup[] {
  const byCwd = new Map<string, SessionListEntry[]>();
  for (const s of sessions) {
    const cwd = s.cwd || currentCwd || "";
    if (!showAllProjects && cwd !== currentCwd) continue;
    const list = byCwd.get(cwd) ?? [];
    list.push(s);
    byCwd.set(cwd, list);
  }

  const groups: ProjectGroup[] = [...byCwd.entries()].map(([cwd, list]) => ({
    cwd,
    label: projectLabel(cwd),
    sessions: list.sort((a, b) => b.modified.getTime() - a.modified.getTime()),
    collapsed: collapsedCwds.has(cwd),
  }));

  groups.sort((a, b) => {
    if (a.cwd === currentCwd) return -1;
    if (b.cwd === currentCwd) return 1;
    const aTime = a.sessions[0]?.modified.getTime() ?? 0;
    const bTime = b.sessions[0]?.modified.getTime() ?? 0;
    return bTime - aTime;
  });

  return groups;
}

export function filterSessions(
  sessions: SessionListEntry[],
  query: string,
): SessionListEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) => {
    const haystack = `${s.title}\n${s.firstMessage}\n${s.cwd}\n${s.name ?? ""}`.toLowerCase();
    return haystack.includes(q);
  });
}
