/**
 * Smoke tests for pure logic (no TTY required):
 *   node --experimental-strip-types test/smoke.ts
 * (or run via tsx/ts-node)
 */
import assert from "node:assert/strict";
import { filterSessions, flattenRows, groupSessions, projectLabel } from "../src/model.ts";
import type { SessionListEntry } from "../src/model.ts";
import { renderSidebar, formatDate, clip, pulseMarkerFor, PULSE_FRAMES } from "../src/render.ts";
import { listSessions, titleCacheSize } from "../src/sessions.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clampWidth,
  setPendingRefocus,
  takePendingRefocus,
  DEFAULT_KEYS,
  type SidebarKeyConfig,
} from "../src/config.ts";
import {
  decodeSidebarKey,
  isInertKeyEvent,
  matchesConfiguredKey,
  matchesConfiguredKeys,
  unusableConfiguredKeys,
} from "../src/keys.ts";
import { setKittyProtocolActive } from "@earendil-works/pi-tui";

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
const selectedCursor = rendered.lines[rendered.selectedLineIndex ?? 0];
assert.ok(selectedCursor.includes("->>"), "selected row carries the cursor");
assert.ok(!selectedCursor.includes("\x1b[7m"), "selection does not rely on inverse video");
assert.ok(!selectedCursor.includes("\x1b[53m"), "selection no longer draws a frame");

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

// --- sidebar layout: header, time budget, guide column, status line ---------
const plainLine = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
const clock = new Date();
const uiSessions = [
  session({
    id: "t1",
    cwd: "/proj/p",
    title: "今天的会话",
    modified: new Date(clock.getTime() - 3_600_000),
  }),
  session({
    id: "y1",
    cwd: "/proj/p",
    title: "今年的会话",
    // A different month guarantees "this year, not today".
    modified: new Date(clock.getFullYear(), (clock.getMonth() + 6) % 12, 15, 9, 30),
  }),
  session({
    id: "o1",
    cwd: "/proj/p",
    title: "去年的会话",
    modified: new Date(clock.getFullYear() - 1, 5, 15, 8, 0),
  }),
];
const uiGroups = groupSessions(uiSessions, "/proj/p", new Set(), true);
const uiFlat = flattenRows(uiGroups);
const uiState = {
  width: 30,
  searchQuery: null,
  groups: uiGroups,
  flatRows: uiFlat,
  selectedIndex: 0,
  currentSessionFile: uiSessions[0].path,
  currentCwd: "/proj/p",
  loading: false,
  focused: true,
  totalSessions: uiSessions.length,
  focusKey: "ctrl+shift+h",
};
const draw = (width: number, rows = 12, extra: Record<string, unknown> = {}) =>
  renderSidebar({ ...uiState, width, ...extra }, width, rows).lines.map(plainLine);

// Narrow: the time and guide columns are dropped so titles keep their room.
const narrow = draw(24);
assert.ok(!narrow.some((l) => /\d{1,2}:\d{2}|\d+\/\d+/.test(l)), "no time column at 24 columns");
assert.ok(!narrow.some((l) => l.includes("│")), "no guide column at 24 columns");
assert.ok(narrow[0].includes("3会话"), "counts stay in the header when the long form does not fit");
assert.ok(narrow[0].includes("Pi"), "header always names the panel");

// Wide enough for a 5-column time budget: time and guide appear.
const wide = draw(30);
assert.ok(wide.some((l) => /\d{1,2}:\d{2}/.test(l)), "time column appears at 30 columns");
assert.ok(wide.some((l) => l.includes("│")), "guide column appears at 30 columns");
assert.ok(wide[0].includes("1项目·3会话"), "full counts at 30 columns");
assert.ok(wide.some((l) => l.includes("●")), "current session is marked with ●");
// The current-project bar is replaced by the cursor while it sits on the folder
// row, so check the marker with the cursor on a session instead.
assert.ok(
  draw(30, 12, { selectedIndex: 1 }).some((l) => l.includes("▌")),
  "current project is marked with ▌",
);

// Wider still: full date labels come back instead of the compact numeric form.
const widest = draw(44);
assert.ok(widest.some((l) => l.includes("月")), "full date labels at 44 columns");

