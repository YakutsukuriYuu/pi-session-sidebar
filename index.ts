import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { isKeyRepeat } from "@earendil-works/pi-tui";
import {
  clampWidth,
  loadConfig,
  saveConfig,
  setPendingRefocus,
  takePendingRefocus,
  MAX_WIDTH,
  MIN_WIDTH,
  DEFAULT_KEYS,
} from "./src/config.ts";
import { SessionSidebarCompositor } from "./src/compositor.ts";
import { decodeSidebarKey, isInertKeyEvent, matchesConfiguredKeys, unusableConfiguredKeys } from "./src/keys.ts";
import {
  filterSessions,
  flattenRows,
  groupSessions,
  type FlatRow,
  type SessionListEntry,
  type SidebarRenderState,
} from "./src/model.ts";

/** Minimum terminal width for the sidebar; below this it auto-collapses. */
const MIN_RAW_COLUMNS = 100;

/** Our own command, used to reach a command context (see submitCommand). */
const CMD = "/session-sidebar";

/** Module state survives runtime rebinds, so this warning is once per process. */
let warnedAboutUnusableFocusKeys = false;

export default function (pi: ExtensionAPI) {
  let config = loadConfig();

  // --- Mutable state -------------------------------------------------------
  let allSessions: SessionListEntry[] = [];
  let loading = false;
  /** Filter text; non-null means the search box is live (always live while focused). */
  let searchQuery: string | null = null;
  /**
   * Focus owner. True = the sidebar owns the keyboard and pi's main pane
   * receives nothing. False = pi behaves exactly like stock pi.
   */
  let focused = false;
  let selectedIndex = 0;
  /** Cleared whenever the user moves the selection themselves. */
  let selectionPinnedToCurrent = true;
  const collapsedCwds = new Set<string>();
  let currentCwd = "";
  let currentSessionFile: string | undefined;
  let currentCtx: ExtensionContext | null = null;
  let tuiRef: unknown = null;
  let compositor: SessionSidebarCompositor | null = null;
  let unsubscribeInput: (() => void) | null = null;
  let paintTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshRunning = false;
  let refreshQueued = false;

  // --- Derived state ---------------------------------------------------------
  function buildState(): SidebarRenderState {
    const filtered =
      searchQuery && searchQuery.trim() ? filterSessions(allSessions, searchQuery) : allSessions;
    const groups = groupSessions(filtered, currentCwd, collapsedCwds, config.showAllProjects);
    return {
      width: config.width,
      searchQuery,
      groups,
      flatRows: flattenRows(groups),
      selectedIndex,
      currentSessionFile,
      currentCwd,
      loading,
      focused,
      totalSessions: allSessions.length,
      focusKey: config.keys.focus,
    };
  }

  function currentRow(): { row: FlatRow; session: SessionListEntry | null } | null {
    const state = buildState();
    const row = state.flatRows[selectedIndex];
    if (!row) return null;
    if (row.kind === "session") {
      return { row, session: state.groups[row.groupIndex]?.sessions[row.sessionIndex ?? 0] ?? null };
    }
    return { row, session: null };
  }

  function clampSelection(): void {
    const state = buildState();
    if (state.flatRows.length === 0) {
      selectedIndex = 0;
    } else {
      selectedIndex = Math.min(Math.max(0, selectedIndex), state.flatRows.length - 1);
    }
  }

  /** Move selection onto the row of the current session. */
  function selectCurrentSession(): void {
    const state = buildState();
    if (!currentSessionFile) return;
    for (let i = 0; i < state.flatRows.length; i++) {
      const row = state.flatRows[i];
      if (row.kind !== "session") continue;
      const session = state.groups[row.groupIndex]?.sessions[row.sessionIndex ?? 0];
      if (session?.path === currentSessionFile) {
        selectedIndex = i;
        return;
      }
    }
  }

  // --- Rendering -------------------------------------------------------------
  function schedulePaint(): void {
    if (paintTimer) return;
    paintTimer = setTimeout(() => {
      paintTimer = null;
      compositor?.paint();
    }, 16);
  }

  /** Ask pi for a full render (needed when the cursor visibility changes). */
  function requestPiRender(): void {
    const tui = tuiRef as { requestRender?: () => void } | null;
    try {
      tui?.requestRender?.();
    } catch {
      // ignore
    }
  }

  function installCompositor(): void {
    compositor?.dispose();
    compositor = null;
    if (!config.enabled || !tuiRef) return;
    compositor = new SessionSidebarCompositor(tuiRef, buildState, config.width, MIN_RAW_COLUMNS);
    // When the terminal shrinks below the minimum width the sidebar hides
    // itself; leave focus so keys are never swallowed invisibly. Wired here so
    // a width change (which rebuilds the compositor) keeps the behaviour.
    compositor.onAutoHide = () => {
      if (focused) {
        exitFocus();
        currentCtx?.ui.notify("窗口过窄，侧栏焦点已释放", "info");
      }
    };
    compositor.install();
  }

  /**
   * Grow/shrink the sidebar by one column, clamped to [MIN_WIDTH, MAX_WIDTH]
   * and persisted so the width survives a restart.
   */
  function resizeSidebar(delta: number): void {
    const next = clampWidth(config.width + delta);
    if (next === config.width) {
      currentCtx?.ui.notify(
        delta > 0 ? `侧栏已是最大宽度（${MAX_WIDTH} 列）` : `侧栏已是最小宽度（${MIN_WIDTH} 列）`,
        "info",
      );
      return;
    }
    config = { ...config, width: next };
    saveConfig(config);
    // The width is baked into the compositor's geometry (it narrows
    // terminal.columns), so rebuild it and let pi redraw at the new width. The
    // mouse-column correction follows the same value automatically.
    installCompositor();
    requestPiRender();
    schedulePaint();
  }

  /**
   * Show/hide the sidebar panel. The panel owns the reserved columns, so hiding
   * hands pi's full width back and showing reserves it again; both are done by
   * rebuilding the compositor (installCompositor disposes first and stays empty
   * while disabled).
   */
  function setSidebarEnabled(enabled: boolean): void {
    const changed = config.enabled !== enabled;
    config = { ...config, enabled };
    if (changed) saveConfig(config);
    if (!enabled) exitFocus();
    installCompositor();
    requestPiRender();
    schedulePaint();
    currentCtx?.ui.notify(enabled ? "会话侧栏已显示" : "会话侧栏已隐藏", "info");
  }

  function toggleSidebar(): void {
    setSidebarEnabled(!config.enabled);
  }

  // --- Session list loading ----------------------------------------------------
  async function refreshSessions(): Promise<void> {
    if (refreshRunning) {
      refreshQueued = true;
      return;
    }
    refreshRunning = true;
    loading = true;
    schedulePaint();
    try {
      const infos = config.showAllProjects
        ? await SessionManager.listAll()
        : await SessionManager.list(currentCwd || process.cwd());
      allSessions = infos.map((info) => ({
        path: info.path,
        id: info.id,
        cwd: info.cwd || "",
        name: info.name,
        title: info.name || info.firstMessage || "(空会话)",
        modified: info.modified,
        messageCount: info.messageCount,
        firstMessage: info.firstMessage ?? "",
      }));
    } catch {
      // Keep the previous list on failure.
    } finally {
      loading = false;
      refreshRunning = false;
      if (selectionPinnedToCurrent) selectCurrentSession();
      clampSelection();
      schedulePaint();
      if (refreshQueued) {
        refreshQueued = false;
        void refreshSessions();
      }
    }
  }

  // --- Focus model ------------------------------------------------------------------
  function canFocus(): boolean {
    return Boolean(compositor && compositor.isActive());
  }

  function enterFocus(): void {
    if (focused) return;
    if (!canFocus()) {
      currentCtx?.ui.notify("终端太窄，会话侧栏已自动隐藏，无法聚焦", "warning");
      return;
    }
    focused = true;
    searchQuery = "";
    selectionPinnedToCurrent = true;
    selectCurrentSession();
    currentCtx?.ui.setStatus(
      "session-sidebar",
      "侧栏焦点 · 输入即搜索 · ↑↓ 选择 · Enter 切走 · ⇧Enter 留下 · ^N 新建 · ^R 重命名 · ⇧^=/⇧^- 调宽 · Esc 返回",
    );
    requestPiRender();
    schedulePaint();
  }

  function exitFocus(): void {
    if (!focused) return;
    focused = false;
    searchQuery = null;
    currentCtx?.ui.setStatus("session-sidebar", undefined);
    requestPiRender();
    schedulePaint();
  }

  /**
   * Run one of our own commands.
   *
   * switchSession/newSession only exist on ExtensionCommandContext, which pi
   * hands to command handlers. So the command is placed in the editor and
   * submitted with a synthetic Enter: pi then dispatches it with a fresh
   * command context. Note that pi's editor treats a "\r" inside a longer text
   * chunk as a literal newline, so the text and the Enter must be separate.
   */
  function submitCommand(
    sub: string,
    mode: "unfocus" | "refocus" | "stay",
  ): { consume?: boolean; data?: string } {
    // The command is typed into the editor, so a draft would corrupt it.
    let draft = "";
    try {
      draft = currentCtx?.ui.getEditorText() ?? "";
    } catch {
      draft = "";
    }
    if (draft.trim()) {
      currentCtx?.ui.notify("输入框里有未发送的内容，操作已取消", "warning");
      return { consume: true };
    }

    if (mode === "unfocus") {
      setPendingRefocus(false);
      exitFocus();
    } else if (mode === "refocus") {
      // A switch reloads the extension, so remember to re-focus afterwards.
      setPendingRefocus(true);
    }

    currentCtx?.ui.setEditorText(`${CMD} ${sub}`);
    return { data: "\r" };
  }

  function moveSelection(delta: number): void {
    const state = buildState();
    const max = Math.max(0, state.flatRows.length - 1);
    const next = Math.min(max, Math.max(0, selectedIndex + delta));
    if (next !== selectedIndex) {
      selectionPinnedToCurrent = false;
      selectedIndex = next;
      schedulePaint();
    }
  }

  function toggleGroupCollapsed(cwd: string | undefined): void {
    if (!cwd) return;
    if (collapsedCwds.has(cwd)) collapsedCwds.delete(cwd);
    else collapsedCwds.add(cwd);
    selectionPinnedToCurrent = false;
    clampSelection();
    schedulePaint();
  }

  function collapseOrExpandSelected(expand: boolean): void {
    const target = currentRow();
    if (!target || target.row.kind !== "group") return;
    const state = buildState();
    const cwd = state.groups[target.row.groupIndex]?.cwd;
    if (!cwd) return;
    if (expand && !collapsedCwds.has(cwd)) return;
    if (!expand && collapsedCwds.has(cwd)) return;
    toggleGroupCollapsed(cwd);
  }

  /** Identity of the row the cursor sits on, used to keep it put across list changes. */
  type RowAnchor = { kind: "session"; path: string } | { kind: "group"; cwd: string } | null;

  function selectionAnchor(): RowAnchor {
    const target = currentRow();
    if (!target) return null;
    if (target.session) return { kind: "session", path: target.session.path };
    const cwd = buildState().groups[target.row.groupIndex]?.cwd;
    return cwd ? { kind: "group", cwd } : null;
  }

  /** Put the cursor back on the anchored row, converging to its project if hidden. */
  function restoreSelection(anchor: RowAnchor): void {
    const state = buildState();
    const findSessionRow = (path: string): number =>
      state.flatRows.findIndex((row) => {
        if (row.kind !== "session") return false;
        return state.groups[row.groupIndex]?.sessions[row.sessionIndex ?? 0]?.path === path;
      });
    const findGroupRowOfSession = (path: string): number =>
      state.flatRows.findIndex((row) => {
        if (row.kind !== "group") return false;
        return Boolean(state.groups[row.groupIndex]?.sessions.some((s) => s.path === path));
      });
    const findGroupRow = (cwd: string): number =>
      state.flatRows.findIndex(
        (row) => row.kind === "group" && state.groups[row.groupIndex]?.cwd === cwd,
      );

    let index = -1;
    if (anchor?.kind === "group") index = findGroupRow(anchor.cwd);
    else if (anchor?.kind === "session") {
      index = findSessionRow(anchor.path);
      // Collapsing hid the session: fall back to its project heading.
      if (index < 0) index = findGroupRowOfSession(anchor.path);
    }
    if (index >= 0) selectedIndex = index;
    else clampSelection();
  }

  /** Collapse every project — the current one included, so "all" means all. */
  function collapseAllGroups(): void {
    const anchor = selectionAnchor();
    for (const group of buildState().groups) collapsedCwds.add(group.cwd);
    selectionPinnedToCurrent = false;
    restoreSelection(anchor);
    schedulePaint();
  }

  function expandAllGroups(): void {
    const anchor = selectionAnchor();
    collapsedCwds.clear();
    restoreSelection(anchor);
    schedulePaint();
  }

  /** Move the cursor to the previous/next project heading (no wrap-around). */
  function jumpToFolder(direction: number): void {
    const state = buildState();
    const groupRows: number[] = [];
    state.flatRows.forEach((row, index) => {
      if (row.kind === "group") groupRows.push(index);
    });
    if (groupRows.length === 0) return;
    const currentGroup = state.flatRows[selectedIndex]?.groupIndex ?? 0;
    const target = Math.min(Math.max(0, currentGroup + direction), groupRows.length - 1);
    const targetIndex = groupRows[target];
    if (targetIndex === undefined || targetIndex === selectedIndex) return;
    selectionPinnedToCurrent = false;
    selectedIndex = targetIndex;
    schedulePaint();
  }

  // --- Raw keyboard input ---------------------------------------------------------
  /** True while pi (or one of our dialogs) has an overlay on screen. */
  function hasOverlayOpen(): boolean {
    const tui = tuiRef as { hasOverlay?: () => boolean } | null;
    try {
      return typeof tui?.hasOverlay === "function" && tui.hasOverlay();
    } catch {
      return false;
    }
  }

  // --- Raw keyboard input ---------------------------------------------------------
  function handleInput(data: string): { consume?: boolean; data?: string } | undefined {
    // Key releases (and held-down repeats of the shortcut keys) are swallowed
    // regardless of focus. pi's editor does not filter kitty release events, so
    // forwarding them would let the shortcut dispatcher fire twice per press.
    if (isInertKeyEvent(data, config.keys)) return { consume: true };

    // One of pi's own overlays (a picker, the model selector, /tree, or our own
    // rename dialog) owns the keyboard while it is open: let it through. /tree
    // binds ctrl+left itself, and a dialog's keystrokes must reach the dialog.
    if (hasOverlayOpen()) return undefined;

    // The configured shortcuts work globally, focused or not. Auto-repeat is
    // swallowed instead of acted on, so holding a key cannot race ahead (the
    // panel would flip back and forth, or the width would run to the limit).
    const repeat = isKeyRepeat(data);
    if (matchesConfiguredKeys(data, config.keys.focus)) {
      if (!repeat) {
        if (focused) exitFocus();
        else enterFocus();
      }
      return { consume: true };
    }

    // Directional focus: ctrl+left reaches for the sidebar, ctrl+right hands the
    // keyboard back to pi. Each is a no-op when focus is already there.
    if (matchesConfiguredKeys(data, config.keys.focusLeft)) {
      if (!repeat && !focused) enterFocus();
      return { consume: true };
    }
    if (matchesConfiguredKeys(data, config.keys.focusRight)) {
      if (!repeat && focused) exitFocus();
      return { consume: true };
    }
    if (matchesConfiguredKeys(data, config.keys.toggle)) {
      if (!repeat) toggleSidebar();
      return { consume: true };
    }
    if (matchesConfiguredKeys(data, config.keys.wider)) {
      if (!repeat) resizeSidebar(1);
      return { consume: true };
    }
    if (matchesConfiguredKeys(data, config.keys.narrower)) {
      if (!repeat) resizeSidebar(-1);
      return { consume: true };
    }

    // Not focused: pi owns the keyboard, this extension stays out of the way.
    if (!focused) return undefined;

    const action = decodeSidebarKey(data, config.keys);
    switch (action.type) {
      case "exit":
        exitFocus();
        return { consume: true };

      case "toggleSidebar":
        toggleSidebar();
        return { consume: true };

      case "up":
        moveSelection(-1);
        return { consume: true };
      case "down":
        moveSelection(1);
        return { consume: true };
      case "left":
        collapseOrExpandSelected(false);
        return { consume: true };
      case "right":
        collapseOrExpandSelected(true);
        return { consume: true };

      case "collapseAll":
        collapseAllGroups();
        return { consume: true };
      case "expandAll":
        expandAllGroups();
        return { consume: true };
      case "prevFolder":
        jumpToFolder(-1);
        return { consume: true };
      case "nextFolder":
        jumpToFolder(1);
        return { consume: true };
      case "focusSidebar":
        if (!focused) enterFocus();
        return { consume: true };
      case "focusEditor":
        if (focused) exitFocus();
        return { consume: true };

      case "switch": {
        const target = currentRow();
        if (!target?.session) return { consume: true };
        if (target.session.path === currentSessionFile) {
          if (!action.keepFocus) exitFocus();
          return { consume: true };
        }
        return submitCommand(
          `switch ${target.session.id}`,
          action.keepFocus ? "refocus" : "unfocus",
        );
      }

      case "new":
        return submitCommand("new", "unfocus");

      case "rename": {
        const target = currentRow();
        if (!target?.session) return { consume: true };
        // Renaming does not replace the session, so focus simply stays here.
        return submitCommand(`rename ${target.session.id}`, "stay");
      }

      case "backspace":
        searchQuery = (searchQuery ?? "").slice(0, -1);
        selectionPinnedToCurrent = true;
        clampSelection();
        selectCurrentSession();
        schedulePaint();
        return { consume: true };

      case "clearSearch":
        searchQuery = "";
        selectionPinnedToCurrent = true;
        selectCurrentSession();
        schedulePaint();
        return { consume: true };

      case "type":
        searchQuery = (searchQuery ?? "") + action.text;
        selectedIndex = 0;
        selectionPinnedToCurrent = false;
        clampSelection();
        schedulePaint();
        return { consume: true };

      case "ignore":
      default:
        // True focus isolation: unbound keys are swallowed, never forwarded.
        return { consume: true };
    }
  }

  /**
   * Ctrl+H shares its legacy byte with Backspace; only terminals that speak the
   * kitty keyboard protocol can tell them apart, and keys.ts silently skips it
   * otherwise. Say so once, after the protocol negotiation has had time to
   * finish, so the missing shortcut is not a mystery.
   */
  function warnAboutUnusableFocusKeys(): void {
    if (warnedAboutUnusableFocusKeys) return;
    const timer = setTimeout(() => {
      const unusable = unusableConfiguredKeys(config.keys.focus);
      if (unusable.length === 0) return;
      warnedAboutUnusableFocusKeys = true;
      const usable = config.keys.focus
        .split(",")
        .map((key) => key.trim())
        .filter((key) => key && !unusable.includes(key.toLowerCase()));
      currentCtx?.ui.notify(
        `当前终端无法区分 ${unusable.join("/")}（与退格等键同码），已忽略；聚焦侧栏请用 ${
          usable.join(" 或 ") || "配置里的其它键"
        }`,
        "info",
      );
    }, 1500);
    timer.unref?.();
  }

  // --- Extension wiring ------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    currentCwd = ctx.cwd;
    currentSessionFile = ctx.sessionManager.getSessionFile();
    focused = false;
    searchQuery = null;

    if (!ctx.hasUI) return;

    unsubscribeInput?.();
    unsubscribeInput = ctx.ui.onTerminalInput(handleInput);

    // The widget factory hands us the TUI instance the compositor needs.
    // The widget itself renders nothing; the compositor paints the sidebar.
    ctx.ui.setWidget(
      "pi-session-sidebar",
      (tui: unknown) => {
        tuiRef = tui;
        installCompositor();
        return {
          dispose() {
            compositor?.dispose();
            compositor = null;
            tuiRef = null;
          },
          invalidate() {},
          render(): string[] {
            return [];
          },
        };
      },
      { placement: "belowEditor" },
    );

    // A "switch and stay" reloaded the extension; re-take focus.
    const refocus = takePendingRefocus();
    if (refocus) enterFocus();

    warnAboutUnusableFocusKeys();

    await refreshSessions();
    if (focused) selectCurrentSession();
  });

  pi.on("session_shutdown", async () => {
    unsubscribeInput?.();
    unsubscribeInput = null;
    compositor?.dispose();
    compositor = null;
    tuiRef = null;
    currentCtx = null;
    focused = false;
    searchQuery = null;
  });

  pi.on("session_info_changed", async () => {
    void refreshSessions();
  });

  // Repaint when the agent settles so the current session's timestamp stays fresh.
  pi.on("agent_settled", async () => {
    void refreshSessions();
  });

  pi.on("session_tree", async () => {
    void refreshSessions();
  });

  // --- Commands ------------------------------------------------------------------
  pi.registerCommand("session-sidebar", {
    description: "会话侧栏: nav | on | off | width <n> | all | current | refresh",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      switch (sub) {
        case "nav":
        case "focus":
          if (focused) exitFocus();
          else enterFocus();
          break;
        case "on":
          setSidebarEnabled(true);
          break;
        case "off":
          setSidebarEnabled(false);
          break;
        case "width": {
          const n = Number(rest[0]);
          if (!Number.isFinite(n)) {
            ctx.ui.notify("用法: /session-sidebar width <20-60>", "warning");
            break;
          }
          config = { ...config, width: clampWidth(n) };
          saveConfig(config);
          installCompositor();
          ctx.ui.notify(`侧栏宽度已设为 ${config.width}`, "info");
          break;
        }
        case "all":
          config = { ...config, showAllProjects: true };
          saveConfig(config);
          void refreshSessions();
          ctx.ui.notify("显示所有项目的会话", "info");
          break;
        case "current":
          config = { ...config, showAllProjects: false };
          saveConfig(config);
          void refreshSessions();
          ctx.ui.notify("只显示当前项目的会话", "info");
          break;
        case "refresh":
          void refreshSessions();
          ctx.ui.notify("会话列表已刷新", "info");
          break;
        // --- Internal subcommands (used by focused-sidebar key handling) --------
        case "switch": {
          const id = rest[0];
          const session = allSessions.find((s) => s.id === id);
          if (!session) {
            // Do not leave a "refocus" marker behind for a switch that never ran.
            setPendingRefocus(false);
            ctx.ui.notify("找不到该会话，请刷新列表", "warning");
            break;
          }
          if (session.path === currentSessionFile) {
            setPendingRefocus(false);
            break;
          }
          const result = await ctx.switchSession(session.path);
          if (result.cancelled) {
            setPendingRefocus(false);
            ctx.ui.notify("会话切换被取消", "warning");
          }
          break;
        }
        case "new":
          await ctx.newSession();
          break;
        case "rename": {
          const id = rest[0];
          const session = allSessions.find((s) => s.id === id);
          if (!session) break;
          if (session.path !== currentSessionFile) {
            ctx.ui.notify("只能重命名当前会话（请先切换到该会话）", "warning");
            break;
          }
          const name = await ctx.ui.input("重命名会话", session.title);
          if (name !== undefined && name.trim()) {
            pi.setSessionName(name.trim());
          }
          break;
        }
        default:
          ctx.ui.notify(
            `用法: /session-sidebar nav|on|off|width <n>|all|current|refresh —— ` +
              `快捷键: ${config.keys.focus} 聚焦 · ${config.keys.toggle} 显示/隐藏 · ` +
              `${config.keys.wider}/${config.keys.narrower} 调宽`,
            "info",
          );
      }
      schedulePaint();
    },
  });

  // --- Shortcuts --------------------------------------------------------------------
  // The input listener handles these first (it also supports key ids pi cannot
  // express, such as the shifted "+" variant); registering them keeps the
  // shortcuts discoverable in pi's own shortcut list.
  pi.registerShortcut(config.keys.focus as KeyId, {
    description: "聚焦/离开会话侧栏（终端不支持该组合键时用 /session-sidebar nav）",
    handler: async (ctx) => {
      currentCtx = ctx;
      if (!config.enabled) {
        ctx.ui.notify(`会话侧栏已隐藏，用 ${config.keys.toggle} 显示`, "warning");
        return;
      }
      if (focused) exitFocus();
      else enterFocus();
    },
  });

  pi.registerShortcut(config.keys.toggle as KeyId, {
    description: "显示/隐藏会话侧栏",
    handler: async (ctx) => {
      currentCtx = ctx;
      toggleSidebar();
    },
  });
}

/** Re-export for tests/tools that want the default shortcuts. */
export { DEFAULT_KEYS };
