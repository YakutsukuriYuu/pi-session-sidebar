import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clampWidth, loadConfig, saveConfig } from "./src/config.ts";
import { SessionSidebarCompositor } from "./src/compositor.ts";
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

/**
 * Nav-mode actions (switch/new/rename) need an ExtensionCommandContext, which
 * pi only hands to command handlers. So nav-mode keypresses are translated
 * into synthetic command input ("/session-sidebar switch <id>\r") via the
 * onTerminalInput transform channel — pi then dispatches the command with a
 * fresh, valid command context.
 */
const CMD = "/session-sidebar";

export default function (pi: ExtensionAPI) {
  let config = loadConfig();

  // --- Mutable state -------------------------------------------------------
  let allSessions: SessionListEntry[] = [];
  let loading = false;
  let searchQuery: string | null = null;
  let navMode = false; // sidebar has keyboard focus
  let selectedIndex = 0;
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
      focused: navMode,
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
      clampSelection();
      schedulePaint();
      if (refreshQueued) {
        refreshQueued = false;
        void refreshSessions();
      }
    }
  }

  // --- Nav mode ------------------------------------------------------------------
  function enterNavMode(): void {
    if (navMode) return;
    if (!compositor || !compositor.isActive()) {
      currentCtx?.ui.notify("终端太窄，会话侧栏已自动隐藏，无法进入导航", "warning");
      return;
    }
    navMode = true;
    selectCurrentSession();
    currentCtx?.ui.setStatus(
      "session-sidebar",
      "会话导航: ↑↓ 移动 · Enter 切换 · ←→ 折叠 · n 新建 · r 重命名 · / 搜索 · Esc 退出",
    );
    currentCtx?.ui.notify("已进入会话导航（Esc 退出）", "info");
    schedulePaint();
  }

  function exitNavMode(): void {
    if (!navMode) return;
    navMode = false;
    searchQuery = null;
    currentCtx?.ui.setStatus("session-sidebar", undefined);
    schedulePaint();
  }

  /**
   * Inject a synthetic extension command into pi's input pipeline.
   * The command is dispatched with a fresh ExtensionCommandContext, which is
   * the only context that carries switchSession/newSession.
   */
  function injectCommand(sub: string): { consume: boolean; data: string } {
    exitNavMode();
    return { consume: true, data: `${CMD} ${sub}\r` };
  }

  function toggleGroupAtSelection(): void {
    const target = currentRow();
    if (!target || target.row.kind !== "group") return;
    const state = buildState();
    const cwd = state.groups[target.row.groupIndex]?.cwd;
    if (!cwd) return;
    if (collapsedCwds.has(cwd)) collapsedCwds.delete(cwd);
    else collapsedCwds.add(cwd);
    clampSelection();
    schedulePaint();
  }

  // --- Raw keyboard input (nav mode) ---------------------------------------------
  function handleInput(data: string): { consume: boolean; data?: string } | undefined {
    if (!navMode) return undefined;

    // Search input mode: capture printable characters.
    if (searchQuery !== null) {
      if (data === "\x1b") {
        searchQuery = null;
        clampSelection();
        selectCurrentSession();
        schedulePaint();
        return { consume: true };
      }
      if (data === "\r" || data === "\n") {
        // Keep the filter, leave search-input mode (stay in nav mode).
        searchQuery = searchQuery.trim() ? searchQuery : null;
        schedulePaint();
        return { consume: true };
      }
      if (data === "\x7f" || data === "\b") {
        searchQuery = searchQuery.slice(0, -1);
        clampSelection();
        schedulePaint();
        return { consume: true };
      }
      if (data.startsWith("\x1b") || data.charCodeAt(0) < 32) {
        return { consume: true };
      }
      searchQuery += data;
      selectedIndex = 0;
      clampSelection();
      schedulePaint();
      return { consume: true };
    }

    switch (data) {
      case "\x1b": // Esc
        exitNavMode();
        return { consume: true };
      case "\x1b[A": // up
      case "\x1bOA":
        selectedIndex = Math.max(0, selectedIndex - 1);
        schedulePaint();
        return { consume: true };
      case "\x1b[B": // down
      case "\x1bOB": {
        const state = buildState();
        selectedIndex = Math.min(Math.max(0, state.flatRows.length - 1), selectedIndex + 1);
        schedulePaint();
        return { consume: true };
      }
      case "\x1b[D": // left → collapse
      case "\x1bOD": {
        const target = currentRow();
        if (target?.row.kind === "group") toggleGroupAtSelection();
        return { consume: true };
      }
      case "\x1b[C": // right → expand
      case "\x1bOC": {
        const target = currentRow();
        if (target?.row.kind === "group") {
          const state = buildState();
          const cwd = state.groups[target.row.groupIndex]?.cwd;
          if (cwd && collapsedCwds.has(cwd)) toggleGroupAtSelection();
        }
        return { consume: true };
      }
      case "\r":
      case "\n": {
        const target = currentRow();
        if (target?.row.kind === "group") {
          toggleGroupAtSelection();
          return { consume: true };
        }
        if (target?.session) {
          if (target.session.path === currentSessionFile) {
            exitNavMode();
            return { consume: true };
          }
          return injectCommand(`switch ${target.session.id}`);
        }
        return { consume: true };
      }
      case "n":
      case "N":
        return injectCommand("new");
      case "r":
      case "R": {
        const target = currentRow();
        if (target?.session) return injectCommand(`rename ${target.session.id}`);
        return { consume: true };
      }
      case "/":
        searchQuery = "";
        selectedIndex = 0;
        schedulePaint();
        return { consume: true };
      case "g":
        selectedIndex = 0;
        schedulePaint();
        return { consume: true };
      case "G": {
        const state = buildState();
        selectedIndex = Math.max(0, state.flatRows.length - 1);
        schedulePaint();
        return { consume: true };
      }
      default:
        // Pass through everything else (typing, Shift+Enter, Ctrl+C, …) so a
        // forgotten nav mode never hijacks normal editing.
        return undefined;
    }
  }

  // --- Extension wiring ------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    currentCwd = ctx.cwd;
    currentSessionFile = ctx.sessionManager.getSessionFile();
    navMode = false;
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
        // itself; leave nav mode so keys are never swallowed invisibly.
        if (compositor) {
          compositor.onAutoHide = () => {
            if (navMode) {
              exitNavMode();
              currentCtx?.ui.notify("窗口过窄，会话导航已退出", "info");
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

    void refreshSessions();
  });

  pi.on("session_shutdown", async () => {
    unsubscribeInput?.();
    unsubscribeInput = null;
    compositor?.dispose();
    compositor = null;
    tuiRef = null;
    currentCtx = null;
    navMode = false;
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
    description: "会话侧栏: on | off | width <n> | all | current | refresh",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      switch (sub) {
        case "nav":
          if (navMode) exitNavMode();
          else enterNavMode();
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
        // --- Internal subcommands (used by nav-mode key injection) -------------
        case "switch": {
          const id = rest[0];
          const session = allSessions.find((s) => s.id === id);
          if (!session) {
            ctx.ui.notify("找不到该会话，请刷新列表", "warning");
            break;
          }
          if (session.path === currentSessionFile) break;
          const result = await ctx.switchSession(session.path);
          if (result.cancelled) ctx.ui.notify("会话切换被取消", "warning");
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
            "用法: /session-sidebar nav|on|off|width <n>|all|current|refresh —— Ctrl+Shift+H 进入会话导航",
            "info",
          );
      }
      schedulePaint();
    },
  });

  // --- Shortcut: toggle nav mode --------------------------------------------------
  pi.registerShortcut("ctrl+shift+h", {
    description: "进入/退出会话侧栏导航（终端不支持时用 /session-sidebar nav）",
    handler: async (ctx) => {
      currentCtx = ctx;
      if (!config.enabled) {
        ctx.ui.notify("会话侧栏已关闭，使用 /session-sidebar on 开启", "warning");
        return;
      }
      if (navMode) exitNavMode();
      else enterNavMode();
    },
  });
}
