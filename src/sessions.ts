import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
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

/**
 * Bytes read from the start of a file before an already-found title is enough.
 *
 * pi writes a `system` message holding the whole system prompt as the first
 * message entry, and that entry is easily 60 KB — a fixed 16 KB window used to
 * miss the first user message of such a session and label it "(空会话)". The
 * head scan therefore continues until it has a title, and this window only
 * bounds how far it looks for a creation-time name.
 */
const HEAD_WINDOW_BYTES = 64 * 1024;
/** How far the head scan may run when no user message has been found yet. */
const MAX_TITLE_SCAN_BYTES = 4 * 1024 * 1024;
/** Chunk size of the progressive head scan. */
const SCAN_CHUNK_BYTES = 64 * 1024;
/** Bytes read from the end of a file (the latest name entry). */
const TAIL_BYTES = 4 * 1024;
/** How deep below a session root a session file may sit. */
const MAX_SCAN_DEPTH = 3;
/** Artifact trees that hold agent runs, not user sessions. */
const SKIPPED_DIRECTORIES = new Set(["subagent-artifacts"]);

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

/**
 * One JSON line as a record, or null when the line is blank, truncated, junk or
 * not an object. The shape is settled here so no caller has to re-check it.
 */
function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function parseJsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const parsed = parseLine(line);
    if (parsed !== null) out.push(parsed);
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
  const record = parseJsonLines(firstLine)[0];
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
    let image = false;
    for (const part of content) {
      const record = asRecord(part);
      if (record?.type === "text" && typeof record.text === "string") return record.text;
      if (record?.type === "image") image = true;
    }
    // A pasted image with no caption is still a user turn, not an empty session.
    if (image) return "[图片]";
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

  const head = scanHead(path, size);

  // The newest entry wins, and renames append at the end.
  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tailEntries = parseJsonLines(readSlice(path, tailStart, Math.min(TAIL_BYTES, size)));
  for (const entry of tailEntries) {
    if (entry.type === "session_info") {
      head.name = typeof entry.name === "string" && entry.name ? entry.name : undefined;
    }
  }

  const info: TitleInfo = { name: head.name, firstMessage: head.firstMessage };
  titleCache.set(path, { size, mtimeMs, ...info });
  return info;
}

/**
 * Hunt the first user message by reading forward in chunks.
 *
 * Reading stops as soon as a title exists and the name window is covered, so a
 * session whose first user message sits behind a 60 KB system message still
 * costs little — the rest of the file (often megabytes) is never touched.
 */
function scanHead(path: string, size: number): TitleInfo {
  let firstMessage = "";
  let name: string | undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    let position = 0;
    let carry = "";

    const consume = (text: string): void => {
      for (const line of text.split("\n")) {
        const entry = parseLine(line);
        if (!entry) continue;
        if (!firstMessage) {
          const message = userMessageText(entry);
          if (message) firstMessage = summarize(message);
        }
        const headName = sessionInfoName(entry);
        if (headName) name = headName;
      }
    };

    while (position < size) {
      const read = readSync(fd, buffer, 0, Math.min(SCAN_CHUNK_BYTES, size - position), position);
      if (read <= 0) break;
      position += read;
      const lines = (carry + buffer.subarray(0, read).toString("utf8")).split("\n");
      // The last element is a partial line the next chunk completes.
      carry = lines.pop() ?? "";
      consume(lines.join("\n"));
      if (firstMessage ? position >= HEAD_WINDOW_BYTES : position >= MAX_TITLE_SCAN_BYTES) break;
    }
    // A file can end without a trailing newline; then the carry is a real entry.
    if (carry) consume(carry);
  } catch {
    // An unreadable file simply has no title yet.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing useful to do if closing fails.
      }
    }
  }

  return { name, firstMessage };
}

/** Drop cache entries whose file disappeared, so the map cannot grow forever. */
function pruneCache(seen: Set<string>): void {
  for (const path of titleCache.keys()) {
    if (!seen.has(path)) titleCache.delete(path);
  }
}

/**
 * Every `*.jsonl` under `root`, bounded in depth.
 *
 * The documented layout is `<root>/<encoded-cwd>/<file>.jsonl`, but a plugin or
 * a custom session dir can nest one level deeper, and a sidebar that suddenly
 * finds nothing is worse than one that scans a little more. Subagent artifact
 * trees (deep, and not user sessions) are skipped explicitly.
 */
function collectSessionFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= MAX_SCAN_DEPTH) continue;
        if (SKIPPED_DIRECTORIES.has(entry.name) || /^run-\d+$/.test(entry.name)) continue;
        walk(path, depth + 1);
      } else if (entry.name.endsWith(".jsonl")) {
        files.push(path);
      }
    }
  };
  walk(root, 0);
  return files;
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
    for (const path of collectSessionFiles(root)) {
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
      // project directory is the fallback (its dashes make it lossy, but it is
      // stable and only used when the file does not carry a cwd).
      const projectDir = path.slice(root.length + 1).split(/[/\\]/)[0] ?? "";
      const cwd = header.cwd ?? `/${projectDir.replace(/^-+|-+$/g, "").replace(/-/g, "/")}`;
      sessions.push({
        path,
        id: header.id ?? path.split(/[/\\]/).pop() ?? path,
        cwd,
        name: title.name,
        firstMessage: title.firstMessage,
        modified: new Date(mtimeMs),
        messageCount: 0,
      });
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
