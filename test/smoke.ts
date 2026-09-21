/**
 * Smoke tests for pure logic (no TTY required):
 *   node --experimental-strip-types test/smoke.ts
 * (or run via tsx/ts-node)
 */
import assert from "node:assert/strict";
import { filterSessions, flattenRows, groupSessions, projectLabel } from "../src/model.ts";
import type { SessionListEntry } from "../src/model.ts";
import { renderSidebar, formatDate, clip } from "../src/render.ts";
import { clampWidth } from "../src/config.ts";

function session(partial: Partial<SessionListEntry>): SessionListEntry {
  return {
    path: "/s/" + (partial.id ?? "x"),
    id: partial.id ?? "x",
    cwd: partial.cwd ?? "/proj/a",
    title: partial.title ?? "会话",
    modified: partial.modified ?? new Date(),
    messageCount: 1,
    firstMessage: partial.firstMessage ?? "",
    ...partial,
  };
}

// --- model ---------------------------------------------------------------
assert.equal(projectLabel("/Users/x/blog"), "blog");
assert.equal(projectLabel(""), "(unknown)");

const sessions = [
  session({ id: "1", cwd: "/proj/a", title: "A1", modified: new Date(2026, 0, 2) }),
  session({ id: "2", cwd: "/proj/a", title: "A2", modified: new Date(2026, 0, 3) }),
  session({ id: "3", cwd: "/proj/b", title: "B1", modified: new Date(2026, 0, 1) }),
];

const groups = groupSessions(sessions, "/proj/a", new Set(), true);
assert.equal(groups.length, 2);
assert.equal(groups[0].cwd, "/proj/a", "current project first");
assert.deepEqual(groups[0].sessions.map((s) => s.id), ["2", "1"], "newest first");

const flat = flattenRows(groups);
assert.deepEqual(flat.map((r) => r.kind), ["group", "session", "session", "group", "session"]);

const collapsed = groupSessions(sessions, "/proj/a", new Set(["/proj/a"]), true);
assert.deepEqual(flattenRows(collapsed).map((r) => r.kind), ["group", "group", "session"]);

assert.equal(filterSessions(sessions, "b1").length, 1);
assert.equal(filterSessions(sessions, "").length, 3);
assert.equal(filterSessions(sessions, "/proj/a").length, 2);

// --- config ---------------------------------------------------------------
assert.equal(clampWidth(5), 20);
assert.equal(clampWidth(500), 60);
assert.equal(clampWidth(30), 30);

// --- render ---------------------------------------------------------------
const state = {
  width: 30,
  searchQuery: null,
  groups,
  flatRows: flat,
  selectedIndex: 1,
  currentSessionFile: "/s/2",
  currentCwd: "/proj/a",
  loading: false,
  focused: true,
};
const rendered = renderSidebar(state, 30, 24);
assert.equal(rendered.lines.length, 24, "exactly rows lines");
assert.ok(rendered.lines[0].includes("Pi"), "header present");
assert.ok(
  rendered.lines.some((l) => l.includes("A2")),
  "session title rendered",
);
assert.ok(rendered.selectedLineIndex !== null, "selection visible");
assert.ok(rendered.lines[rendered.selectedLineIndex ?? 0].includes("\x1b[7m"), "selected row inverted");

const longTitle = renderSidebar(
  { ...state, groups: groupSessions([session({ id: "9", title: "x".repeat(200) })], "/proj/a", new Set(), true) },
  24,
  10,
);
for (const line of longTitle.lines) {
  // Strip ANSI for width check
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok([...plain].length <= 23, `line fits width: ${JSON.stringify(plain)}`);
}

// --- date formatting -------------------------------------------------------
const now = new Date(2026, 5, 10, 15, 0);
assert.equal(formatDate(new Date(2026, 5, 10, 9, 5), now), "09:05");
assert.equal(formatDate(new Date(2026, 0, 3), now), "1月3日");
assert.equal(formatDate(new Date(2024, 11, 31), now), "2024/12/31");

assert.equal(clip("hello", 10), "hello");
assert.ok(clip("hello world, this is long", 8).length <= 8 + 10); // ANSI adds bytes

// --- shiftRight transform (re-implemented here to test the regex logic) ----
// We exercise the real compositor transform via a minimal fake terminal.
const { SessionSidebarCompositor } = await import("../src/compositor.ts");
const written: string[] = [];
const fakeTerminal = {
  columns: 120,
  rows: 40,
  write(data: string) {
    written.push(data);
  },
};
const fakeTui = {
  terminal: fakeTerminal,
  doRender() {
    this.terminal.write("\x1b[?2026h\r\nhello\rworld\x1b[2K\x1b[5G\x1b[2;3H\x1b[H\x1b[?2026l");
  },
};
const comp = new SessionSidebarCompositor(
  fakeTui,
  () => ({ ...state, flatRows: [], groups: [] }),
  30,
  100,
);
comp.install();
assert.equal(fakeTerminal.columns, 90, "columns narrowed by reserved width"); // 120 - 30
fakeTui.doRender();
const frame = written[1]; // [0] is the sync-begin marker
assert.ok(!frame.includes("?2026"), "pi sync markers stripped");
assert.ok(frame.includes("\r\n\x1b[30C"), "crlf shifted");
assert.ok(frame.includes("\r\x1b[30C"), "cr shifted");
assert.ok(frame.includes("\x1b[0K"), "erase-line bounded");
assert.ok(frame.includes("\x1b[35G"), "CHA shifted");
assert.ok(frame.includes("\x1b[2;33H"), "CUP shifted");
assert.ok(frame.includes("\x1b[1;31H"), "home shifted");
assert.ok(!frame.includes("\x1b[2K"), "no full-line erase remains");
comp.dispose();
assert.equal(fakeTerminal.columns, 120, "columns restored");

// Narrow terminal: sidebar must be fully inert (no transform, no narrowing)
const written2: string[] = [];
const narrowTerminal = {
  columns: 80,
  rows: 24,
  write(data: string) {
    written2.push(data);
  },
};
const narrowTui = {
  terminal: narrowTerminal,
  doRender() {
    this.terminal.write("\x1b[?2026h\r\nhello\x1b[2K\x1b[5G\x1b[?2026l");
  },
};
const comp2 = new SessionSidebarCompositor(
  narrowTui,
  () => ({ ...state, flatRows: [], groups: [] }),
  30,
  100,
);
let autoHidden = false;
comp2.onAutoHide = () => {
  autoHidden = true;
};
comp2.install();
assert.equal(narrowTerminal.columns, 80, "narrow terminal: columns untouched");
assert.equal(comp2.isActive(), false, "inactive below min width");
narrowTui.doRender();
const narrowFrame = written2[0];
assert.ok(narrowFrame.includes("\x1b[?2026h"), "narrow: pi sync markers untouched");
assert.ok(narrowFrame.includes("\r\nhello"), "narrow: no shift injected");
assert.ok(narrowFrame.includes("\x1b[2K"), "narrow: erase untouched");
assert.ok(autoHidden, "auto-hide callback fired");
comp2.dispose();

console.log("✓ all smoke tests passed");