// One old session must not shift or remove the column for every other row.
const withOldOnly = draw(30).filter((l) => l.includes("今天") || l.includes("今年"));
assert.ok(withOldOnly.length === 2, "today and this-year rows are rendered");
for (const line of widest.concat(wide, narrow)) {
  assert.ok([...line].length <= 43, `row stays within the panel: ${JSON.stringify(line)}`);
}

// Status line: match count while searching, scroll hints when the list overflows.
const searching = draw(30, 12, { searchQuery: "今年" });
assert.ok(
  searching[searching.length - 1].includes("3/3 匹配"),
  "footer reports the match count while searching",
);
const manyGroups = groupSessions(
  Array.from({ length: 20 }, (_, i) => session({ id: `m${i}`, cwd: "/proj/p", title: `会话 ${i}` })),
  "/proj/p",
  new Set(),
  true,
);
const overflow = renderSidebar(
  { ...uiState, groups: manyGroups, flatRows: flattenRows(manyGroups), selectedIndex: 10 },
  30,
  12,
).lines.map(plainLine);
const foot = overflow[overflow.length - 1];
assert.ok(foot.includes("↑"), "footer hints at rows above the window");
assert.ok(foot.includes("↓"), "footer hints at rows below the window");

// --- folder rows must not read as session rows -------------------------------
const rawLines = (width: number, extra: Record<string, unknown> = {}) =>
  renderSidebar({ ...uiState, width, ...extra }, width, 12).lines;
const rawWide = rawLines(30);
const plainWide = rawWide.map(plainLine);
const folderOf = (lines: string[]) => lines.find((l) => l.includes("▣") || l.includes("▢")) ?? "";
const sessionOf = (lines: string[], title: string) =>
  lines.find((line) => plainLine(line).includes(title)) ?? "";
const cursorRow = (lines: string[]) => lines.find((l) => l.includes("->>")) ?? "";

// A folder gets its own colour and a container icon; sessions never do. The
// cursor replaces the icon while it sits on a folder row, so read the icon with
// the cursor parked on a session.
const cursorOnSession = rawLines(30, { selectedIndex: 1 });
assert.ok(folderOf(cursorOnSession).includes("▣"), "expanded folder uses the filled icon");
assert.ok(folderOf(cursorOnSession).includes("\x1b[94m"), "folder row is drawn in the folder colour");

// Icons follow the collapse state. Read them with the sidebar unfocused: the
// cursor replaces the icon while it sits on a folder row.
const collapsedGroups = groupSessions(uiSessions, "/proj/p", new Set(["/proj/p"]), true);
const collapsedRaw = rawLines(30, {
  groups: collapsedGroups,
  flatRows: flattenRows(collapsedGroups),
  focused: false,
});
assert.ok(collapsedRaw.some((l) => l.includes("▢")), "collapsed folder uses the hollow icon");
assert.ok(!collapsedRaw.some((l) => l.includes("▣")), "filled icon only while expanded");

// Sessions sit indented under their folder; the current one stays cyan.
assert.ok(
  plainWide.some((l) => l.startsWith("  ") && l.includes("今天的会话")),
  "session rows are indented under their folder",
);
assert.ok(sessionOf(rawWide, "今天的会话").includes("\x1b[96m"), "current session stays cyan");
assert.equal(
  sessionOf(rawWide, "今年的会话").includes("\x1b[94m"),
  false,
  "ordinary sessions are not drawn in the folder colour",
);

// Selection is an ASCII cursor (`->>`) in the row's kind colour. It replaces
// the lead and marker rather than being prepended, so a session's marker and
// title columns do not move when the cursor arrives.
const folderSelected = cursorRow(rawLines(30, { selectedIndex: 0 }));
assert.ok(folderSelected.includes("->>"), "folder selection draws the cursor");
assert.ok(folderSelected.includes("\x1b[94m"), "folder cursor keeps the folder colour");
assert.ok(!folderSelected.includes("\x1b[7m"), "folder selection does not invert");
assert.ok(!folderSelected.includes("\x1b[53m"), "folder selection draws no frame");

