import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Session listing without reading whole session files.
 *
 * `SessionManager.listAll()` reads every session file end to end to build the
 * first message, the message count and a full-text search field. The sidebar
 * needs none of the last two, and only needs the file's first message and its
 * display name — so the metadata comes from a header-line read plus `statSync`,
 * and only the two small slices of a file that actually hold a title are read.
 *
 * Every title is cached per file revision (size + mtime), so a refresh after a
 * session switch reads nothing at all unless a session changed.
 */

/** Bytes read from the start of a file (header + first user message). */
const HEAD_BYTES = 16 * 1024;
/** Bytes read from the end of a file (the latest name entry). */
const TAIL_BYTES = 4 * 1024;

export interface ListedSession {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  firstMessage: string;
  modified: Date;
  /** Unused by the sidebar, kept so the shape matches pi's SessionInfo. */
  messageCount: number;
}

interface TitleInfo {
  name?: string;
  firstMessage: string;
}

const titleCache = new Map<string, { size: number; mtimeMs: number } & TitleInfo>();

/** Read at most `length` bytes starting at `position`, decoded as UTF-8. */
function readSlice(path: string, position: number, length: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing useful to do if closing fails.
      }
    }
  }
}

function parseJsonLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A slice can end mid-line, and old files can hold junk: skip it.
    }
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** The header line carries the authoritative id and cwd. */
function readHeader(path: string): { id?: string; cwd?: string } {
  const head = readSlice(path, 0, 2048);
  const firstLine = head.split("\n")[0];
  if (!firstLine) return {};
  const record = asRecord(parseJsonLines(firstLine)[0]);
  if (!record) return {};
  return {
    id: typeof record.id === "string" ? record.id : undefined,
    cwd: typeof record.cwd === "string" && record.cwd ? record.cwd : undefined,
  };
}

/** Text of a user message entry, or null when the entry is not a user message. */
function userMessageText(entry: Record<string, unknown>): string | null {
  if (entry.type !== "message") return null;
  const message = asRecord(entry.message);
  if (!message || message.role !== "user") return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const record = asRecord(part);
      if (record?.type === "text" && typeof record.text === "string") return record.text;
    }
  }
  return null;
}

/** Display name from a `session_info` entry, if it carries one. */
function sessionInfoName(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== "session_info") return undefined;
  return typeof entry.name === "string" ? entry.name : undefined;
}

function summarize(text: string, limit = 200): string {
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return firstLine.length > limit ? `${firstLine.slice(0, limit)}…` : firstLine;
}

/**
 * Title information for one session file, cached by file revision.
 *
 * The first user message comes from the head; the display name is taken from
 * the head as well (a name set at creation) and from the tail (a rename, which
 * appends a new entry — the common case for anything set through the UI).
 */
function titleFor(path: string, size: number, mtimeMs: number): TitleInfo {
  const cached = titleCache.get(path);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
    return { name: cached.name, firstMessage: cached.firstMessage };
  }

  const headEntries = parseJsonLines(readSlice(path, 0, Math.min(HEAD_BYTES, size)));
  let firstMessage = "";
  let name: string | undefined;
  for (const raw of headEntries) {
    const entry = asRecord(raw);
    if (!entry) continue;
    if (!firstMessage) {
      const text = userMessageText(entry);
      if (text) firstMessage = summarize(text);
    }
    const headName = sessionInfoName(entry);
    if (headName) name = headName;
  }

  // The newest entry wins, and renames append at the end.
  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tailEntries = parseJsonLines(readSlice(path, tailStart, Math.min(TAIL_BYTES, size)));
  for (const raw of tailEntries) {
    const entry = asRecord(raw);
    if (!entry) continue;
    if (entry.type === "session_info") {
      name = typeof entry.name === "string" && entry.name ? entry.name : undefined;
    }
  }

  const info: TitleInfo = { name, firstMessage };
  titleCache.set(path, { size, mtimeMs, ...info });
  return info;
}

/** Drop cache entries whose file disappeared, so the map cannot grow forever. */
function pruneCache(seen: Set<string>): void {
  for (const path of titleCache.keys()) {
    if (!seen.has(path)) titleCache.delete(path);
  }
}

/**
 * Scan session directories for `*.jsonl` files.
 *
 * Layout: `<root>/<encoded-cwd>/<timestamp>_<id>.jsonl`, so the header line
 * gives the id and cwd and `statSync` gives the modification time — no session
 * content is read here.
 */
export function listSessions(roots: string[]): ListedSession[] {
  const sessions: ListedSession[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!existsSync(root)) continue;
    let dirs: string[];
    try {
      dirs = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const dirPath = join(root, dir);
      let files: string[];
      try {
        files = readdirSync(dirPath).filter((name) => name.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const file of files) {
        const path = join(dirPath, file);
        if (seen.has(path)) continue;
        let size = 0;
        let mtimeMs = 0;
        try {
          const stat = statSync(path);
          size = stat.size;
          mtimeMs = stat.mtimeMs;
        } catch {
          continue;
        }
        seen.add(path);
        const header = readHeader(path);
        const title = titleFor(path, size, mtimeMs);
        // A session without the header still needs a grouping key: the encoded
        // directory name is the fallback (its dashes make it lossy, but it is
        // stable and only used when the file does not carry a cwd).
        const cwd = header.cwd ?? `/${dir.replace(/^-+|-+$/g, "").replace(/-/g, "/")}`;
        sessions.push({
          path,
          id: header.id ?? file,
          cwd,
          name: title.name,
          firstMessage: title.firstMessage,
          modified: new Date(mtimeMs),
          messageCount: 0,
        });
      }
    }
  }

  pruneCache(seen);
  sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return sessions;
}

/** Exposed for tests: number of cached title entries. */
export function titleCacheSize(): number {
  return titleCache.size;
}
