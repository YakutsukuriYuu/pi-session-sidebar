import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import {
  clampWidth,
  loadConfig,
  saveConfig,
  setPendingRefocus,
  takePendingRefocus,
  DEFAULT_FOCUS_KEY,
} from "./src/config.ts";
import { SessionSidebarCompositor } from "./src/compositor.ts";
import { decodeSidebarKey, isInertKeyEvent } from "./src/keys.ts";
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
    compositor.install();
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
      "侧栏焦点 · 输入即搜索 · ↑↓ 选择 · Enter 切走 · ⇧Enter 留下 · ^N 新建 · ^R 重命名 · Esc 返回",
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

  // --- Raw keyboard input (focused sidebar only) ---------------------------------
  function handleInput(data: string): { consume?: boolean; data?: string } | undefined {
    // Key releases (and held-down repeats of the focus shortcut) are swallowed
    // regardless of focus. pi's editor does not filter kitty release events, so
    // forwarding them would let the shortcut dispatcher fire twice per press —
    // focus on press, focus away on release.
    if (isInertKeyEvent(data, config.focusKey)) return { consume: true };

    // Not focused: pi owns the keyboard, this extension stays out of the way.
    if (!focused) return undefined;

    const action = decodeSidebarKey(data, config.focusKey);
    switch (action.type) {
      case "exit":
        exitFocus();
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
        // When the terminal shrinks below the minimum width the sidebar hides
        // itself; leave focus so keys are never swallowed invisibly.
        if (compositor) {
          compositor.onAutoHide = () => {
            if (focused) {
              exitFocus();
              currentCtx?.ui.notify("窗口过窄，侧栏焦点已释放", "info");
            }
          };
        }
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
          config = { ...config, enabled: true };
          saveConfig(config);
          installCompositor();
          ctx.ui.notify("会话侧栏已开启", "info");
          break;
        case "off":
          config = { ...config, enabled: false };
          saveConfig(config);
          exitFocus();
          compositor?.dispose();
          compositor = null;
          ctx.ui.notify("会话侧栏已关闭（调整窗口大小后恢复全宽）", "info");
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
            `用法: /session-sidebar nav|on|off|width <n>|all|current|refresh —— 快捷键 ${config.focusKey} 聚焦侧栏`,
            "info",
          );
      }
      schedulePaint();
    },
  });

  // --- Shortcut: hand focus to the sidebar (and back) -------------------------------
  pi.registerShortcut(config.focusKey as KeyId, {
    description: "聚焦/离开会话侧栏（终端不支持该组合键时用 /session-sidebar nav）",
    handler: async (ctx) => {
      currentCtx = ctx;
      if (!config.enabled) {
        ctx.ui.notify("会话侧栏已关闭，使用 /session-sidebar on 开启", "warning");
        return;
      }
      if (focused) exitFocus();
      else enterFocus();
    },
  });
}

/** Re-export for tests/tools that want the default focus key. */
export { DEFAULT_FOCUS_KEY };