const sessionSelected = cursorRow(rawLines(30, { selectedIndex: 1 }));
assert.ok(sessionSelected.includes("今天的会话"), "the cursor row is the selected session");
assert.ok(sessionSelected.includes("\x1b[96m"), "the current session keeps its cyan cursor");
assert.ok(!sessionSelected.includes("\x1b[7m"), "session selection does not invert");

// The cursor belongs to the selection only: none is drawn while pi has focus.
assert.equal(
  rawLines(30, { focused: false }).filter((l) => l.includes("->>")).length,
  0,
  "no cursor while the sidebar is unfocused",
);
assert.equal(
  plainWide.filter((l) => l.includes("->>")).length,
  1,
  "exactly one row carries the cursor",
);

// The cursor occupies the same columns the marker used, so text never shifts.
const withCursor = plainLine(sessionSelected);
const withoutCursor = plainLine(sessionOf(rawLines(30, { selectedIndex: 2 }), "今天的会话"));
assert.equal(
  withCursor.indexOf("今天的会话"),
  withoutCursor.indexOf("今天的会话"),
  "the title column is identical whether or not the row is selected",
);

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

// --- mouse coordinates must be translated into pi's content space ------------
// pi maps a mouse event's absolute terminal column straight onto its own column
// (`x: rawX - 1`), so with the content shifted right by the sidebar width every
// click / drag / wheel would land `width` columns to the left of the pointer.
const makeMouseTui = (columns: number) => {
  const seen: string[] = [];
  const tui: any = {
    terminal: { columns, rows: 40, write() {} },
    // Sink: the compositor forwards the corrected sequence here.
    handleTerminalInput(data: string) {
      seen.push(data);
    },
  };
  return { tui, seen };
};
const { tui: mouseTui, seen: mouseSeen } = makeMouseTui(120);
const mouseComp = new SessionSidebarCompositor(
  mouseTui,
  () => ({ ...state, flatRows: [], groups: [] }),
  30,
  100,
);
mouseComp.install();

mouseTui.handleTerminalInput("\x1b[<0;40;10M");
assert.deepEqual(mouseSeen, ["\x1b[<0;10;10M"], "click shifted by the sidebar width");

mouseSeen.length = 0;
mouseTui.handleTerminalInput("\x1b[<32;41;12M");
assert.deepEqual(mouseSeen, ["\x1b[<32;11;12M"], "drag motion shifted");

mouseSeen.length = 0;
mouseTui.handleTerminalInput("\x1b[<0;10;10M");
assert.deepEqual(mouseSeen, [], "plain click over the sidebar is dropped, not sent to column 1");

mouseSeen.length = 0;
mouseTui.handleTerminalInput("\x1b[<64;5;10M");
assert.deepEqual(mouseSeen, ["\x1b[<64;1;10M"], "wheel over the sidebar still scrolls");

mouseSeen.length = 0;
mouseTui.handleTerminalInput("\x1b[<32;2;20M");
assert.deepEqual(mouseSeen, ["\x1b[<32;1;20M"], "dragging left into the sidebar clamps to column 1");

mouseSeen.length = 0;
mouseTui.handleTerminalInput("\x1b[<0;5;10m");
assert.deepEqual(mouseSeen, ["\x1b[<0;1;10m"], "release over the sidebar is clamped");

mouseSeen.length = 0;
mouseTui.handleTerminalInput("a");
assert.deepEqual(mouseSeen, ["a"], "non-mouse input is untouched");
mouseComp.dispose();

// Inactive sidebar (narrow terminal) renders no shift, so no correction either.
const { tui: narrowRawTui, seen: narrowSeen } = makeMouseTui(80);
const inactiveComp = new SessionSidebarCompositor(
  narrowRawTui,
  () => ({ ...state, flatRows: [], groups: [] }),
  30,
  100,
);
inactiveComp.install();
narrowRawTui.handleTerminalInput("\x1b[<0;40;10M");
assert.deepEqual(narrowSeen, ["\x1b[<0;40;10M"], "inactive sidebar leaves coordinates alone");
inactiveComp.dispose();

