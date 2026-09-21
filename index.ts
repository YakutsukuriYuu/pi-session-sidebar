import { existsSync, statSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { SessionSidebarCompositor } from "./src/sidebar/compositor.ts";
import { decodeSidebarKey, isInertKeyEvent } from "./src/sidebar/keys.ts";
import {
  filterSessions,
  flattenRows,
  groupSessions,
  type FlatRow,
  type SessionListEntry,
  type SidebarRenderState,
} from "./src/sidebar/model.ts";
import {
  clampWidth,
  loadConfig,
  readConfig,
  saveConfig,
  setPendingRefocus,
  takePendingRefocus,
  type MergedConfig,
  type SidebarConfig,
} from "./src/shared/config.ts";
import { SessionSelectorComponent } from "./src/picker/session-selector.ts";
import { launchInTerminal } from "./src/shared/terminal-launcher.ts";
import { canonicalizePath, defaultSessionDir } from "./src/shared/paths.ts";
import {
  isSessionActive,
  registerActiveSession,
  unregisterActiveSession,
} from "./src/shared/active-sessions.ts";
import {
  cleanupTrackedUnusedSessions,
  deleteSessionFile,
  trackUnusedSession,
  untrackUnusedSession,
} from "./src/shared/session-files.ts";

/** Minimum terminal width for the sidebar; below this it auto-collapses. */
const MIN_RAW_COLUMNS = 100;

/** Our own command, used to reach a command context (see submitCommand). */
const CMD = "/session-sidebar";

/** CLI flags that open the picker on startup, e.g. `pi --rr`. */
const STARTUP_FLAGS = ["rr", "resume-plus"] as const;

/**
 * pi's startup sequence installs its editor AFTER extensions get session_start
 * and clears the editor container, which wipes any non-overlay custom UI opened
 * that early. Overlays live outside the editor container and survive, so the
 * startup-triggered picker must open as an overlay. Module state survives
 * runtime rebinds (extension factories are cached), so one pending flag is
 * enough and is always consumed by the dispatched /r handler.
 */
let startupOverlayPending = false;

/** Whether unused sessions created by this extension are cleaned up (config). */
let cleanupUnused = true;

export default function (pi: ExtensionAPI) {
  const loaded = loadConfig();
  let config: SidebarConfig = loaded.config;
  let mergedConfig: MergedConfig | null = null;

  // --- Mutable sidebar state -------------------------------------------------
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

  /**
   * Dialogs and overlays (rename input, delete confirm, the /r picker) take
   * pi's keyboard focus. While one is open the sidebar must let keys through,
   * otherwise a focused sidebar would swallow the dialog's keystrokes.
   */
  let overlayDepth = 0;

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
      "侧栏焦点 · 输入搜索 · ↑↓ 选择 · Enter 切走 · ⇧Enter 留下 · ^O 新终端 · ^D 删除 · ^R 重命名 · Esc 返回",
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

  // --- Direct async actions (no command context needed) --------------------------
  /** Run a pi dialog while the sidebar holds focus: let keys reach the dialog. */
  async function withOverlay<T>(fn: () => Promise<T>): Promise<T> {
    overlayDepth++;
    try {
      return await fn();
    } finally {
      overlayDepth--;
      schedulePaint();
    }
  }

  async function renameSessionAction(session: SessionListEntry): Promise<void> {
    const ctx = currentCtx;
    if (!ctx) return;
    await withOverlay(async () => {
      const name = await ctx.ui.input("重命名会话", session.title);
      const next = name?.trim();
      if (!next) return;
      try {
        if (currentSessionFile && canonicalizePath(session.path) === canonicalizePath(currentSessionFile)) {
          pi.setSessionName(next);
        } else {
          SessionManager.open(session.path).appendSessionInfo(next);
        }
        void refreshSessions();
      } catch (error) {
        ctx.ui.notify(`重命名失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    });
  }

  async function deleteSessionAction(session: SessionListEntry): Promise<void> {
    const ctx = currentCtx;
    if (!ctx) return;
    if (currentSessionFile && canonicalizePath(session.path) === canonicalizePath(currentSessionFile)) {
      ctx.ui.notify("不能删除当前正在使用的会话", "warning");
      return;
    }
    if (isSessionActive(session.path, currentSessionFile)) {
      ctx.ui.notify("该会话正在其他窗口中使用，未删除", "warning");
      return;
    }
    await withOverlay(async () => {
      const ok = await ctx.ui.confirm("删除会话", `确定删除「${session.title}」？优先移入回收站。`);
      if (!ok) return;
      const result = deleteSessionFile(session.path);
      if (!result.ok) {
        ctx.ui.notify(`删除失败：${result.error ?? "未知错误"}`, "error");
        return;
      }
      ctx.ui.notify(`已删除会话（${result.method === "trash" ? "回收站" : "直接删除"}）`, "info");
      void refreshSessions();
    });
  }

  async function openExternalAction(session: SessionListEntry): Promise<void> {
    const ctx = currentCtx;
    if (!ctx) return;
    let cfg: MergedConfig;
    try {
      cfg = readConfig();
    } catch (error) {
      ctx.ui.notify(String(error instanceof Error ? error.message : error), "error");
      return;
    }
    const shiftEnter = cfg.shiftEnter;
    if (!shiftEnter.enabled) {
      ctx.ui.notify("新终端打开已禁用（config.json: shiftEnter.enabled）", "warning");
      return;
    }
    if (!existsSync(session.path)) {
      ctx.ui.notify("目标 session 已不存在", "warning");
      return;
    }
    await withOverlay(async () => {
      try {
        let mode = shiftEnter.mode;
        if (mode === "same" && isSessionActive(session.path, currentSessionFile)) {
          const ok = await ctx.ui.confirm(
            "Session 已经打开",
            "这个 session 正在使用。是否创建 fork 后在新终端打开？（否／取消不会打开）",
          );
          if (!ok) return;
          mode = "fork";
        }
        await launchInTerminal(shiftEnter.terminal, session.cwd || currentCwd, session.path, mode, shiftEnter.piPath);
        // Spawn acceptance isn't proof that the terminal's pi finished startup.
        ctx.ui.notify(`已提交新终端启动请求（${mode === "fork" ? "独立副本" : "原会话"}）`, "info");
      } catch (error) {
        ctx.ui.notify(`无法启动新终端：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    });
  }

  // --- Raw keyboard input --------------------------------------------------------
  function handleInput(data: string): { consume?: boolean; data?: string } | undefined {
    // Key releases (and held-down repeats of the focus shortcut) are swallowed
    // regardless of focus. pi's editor does not filter kitty release events, so
    // forwarding them would let the shortcut dispatcher fire twice per press.
    if (isInertKeyEvent(data, config.focusKey)) return { consume: true };

    // A dialog/overlay owns the keyboard: let its keys through.
    if (overlayDepth > 0) return undefined;

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
        if (!target) return { consume: true };
        if (target.row.kind === "group") {
          if (action.keepFocus) {
            // Shift+Enter on a project row: create a fresh session inside it.
            const group = buildState().groups[target.row.groupIndex];
            if (group && group.cwd) {
              return submitCommand(`new-in-folder ${encodeURIComponent(group.cwd)}`, "unfocus");
            }
            return { consume: true };
          }
          toggleGroupCollapsed(buildState().groups[target.row.groupIndex]?.cwd);
          return { consume: true };
        }
        const session = target.session;
        if (!session) return { consume: true };
        if (session.path === currentSessionFile) {
          if (!action.keepFocus) exitFocus();
          return { consume: true };
        }
        return submitCommand(`switch ${session.id}`, action.keepFocus ? "refocus" : "unfocus");
      }

      case "new":
        return submitCommand("new", "unfocus");

      case "rename": {
        const target = currentRow();
        if (!target?.session) return { consume: true };
        // Renaming needs no command context; run the dialog directly.
        void renameSessionAction(target.session);
        return { consume: true };
      }

      case "delete": {
        const target = currentRow();
        if (!target?.session) return { consume: true };
        void deleteSessionAction(target.session);
        return { consume: true };
      }

      case "openExternal": {
        const target = currentRow();
        if (!target?.session) return { consume: true };
        void openExternalAction(target.session);
        return { consume: true };
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

  // --- /r picker (from pi-resume-plus) ---------------------------------------------
  type Selection =
    | { action: "resume" | "terminal"; path: string }
    | { action: "new-in-folder"; folder: string }
    | { action: "exit" }
    | null;

  /** Create a session in another project folder and switch to it. */
  async function newSessionInFolder(ctx: ExtensionCommandContext, folder: string): Promise<void> {
    if (!existsSync(folder) || !statSync(folder).isDirectory()) {
      ctx.ui.notify(`目录不存在，无法新建会话：${folder}`, "error");
      return;
    }
    try {
      // Create the file in the directory pi would use for a new session in that
      // folder: the per-project default, or the configured custom sessionDir if
      // this process uses one. Using the *current* session's directory would store
      // e.g. a pi-hub session inside the Qwen directory, and since pi then reports
      // sessionDir != default(dir,cwd), the picker's All scope would degrade to
      // that single directory.
      const currentDir = ctx.sessionManager.getSessionDir();
      const usesDefaultDirs = !currentDir || currentDir === defaultSessionDir(ctx.sessionManager.getCwd());
      const targetDir = usesDefaultDirs ? defaultSessionDir(folder) : currentDir;
      const created = SessionManager.create(folder, targetDir || undefined);
      const file = created.getSessionFile();
      const header = created.getHeader();
      if (!file || !header) throw new Error("无法创建会话文件");
      // pi defers writing a new session file until the first assistant message,
      // and switching reads the target cwd from the file header. Without a file,
      // open() would fall back to process.cwd() (the current directory). Persist
      // the generated header, which makes it a valid session file for that cwd.
      writeFileSync(file, `${JSON.stringify(header)}\n`, { flag: "wx" });
      if (cleanupUnused) trackUnusedSession(file);
      const result = await ctx.switchSession(file);
      if (result?.cancelled) {
        // The switch was vetoed, so this fresh session was never entered.
        if (cleanupUnused) {
          untrackUnusedSession(file);
          try {
            deleteSessionFile(file);
          } catch {
            // ignore
          }
        }
      }
    } catch (error) {
      ctx.ui.notify(`无法在 ${folder} 新建会话：${error instanceof Error ? error.message : String(error)}`, "error");
    }
    // The replaced context is stale after a successful switch.
  }

  const openPicker = async (_args: string, ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("会话选择器只能在交互式 TUI 中使用", "error");
      return;
    }
    let cfg: MergedConfig;
    try {
      cfg = readConfig();
    } catch (error) {
      ctx.ui.notify(String(error instanceof Error ? error.message : error), "error");
      return;
    }
    const shiftEnter = cfg.shiftEnter;
    const searchMode = cfg.searchMode;
    const folderNewSession = cfg.folderNewSession;
    const cwd = ctx.sessionManager.getCwd();
    const sessionDir = ctx.sessionManager.getSessionDir();
    const currentFile = ctx.sessionManager.getSessionFile();
    // Exact native usesDefaultSessionDir comparison, using a copied pure helper
    // because that method is not part of ReadonlySessionManager's public API.
    const usesDefault = sessionDir === defaultSessionDir(cwd);
    const known = new Map<string, SessionInfo>();
    const remember = (sessions: SessionInfo[]) => {
      for (const session of sessions) known.set(session.path, session);
      return sessions;
    };
    const overlay = startupOverlayPending;
    startupOverlayPending = false;
    // Closing an overlay restores focus to the target captured when it was shown.
    // During pi's startup that target is undefined or the since-replaced editor
    // instance, so nothing owns the keyboard afterwards. Re-installing the current
    // editor (public API; its setEditorComponent path ends with setFocus(editor))
    // hands focus back to the live editor. Only the startup/overlay path needs it.
    const restoreEditorFocus = () => {
      if (!overlay) return;
      try {
        const previous = ctx.ui.getEditorComponent();
        ctx.ui.setEditorComponent(undefined);
        if (previous) ctx.ui.setEditorComponent(previous);
      } catch {
        // best effort: never fail the command because of focus repair
      }
    };
    let picker: SessionSelectorComponent | undefined;
    let focusWatchdog: ReturnType<typeof setInterval> | undefined;
    const selected = await withOverlay(async (): Promise<Selection> => {
      try {
        return await ctx.ui.custom<Selection>(
          (tui, theme, keybindings, done) => {
            picker = new SessionSelectorComponent(
              async (progress) => remember(await SessionManager.list(cwd, sessionDir, progress)),
              async (progress) =>
                remember(
                  await (usesDefault
                    ? SessionManager.listAll(progress)
                    : SessionManager.listAll(sessionDir, progress)),
                ),
              (path) => done({ action: "resume", path }),
              () => done(null),
              () => done({ action: "exit" }),
              () => tui.requestRender(),
              {
                theme,
                keybindings,
                renameSession: async (path, name) => {
                  const next = name?.trim();
                  if (!next) return;
                  if (currentFile && canonicalizePath(path) === canonicalizePath(currentFile))
                    pi.setSessionName(next);
                  else SessionManager.open(path).appendSessionInfo(next);
                },
                showRenameHint: true,
                currentCwd: cwd,
                searchMode,
                newSessionInFolder: folderNewSession.enabled
                  ? (folder: string) => done({ action: "new-in-folder", folder })
                  : undefined,
                onOpenInNew: shiftEnter.enabled ? (path) => done({ action: "terminal", path }) : undefined,
              },
              currentFile,
            );
            return picker;
          },
          overlay
            ? {
                overlay: true,
                overlayOptions: { width: "100%", maxHeight: "90%" },
                onHandle: (handle) => {
                  // pi's startup continues after session_start and steals keyboard
                  // focus (editor install clears the editor container). Overlays
                  // survive the wipe but lose focus; reclaim it until it stays.
                  handle.focus();
                  let stable = 0;
                  let ticks = 0;
                  focusWatchdog = setInterval(() => {
                    ticks++;
                    if (picker?.focused) {
                      stable++;
                      if (stable >= 13) {
                        // ~2s of uninterrupted focus: startup is done
                        if (focusWatchdog) clearInterval(focusWatchdog);
                        focusWatchdog = undefined;
                      }
                    } else {
                      stable = 0;
                      handle.focus();
                    }
                    if (ticks >= 70) {
                      // ~10s hard cap; never outlives the picker
                      if (focusWatchdog) clearInterval(focusWatchdog);
                      focusWatchdog = undefined;
                    }
                  }, 150);
                },
              }
            : undefined,
        );
      } finally {
        if (focusWatchdog) clearInterval(focusWatchdog);
      }
    });
    if (!selected) {
      restoreEditorFocus();
      return;
    }
    if (selected.action === "exit") {
      ctx.shutdown();
      return;
    }
    if (selected.action === "new-in-folder") {
      await newSessionInFolder(ctx, selected.folder);
      restoreEditorFocus();
      return;
    }
    if (selected.action === "resume") {
      // This is the native handleResumeSession path: trust, missing cwd prompt,
      // extension veto, replacement lifecycle and error handling stay with pi.
      await ctx.switchSession(selected.path);
      return; // Old pi/ctx are stale after replacement.
    }
    if (!shiftEnter.enabled) return;
    const target = known.get(selected.path);
    if (!target || !existsSync(target.path)) {
      ctx.ui.notify("目标 session 已不存在", "warning");
      return;
    }
    try {
      let mode = shiftEnter.mode;
      if (mode === "same" && isSessionActive(target.path, currentFile)) {
        if (
          !(await ctx.ui.confirm(
            "Session 已经打开",
            "这个 session 正在使用。是否创建 fork 后在新终端打开？（否／取消不会打开）",
          ))
        )
          return;
        mode = "fork";
      }
      await launchInTerminal(shiftEnter.terminal, target.cwd || cwd, target.path, mode, shiftEnter.piPath);
      // Spawn acceptance isn't proof that the terminal's pi finished startup.
      ctx.ui.notify(`已提交新终端启动请求（${mode === "fork" ? "独立副本" : "原会话"}）`, "info");
    } catch (error) {
      ctx.ui.notify(`无法启动新终端：${error instanceof Error ? error.message : String(error)}`, "error");
    }
    restoreEditorFocus(); // we stayed in this session, so typing must work again
  };

  // --- Extension wiring ------------------------------------------------------------
  for (const name of STARTUP_FLAGS) {
    pi.registerFlag(name, {
      description: "启动后立即打开会话选择器（相当于启动时自动执行 /r）",
      type: "boolean",
    });
  }

  pi.on("session_start", async (event, ctx) => {
    // resume-plus bookkeeping: active-session registry + unused-session cleanup.
    try {
      registerActiveSession(ctx.sessionManager.getSessionFile(), ctx.cwd);
    } catch (error) {
      ctx.ui.notify(`活跃登记失败：${String(error)}`, "warning");
    }
    try {
      mergedConfig = readConfig();
      cleanupUnused = mergedConfig.folderNewSession.cleanupUnused;
    } catch {
      // keep the previous value when the config is unreadable
    }
    if (cleanupUnused) {
      try {
        cleanupTrackedUnusedSessions(ctx.sessionManager.getSessionFile());
      } catch {
        // cleanup must never break session startup
      }
    }

    currentCtx = ctx;
    currentCwd = ctx.cwd;
    currentSessionFile = ctx.sessionManager.getSessionFile();
    focused = false;
    searchQuery = null;

    if (loaded.error) {
      ctx.ui.notify(loaded.error, "error");
      loaded.error = null;
    }

    if (ctx.hasUI) {
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
      if (takePendingRefocus()) enterFocus();
    }

    await refreshSessions();
    if (focused) selectCurrentSession();

    // --rr: open the picker right after startup, but only for a brand-new
    // session (-c/-r already chose one, keep their priority).
    if (event.reason !== "startup" || ctx.mode !== "tui") return;
    if (!STARTUP_FLAGS.some((name) => pi.getFlag(name) === true)) return;
    if (ctx.sessionManager.getEntries().some((entry) => entry.type === "message")) return;
    // Event contexts cannot switch sessions; dispatch the command so the picker
    // runs with a full command context (same code path as typing /r).
    startupOverlayPending = true;
    pi.sendUserMessage("/r", { expandPromptTemplates: true });
  });

  pi.on("session_shutdown", async (event) => {
    try {
      unregisterActiveSession();
    } catch {
      // Must not block pi shutdown.
    }
    // On quit the session we are sitting in will never be used; reload keeps it.
    if (event.reason === "quit" && cleanupUnused) {
      try {
        cleanupTrackedUnusedSessions();
      } catch {
        // never block shutdown
      }
    }

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
        case "new-in-folder": {
          const folder = decodeURIComponent(rest[0] ?? "");
          if (!folder) {
            setPendingRefocus(false);
            ctx.ui.notify("缺少目标目录", "warning");
            break;
          }
          await newSessionInFolder(ctx, folder);
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

  pi.registerCommand("r", { description: "原生会话选择器＋项目目录树", handler: openPicker });
  pi.registerCommand("resume-tree", { description: "原生会话选择器＋项目目录树", handler: openPicker });

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