// --- sidebar key decoding ---------------------------------------------------
const keyCase = (data: string): string => {
  const a = decodeSidebarKey(data, DEFAULT_KEYS);
  return a.type === "switch" ? `switch:${a.keepFocus}` : a.type;
};

assert.equal(keyCase("\x1b"), "exit", "escape leaves focus");
assert.equal(keyCase("\x1b[A"), "up", "arrow up");
assert.equal(keyCase("\x1b[B"), "down", "arrow down");
assert.equal(keyCase("\x1b[C"), "right", "arrow right expands");
assert.equal(keyCase("\x1b[D"), "left", "arrow left collapses");
assert.equal(keyCase("\x1b[1;1A"), "up", "kitty arrow up");
assert.equal(keyCase("\r"), "switch:false", "Enter switches and hands focus back");
assert.equal(
  keyCase("\x1b[13;2u"),
  "switch:true",
  "Shift+Enter switches and keeps sidebar focus",
);
assert.equal(keyCase("\x0e"), "new", "Ctrl+N creates a session");
assert.equal(keyCase("\x12"), "rename", "Ctrl+R renames");
assert.equal(keyCase("\x15"), "clearSearch", "Ctrl+U clears the query");
assert.equal(keyCase("\x7f"), "backspace", "backspace edits the query");

// --- kitty press/repeat/release must not double-fire -------------------------
// A release of the focus key must not unfocus (that would make a single press
// focus and then instantly unfocus).
assert.equal(keyCase("\x1b[104;6u"), "exit", "focus key press leaves focus while focused");
assert.equal(keyCase("\x1b[104;6:3u"), "ignore", "focus key RELEASE is inert");
assert.equal(keyCase("\x1b[13;2:3u"), "ignore", "Shift+Enter RELEASE is inert");
assert.equal(keyCase("\x1b[13;1:3u"), "ignore", "Enter RELEASE is inert");
assert.equal(keyCase("\x1b[104;6:2u"), "ignore", "held focus key does not toggle repeatedly");
assert.equal(keyCase("\x1b[13;2:2u"), "ignore", "held Shift+Enter does not switch repeatedly");
assert.equal(keyCase("\x1b[1;1:2A"), "up", "held arrow still navigates");

// These inert events must be swallowed even while pi has focus, otherwise the
// editor's shortcut dispatcher would act on the release.
assert.equal(isInertKeyEvent("\x1b[104;6:3u", DEFAULT_KEYS), true, "release swallowed when unfocused");
assert.equal(isInertKeyEvent("\x1b[104;6:2u", DEFAULT_KEYS), true, "focus-key repeat swallowed");
assert.equal(isInertKeyEvent("\x1b[104;6u", DEFAULT_KEYS), false, "press reaches the dispatcher");
assert.equal(isInertKeyEvent("a", DEFAULT_KEYS), false, "ordinary keys untouched");
assert.equal(isInertKeyEvent("\x1b[1;1:2A", DEFAULT_KEYS), false, "arrow repeat untouched");
assert.equal(keyCase("a"), "type", "plain letters feed the search box");
assert.equal(keyCase("中"), "type", "wide characters feed the search box");
assert.equal(keyCase("\x03"), "ignore", "Ctrl+C is swallowed while focused");
assert.equal(keyCase("\x1b[9;5u"), "ignore", "unbound keys are swallowed");

// The focused sidebar must never leak keys to pi's editor.
for (const raw of ["\x03", "\x1b[9;5u", "\x1bZ", "\x1b[3~"]) {
  const action = decodeSidebarKey(raw, DEFAULT_KEYS);
  assert.ok(action.type === "ignore" || action.type === "type", `consumed: ${JSON.stringify(raw)}`);
}

// --- width shortcuts: Ctrl+Shift+= / Ctrl+Shift+- ----------------------------
// The `=` key id covers terminals that report the base key code; the explicit
// sequences cover terminals that report the produced character ('+' = 43),
// which cannot be written as a key id since pi splits ids on "+".
for (const [seq, label] of [
  ["\x1b[61;6u", "kitty: '=' + ctrl+shift"],
  ["\x1b[43;6u", "kitty: '+' + ctrl+shift"],
  ["\x1b[27;6;61~", "modifyOtherKeys: '=' + ctrl+shift"],
  ["\x1b[27;6;43~", "modifyOtherKeys: '+' + ctrl+shift"],
] as const) {
  assert.equal(keyCase(seq), "wider", `wider: ${label}`);
  assert.equal(matchesConfiguredKey(seq, DEFAULT_KEYS.wider), true, `matchesConfiguredKey(wider): ${label}`);
}
for (const [seq, label] of [
  ["\x1b[45;6u", "kitty: '-' + ctrl+shift"],
  ["\x1b[95;6u", "kitty: '_' + ctrl+shift"],
  ["\x1b[27;6;45~", "modifyOtherKeys: '-' + ctrl+shift"],
  ["\x1b[27;6;95~", "modifyOtherKeys: '_' + ctrl+shift"],
] as const) {
  assert.equal(keyCase(seq), "narrower", `narrower: ${label}`);
  assert.equal(matchesConfiguredKey(seq, DEFAULT_KEYS.narrower), true, `matchesConfiguredKey(narrower): ${label}`);
}

// pi binds Ctrl+- to undo and the width keys are shift-modified, so neither
// bare variant may resize the sidebar.
assert.equal(keyCase("\x1b[45;5u"), "ignore", "Ctrl+- (pi's undo) must not shrink");
assert.equal(keyCase("\x1b[61;5u"), "ignore", "Ctrl+= must not grow");
assert.equal(matchesConfiguredKey("\x1b[61;5u", DEFAULT_KEYS.wider), false, "unmodified Ctrl+= is not a width key");
assert.equal(matchesConfiguredKey("\x1b[45;5u", DEFAULT_KEYS.narrower), false, "unmodified Ctrl+- is not a width key");

// Typing +/- must keep working in the search box while focused.
assert.equal(keyCase("+"), "type", "'+' stays a search character");
assert.equal(keyCase("-"), "type", "'-' stays a search character");
assert.equal(keyCase("="), "type", "'=' stays a search character");
assert.equal(matchesConfiguredKey("+", DEFAULT_KEYS.wider), false, "plain '+' is not the shortcut");
assert.equal(matchesConfiguredKey("-", DEFAULT_KEYS.narrower), false, "plain '-' is not the shortcut");

// Held keys must not race past the intended width (release/repeat are inert).
assert.equal(keyCase("\x1b[61;6:3u"), "ignore", "width key RELEASE is inert");
assert.equal(keyCase("\x1b[61;6:2u"), "ignore", "width key REPEAT does not re-fire");

// --- show/hide shortcut + user-configurable keys --------------------------------
assert.equal(
  keyCase("\x1b[98;6u"),
  "toggleSidebar",
  "default toggle key (Ctrl+Shift+B) toggles the panel",
);
assert.equal(
  matchesConfiguredKey("\x1b[98;6u", DEFAULT_KEYS.toggle),
  true,
  "default toggle key is Ctrl+Shift+B",
);

// --- project bulk keys and folder jumps --------------------------------------
// matchesKey separates modified keys exactly, so the shift variants never
// collide with the plain arrows that move the cursor and fold one project.
assert.equal(keyCase("\x1b["), "collapseAll", "Alt+[ collapses every project");
assert.equal(keyCase("\x1b]"), "expandAll", "Alt+] expands every project");
assert.equal(keyCase("\x1b[1;2A"), "prevFolder", "Shift+Up jumps to the previous project");
assert.equal(keyCase("\x1b[1;2B"), "nextFolder", "Shift+Down jumps to the next project");
assert.equal(keyCase("\x1b[1;2D"), "focusSidebar", "Shift+Left reaches the sidebar");
assert.equal(keyCase("\x1b[1;2C"), "focusEditor", "Shift+Right returns to pi");
assert.equal(keyCase("\x1b[D"), "left", "plain Left still folds the current project only");
assert.equal(keyCase("\x1b[A"), "up", "plain Up still moves one row");
assert.equal(keyCase("\x1b[A"), "up", "plain Up still moves one row");

// Every shortcut can be replaced from the config file.
const CUSTOM: SidebarKeyConfig = {
  focus: "alt+s",
  toggle: "alt+t",
  wider: "alt+=",
  narrower: "alt+-",
  collapseAll: "alt+c",
  expandAll: "alt+e",
  prevFolder: "alt+p",
  nextFolder: "alt+n",
  focusLeft: "alt+l",
  focusRight: "alt+r",
};
const customCase = (data: string): string => {
  const a = decodeSidebarKey(data, CUSTOM);
  return a.type === "switch" ? `switch:${a.keepFocus}` : a.type;
};
assert.equal(customCase("\x1bs"), "exit", "custom focus key works");
assert.equal(customCase("\x1bt"), "toggleSidebar", "custom toggle key works");
assert.equal(customCase("\x1b="), "wider", "custom wider key works");
assert.equal(customCase("\x1b-"), "narrower", "custom narrower key works");
assert.equal(customCase("\x1bc"), "collapseAll", "custom collapse-all key works");
assert.equal(customCase("\x1be"), "expandAll", "custom expand-all key works");
assert.equal(customCase("\x1bp"), "prevFolder", "custom previous-project key works");
assert.equal(customCase("\x1bn"), "nextFolder", "custom next-project key works");
assert.equal(customCase("\x1bl"), "focusSidebar", "custom focus-left key works");
assert.equal(customCase("\x1br"), "focusEditor", "custom focus-right key works");
assert.equal(
  customCase("\x1b[1;2D"),
  "ignore",
  "the default focus-left key is unbound once replaced",
);
assert.equal(
  customCase("\x1b["),
  "ignore",
  "the default collapse-all key is unbound once replaced",
);
assert.equal(
  customCase("\x1b[1;2D"),
  "ignore",
  "the default collapse-all key is unbound once replaced",
);
assert.equal(
  customCase("\x1b[104;6u"),
  "ignore",
  "default focus key is unbound once it is replaced",
);
assert.equal(
  customCase("\x1b[98;6u"),
  "ignore",
  "default toggle key is unbound once it is replaced",
);
assert.equal(
  isInertKeyEvent("\x1b[115;3:2u", CUSTOM),
  true,
  "repeat of a custom key is inert",
);
assert.equal(
  isInertKeyEvent("\x1b[115;3u", CUSTOM),
  false,
  "press of a custom key is not inert",
);

// A malformed user-supplied key id must never throw.
assert.equal(matchesConfiguredKey("a", "not+a+valid+key"), false, "bad key id is ignored");
assert.equal(matchesConfiguredKey("a", ""), false, "empty key id is ignored");

// Boundaries: one column per press, clamped to the configured range.
assert.equal(clampWidth(20), 20, "minimum width kept");
assert.equal(clampWidth(20 - 1), 20, "shrinking past the minimum is clamped");
assert.equal(clampWidth(60), 60, "maximum width kept");
assert.equal(clampWidth(60 + 1), 60, "growing past the maximum is clamped");
assert.equal(clampWidth(29 + 1), 30, "one step grows by exactly one column");
assert.equal(clampWidth(29 - 1), 28, "one step shrinks by exactly one column");

// --- focus marker round-trip ("switch but stay in the sidebar") ---------------
setPendingRefocus(true);
assert.equal(takePendingRefocus(), true, "pending refocus survives a reload");
assert.equal(takePendingRefocus(), false, "marker is consumed exactly once");
setPendingRefocus(false); // leave no stray state behind
assert.equal(takePendingRefocus(), false, "cleared marker stays cleared");

// --- Ctrl+H needs the kitty keyboard protocol --------------------------------
// Its legacy byte is 0x08, the same as Backspace, so the key is skipped unless
// the terminal can tell them apart — otherwise every Backspace would toggle the
// panel. The Ctrl+Shift+H alias keeps working either way.
const focusList = DEFAULT_KEYS.focus; // "ctrl+h, ctrl+shift+h"
assert.equal(
  matchesConfiguredKeys("\x7f", focusList),
  false,
  "plain Backspace never focuses the sidebar",
);
assert.equal(
  matchesConfiguredKeys("\x08", focusList),
  false,
  "the Ctrl+H byte is skipped while the kitty protocol is off",
);
assert.equal(
  matchesConfiguredKeys("\x1b[104;6u", focusList),
  true,
  "the Ctrl+Shift+H alias still focuses without the kitty protocol",
);
assert.deepEqual(
  unusableConfiguredKeys(focusList),
  ["ctrl+h"],
  "Ctrl+H is reported as unusable without the kitty protocol",
);

setKittyProtocolActive(true);
assert.equal(
  matchesConfiguredKeys("\x1b[104;5u", focusList),
  true,
  "Ctrl+H focuses once the kitty protocol is active",
);
assert.equal(
  matchesConfiguredKeys("\x7f", focusList),
  false,
  "Backspace still never focuses the sidebar",
);
assert.deepEqual(unusableConfiguredKeys(focusList), [], "every key is usable with kitty on");
setKittyProtocolActive(false);


// --- lightweight session lister ----------------------------------------------
// Reading only the header line plus two small slices keeps a refresh cheap; the
// title cache is keyed by file revision, so unchanged files are never re-read.
const tempRoot = mkdtempSync(join(tmpdir(), "sidebar-lister-"));
const projDir = join(tempRoot, "--tmp-myproj--");
mkdirSync(projDir, { recursive: true });
const sessionFile = join(projDir, "2026-01-01T00-00-00-000Z_abc.jsonl");
const header = { type: "session", version: 3, id: "abc", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/myproj" };
const userMessage = {
  type: "message",
  id: "m1",
  parentId: null,
  timestamp: "2026-01-01T00:00:01.000Z",
  message: { role: "user", content: "修复登录 bug\n第二行" },
};
writeFileSync(sessionFile, [JSON.stringify(header), JSON.stringify(userMessage)].join("\n") + "\n");

const listed = listSessions([tempRoot]);
assert.equal(listed.length, 1, "one session file is listed");
assert.equal(listed[0].id, "abc", "id comes from the header line");
assert.equal(listed[0].cwd, "/tmp/myproj", "cwd comes from the header line");
assert.equal(listed[0].firstMessage, "修复登录 bug", "first user message becomes the summary");
assert.equal(listed[0].name, undefined, "an unnamed session has no name");

// A rename appends a session_info entry; the file revision changes so the cached
// title must be recomputed.
writeFileSync(
  sessionFile,
  [
    JSON.stringify(header),
    JSON.stringify(userMessage),
    JSON.stringify({ type: "session_info", id: "n1", parentId: "m1", timestamp: "2026-01-02T00:00:00.000Z", name: "重命名后的会话" }),
  ].join("\n") + "\n",
);
const renamed = listSessions([tempRoot]);
assert.equal(renamed[0].name, "重命名后的会话", "a rename in the tail is picked up");
assert.equal(titleCacheSize() > 0, true, "titles are cached per file");

// Reading the same revision again must not need another pass, and a deleted file
// must not leave a stale cache entry behind.
const before = titleCacheSize();
listSessions([tempRoot]);
assert.equal(titleCacheSize(), before, "cache size is stable for unchanged files");
rmSync(sessionFile);
assert.equal(listSessions([tempRoot]).length, 0, "a deleted session disappears");
assert.equal(titleCacheSize(), 0, "cache is pruned when the file is gone");
rmSync(tempRoot, { recursive: true, force: true });

// --- landing pulse -----------------------------------------------------------
assert.equal(pulseMarkerFor(0), PULSE_FRAMES[0], "pulse starts on the first frame");
assert.equal(pulseMarkerFor(PULSE_FRAMES.length * 70), PULSE_FRAMES[0], "the pulse loops");
assert.equal(pulseMarkerFor(PULSE_FRAMES.length * 2 * 70), undefined, "the pulse ends after two turns");
assert.equal(pulseMarkerFor(-1), undefined, "a negative age has no frame");
for (const frame of PULSE_FRAMES) {
  assert.equal([...frame].length, 1, `pulse frame is single width: ${frame}`);
}

console.log("✓ all smoke tests passed");