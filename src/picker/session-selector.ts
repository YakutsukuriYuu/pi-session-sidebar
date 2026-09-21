import * as os from "node:os";
import {
	type Component,
	Container,
	type Focusable,
	fuzzyMatch,
	matchesKey,
	Input,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
// Derived from pi 0.85.1 session-selector.ts (MIT); see UPSTREAM.md.
import type { SessionInfo, KeybindingsManager } from "@earendil-works/pi-coding-agent";
type SessionListProgress = (loaded: number, total: number) => void;
import type { PickerTheme } from "./theme.ts";
import { canonicalizePath } from "../shared/paths.ts";
import { deleteSessionFile } from "../shared/session-files.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { createHints } from "./keybinding-hints.ts";
import { filterAndSortSessions, hasSessionName, matchSession, parseSearchQuery, resolveTokenMatcher, type NameFilter, type SearchMode, type SortMode } from "./session-selector-search.ts";

type SessionScope = "current" | "all";

function shortenPath(path: string): string {
	const home = os.homedir();
	if (!path) return path;
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

function formatSessionDate(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

class SessionSelectorHeader implements Component {
	private scope: SessionScope;
	private sortMode: SortMode;
	private nameFilter: NameFilter;
	private requestRender: () => void;
	private loading = false;
	private loadProgress: { loaded: number; total: number } | null = null;
	private showPath = false;
	private confirmingDeletePath: string | null = null;
	private statusMessage: { type: "info" | "error"; message: string } | null = null;
	private statusTimeout: ReturnType<typeof setTimeout> | null = null;
	private showRenameHint = false;

	private grouped = true;
	constructor(scope: SessionScope, sortMode: SortMode, nameFilter: NameFilter, requestRender: () => void,
		private theme: PickerTheme, private keybindings: KeybindingsManager, private showOpenInNewHint: boolean,
		private searchMode: SearchMode = "substring") {
		this.scope = scope;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.requestRender = requestRender;
	}

	setGrouped(grouped: boolean): void { this.grouped = grouped; }

	setScope(scope: SessionScope): void {
		this.scope = scope;
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
	}

	setLoading(loading: boolean): void {
		this.loading = loading;
		// Progress is scoped to the current load; clear whenever the loading state is set
		this.loadProgress = null;
	}

	setProgress(loaded: number, total: number): void {
		this.loadProgress = { loaded, total };
	}

	setShowPath(showPath: boolean): void {
		this.showPath = showPath;
	}

	setShowRenameHint(show: boolean): void {
		this.showRenameHint = show;
	}

	setConfirmingDeletePath(path: string | null): void {
		this.confirmingDeletePath = path;
	}

	private clearStatusTimeout(): void {
		if (!this.statusTimeout) return;
		clearTimeout(this.statusTimeout);
		this.statusTimeout = null;
	}

	setStatusMessage(msg: { type: "info" | "error"; message: string } | null, autoHideMs?: number): void {
		this.clearStatusTimeout();
		this.statusMessage = msg;
		if (!msg || !autoHideMs) return;

		this.statusTimeout = setTimeout(() => {
			this.statusMessage = null;
			this.statusTimeout = null;
			this.requestRender();
		}, autoHideMs);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const theme = this.theme;
		const { keyHint, rawKeyHint } = createHints(theme, this.keybindings);
		const title = this.scope === "current" ? "Resume Session (Current Folder)" : "Resume Session (All)";
		const leftText = theme.bold(title);

		const sortLabel = this.sortMode === "threaded" ? "Threaded" : this.sortMode === "recent" ? "Recent" : "Fuzzy";
		const sortText = theme.fg("muted", "Sort: ") + theme.fg("accent", sortLabel);

		const nameLabel = this.nameFilter === "all" ? "All" : "Named";
		const nameText = theme.fg("muted", "Name: ") + theme.fg("accent", nameLabel);

		let scopeText: string;
		if (this.loading) {
			const progressText = this.loadProgress ? `${this.loadProgress.loaded}/${this.loadProgress.total}` : "...";
			scopeText = `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", `Loading ${progressText}`)}`;
		} else if (this.scope === "current") {
			scopeText = `${theme.fg("accent", "◉ Current Folder")}${theme.fg("muted", " | ○ All")}`;
		} else {
			scopeText = `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", "◉ All")}`;
		}

		const rightText = truncateToWidth(`${scopeText}  ${nameText}  ${sortText}`, width, "");
		const availableLeft = Math.max(0, width - visibleWidth(rightText) - 1);
		const left = truncateToWidth(leftText, availableLeft, "");
		const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(rightText));

		// Build hint lines - changes based on state (all branches truncate to width)
		let hintLine1: string;
		let hintLine2: string;
		if (this.confirmingDeletePath !== null) {
			const confirmHint = `Delete session? ${keyHint("tui.select.confirm", "confirm")} · ${keyHint("tui.select.cancel", "cancel")}`;
			hintLine1 = theme.fg("error", truncateToWidth(confirmHint, width, "…"));
			hintLine2 = "";
		} else if (this.statusMessage) {
			const color = this.statusMessage.type === "error" ? "error" : "accent";
			hintLine1 = theme.fg(color, truncateToWidth(this.statusMessage.message, width, "…"));
			hintLine2 = "";
		} else {
			const pathState = this.showPath ? "(on)" : "(off)";
			const sep = theme.fg("muted", " · ");
			const hint1 =
				keyHint("tui.input.tab", "scope") + sep + theme.fg("muted", this.searchMode === "fuzzy"
					? 'text fuzzy · "text" exact · re:<pattern> regex'
					: 'text substring · "text" fuzzy · re:<pattern> regex');
			const hint2Parts = [
				keyHint("app.session.toggleSort", "sort"),
				keyHint("app.session.toggleNamedFilter", "named"),
				keyHint("app.session.delete", "delete"),
				keyHint("app.session.togglePath", `path ${pathState}`),
			];
			if (this.showRenameHint) {
				hint2Parts.push(keyHint("app.session.rename", "rename"));
			}
			hint2Parts.push(keyHint("tui.select.up", "up"), keyHint("tui.select.down", "down"),
				keyHint("tui.select.pageUp", "page up"), keyHint("tui.select.pageDown", "page down"),
				keyHint("tui.select.confirm", "resume / toggle folder"), keyHint("tui.select.cancel", "cancel"));
			if (this.scope === "all") {
				hint2Parts.push(rawKeyHint("alt+g", this.grouped ? "folders → native" : "native → folders"));
				if (this.grouped) hint2Parts.push(rawKeyHint("left/right", "collapse/expand"), rawKeyHint("shift+left/right", "all folders"), rawKeyHint("shift+up/shift+down", "project"));
			}
			if (this.showOpenInNewHint) hint2Parts.push(rawKeyHint("shift+enter", this.grouped ? "new terminal / folder: new session" : "new terminal"));
			return [`${left}${" ".repeat(spacing)}${rightText}`,
				...wrapTextWithAnsi(hint1 + sep + hint2Parts.join(sep), Math.max(1, width))];
		}

		return [`${left}${" ".repeat(spacing)}${rightText}`, hintLine1, hintLine2];
	}
}

/** A session tree node for hierarchical display */
interface SessionTreeNode {
	session: SessionInfo;
	children: SessionTreeNode[];
	latestActivity: number;
}

/** Flattened node for display with tree structure info */
interface FlatSessionNode {
	session: SessionInfo;
	depth: number;
	isLast: boolean;
	/** For each ancestor level, whether there are more siblings after it */
	ancestorContinues: boolean[];
	kind?: "session" | "folder";
	folderPath?: string;
	/** Ancestor from another cwd; not included in the folder's session count. */
	reference?: boolean;
	/** resume-plus: the folder itself matched the query, so it is expanded to all its sessions. */
	folderMatch?: FolderMatch;
}

/** How a folder matched the query. Lower tier sorts first. */
type FolderMatch = "exact" | "prefix" | "name" | "path";
const FOLDER_MATCH_TIER: Record<FolderMatch, number> = { exact: 0, prefix: 1, name: 2, path: 3 };

function normalizeForMatch(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Folder label shown in the tree: last path segment, e.g. "pi-hub". */
function folderLabel(folder: string): string {
	return folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
}

function latestModified(sessions: SessionInfo[]): number {
	return sessions.reduce((value, session) => Math.max(value, session.modified.getTime()), 0);
}

/** Natural order of a single folder's sessions (thread tree, else most recent first). */
function orderFolderSessions(sessions: SessionInfo[], sortMode: SortMode): SessionInfo[] {
	return sortMode === "threaded"
		? flattenSessionTree(buildSessionTree(sessions)).map((node) => node.session)
		: [...sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/**
 * resume-plus enhancement: make the folder (project) name and path first-class
 * search targets, so searching a project name surfaces that project's sessions
 * instead of being drowned out by incidental matches in message text.
 *
 * Name matching stays fuzzy (names are short). Path matching is literal only:
 * a fuzzy subsequence test against an absolute path matches almost everything
 * ("ssh" matches "/Users/.../Harness/..." via User*s*, yakutu*s*ukuriyuu, *H*arness),
 * which collapsed every folder into the same tier and fell back to recency.
 */
function matchFolder(folder: string, query: string, mode: SearchMode): FolderMatch | undefined {
	if (!query.trim()) return undefined;
	const parsed = parseSearchQuery(query);
	if (parsed.error) return undefined;
	const name = folderLabel(folder);
	const matchesName = (text: string): boolean => {
		if (parsed.mode === "regex") return parsed.regex ? parsed.regex.test(text) : false;
		if (parsed.tokens.length === 0) return false;
		let normalized: string | null = null;
		for (const token of parsed.tokens) {
			if (resolveTokenMatcher(token.kind, mode) === "substring") {
				normalized ??= normalizeForMatch(text);
				const needle = normalizeForMatch(token.value);
				if (needle && !normalized.includes(needle)) return false;
				continue;
			}
			if (!fuzzyMatch(token.value, text).matches) return false;
		}
		return true;
	};
	const matchesPath = (text: string): boolean => {
		if (parsed.mode === "regex") return parsed.regex ? parsed.regex.test(text) : false;
		if (parsed.tokens.length === 0) return false;
		const lower = text.toLowerCase();
		return parsed.tokens.every((token) => {
			const needle = normalizeForMatch(token.value);
			return needle.length > 0 && lower.includes(needle);
		});
	};
	const single = parsed.mode === "tokens" && parsed.tokens.length === 1 && parsed.tokens[0]!.kind === "fuzzy"
		? normalizeForMatch(parsed.tokens[0]!.value)
		: undefined;
	if (single) {
		const lowerName = name.toLowerCase();
		if (lowerName === single) return "exact";
		if (lowerName.startsWith(single)) return "prefix";
	}
	if (matchesName(name)) return "name";
	if (matchesPath(folder) || matchesPath(shortenPath(folder))) return "path";
	return undefined;
}

/**
 * Build a tree structure from sessions based on parentSessionPath.
 * Returns root nodes sorted by modified date (descending).
 */
function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
	const byPath = new Map<string, SessionTreeNode>();

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path) ?? session.path;
		byPath.set(sessionPath, { session, children: [], latestActivity: session.modified.getTime() });
	}

	const roots: SessionTreeNode[] = [];

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path) ?? session.path;
		const node = byPath.get(sessionPath)!;
		const parentPath = canonicalizePath(session.parentSessionPath);

		if (parentPath && byPath.has(parentPath)) {
			byPath.get(parentPath)!.children.push(node);
		} else {
			roots.push(node);
		}
	}

	const updateLatestActivity = (node: SessionTreeNode): number => {
		let latestActivity = node.session.modified.getTime();
		for (const child of node.children) {
			latestActivity = Math.max(latestActivity, updateLatestActivity(child));
		}
		node.latestActivity = latestActivity;
		return latestActivity;
	};

	for (const root of roots) {
		updateLatestActivity(root);
	}

	// Sort children and roots by latest activity in each subtree (descending)
	const sortNodes = (nodes: SessionTreeNode[]): void => {
		nodes.sort((a, b) => b.latestActivity - a.latestActivity);
		for (const node of nodes) {
			sortNodes(node.children);
		}
	};
	sortNodes(roots);

	return roots;
}

/**
 * Flatten tree into display list with tree structure metadata.
 */
function flattenSessionTree(roots: SessionTreeNode[]): FlatSessionNode[] {
	const result: FlatSessionNode[] = [];

	const walk = (node: SessionTreeNode, depth: number, ancestorContinues: boolean[], isLast: boolean): void => {
		result.push({ session: node.session, depth, isLast, ancestorContinues });

		for (let i = 0; i < node.children.length; i++) {
			const childIsLast = i === node.children.length - 1;
			// Only show continuation line for non-root ancestors
			const continues = depth > 0 ? !isLast : false;
			walk(node.children[i]!, depth + 1, [...ancestorContinues, continues], childIsLast);
		}
	};

	for (let i = 0; i < roots.length; i++) {
		walk(roots[i]!, 0, [], i === roots.length - 1);
	}

	return result;
}

/**
 * Custom session list component with multi-line items and search
 */
class SessionList implements Component, Focusable {
	public getSelectedSessionPath(): string | undefined {
		const selected = this.filteredSessions[this.selectedIndex];
		return selected?.kind === "folder" ? undefined : selected?.session.path;
	}

	private grouped = true;
	public onToggleGrouping?: (grouped: boolean) => void;
	private allSessions: SessionInfo[] = [];
	private filteredSessions: FlatSessionNode[] = [];
	private selectedIndex: number = 0;
	private collapsedFolders = new Set<string>();
	private searchInput: Input;
	private showCwd = false;
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private keybindings: KeybindingsManager;
	private showPath = false;
	private confirmingDeletePath: string | null = null;
	private currentSessionCanonicalPath?: string;
	private currentFolderCanonical?: string;
	public onSelect?: (sessionPath: string) => void;
	public onOpenInNew?: (sessionPath: string) => void;
	/** Folder-row Shift+Enter: create a new session in that folder (resume-plus). */
	public onNewSessionInFolder?: (folderPath: string) => void;
	public onCancel?: () => void;
	public onExit: () => void = () => {};
	public onToggleScope?: () => void;
	public onToggleSort?: () => void;
	public onToggleNameFilter?: () => void;
	public onTogglePath?: (showPath: boolean) => void;
	public onDeleteConfirmationChange?: (path: string | null) => void;
	public onDeleteSession?: (sessionPath: string) => Promise<void>;
	public onRenameSession?: (sessionPath: string) => void;
	public onError?: (message: string) => void;
	private maxVisible: number = 10; // Max sessions visible (one line each)

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		sessions: SessionInfo[],
		showCwd: boolean,
		sortMode: SortMode,
		nameFilter: NameFilter,
		keybindings: KeybindingsManager,
		private theme: PickerTheme,
		private searchMode: SearchMode = "substring",
		currentSessionFilePath?: string,
		currentCwd?: string,
	) {
		this.allSessions = sessions;
		this.filteredSessions = [];
		this.searchInput = new Input();
		this.showCwd = showCwd;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.keybindings = keybindings;
		this.currentSessionCanonicalPath = canonicalizePath(currentSessionFilePath);
		// Pin the current working directory's folder first (canonical so aliases match).
		this.currentFolderCanonical = currentCwd ? (canonicalizePath(currentCwd) ?? currentCwd) : undefined;
		this.filterSessions("");

		// Handle Enter in search input - select current item
		this.searchInput.onSubmit = () => {
			if (this.filteredSessions[this.selectedIndex]) {
				const selected = this.filteredSessions[this.selectedIndex];
				if (selected.kind === "folder") this.toggleFolder(selected.folderPath!);
				else this.onSelect?.(selected.session.path);
			}
		};
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
		this.filterSessions(this.searchInput.getValue());
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
		this.filterSessions(this.searchInput.getValue());
	}

	setSessions(sessions: SessionInfo[], showCwd: boolean): void {
		this.allSessions = sessions;
		this.showCwd = showCwd;
		this.filterSessions(this.searchInput.getValue());
	}

	private filterSessions(query: string): void {
		const trimmed = query.trim();
		const nameFiltered =
			this.nameFilter === "all" ? this.allSessions : this.allSessions.filter((session) => hasSessionName(session));

		// Sort globally first; never re-sort a folder by mtime (loses relevance
		// and descendant-driven thread activity). Alt+G exposes exact native order.
		if (this.showCwd && this.grouped) {
			const roots = this.sortMode === "threaded" && !trimmed ? buildSessionTree(nameFiltered) : null;
			const filtered = roots ? flattenSessionTree(roots).map((node) => node.session)
				: filterAndSortSessions(nameFiltered, query, this.sortMode, "all", this.searchMode);

			// Folder-name search (resume-plus): a query that matches a folder name or path
			// surfaces that folder first and expands it to ALL of its sessions, instead of
			// only the sessions that happened to match the query themselves.
			const allByFolder = new Map<string, SessionInfo[]>();
			for (const session of nameFiltered) {
				const folder = session.cwd || "(unknown folder)";
				const list = allByFolder.get(folder);
				if (list) list.push(session);
				else allByFolder.set(folder, [session]);
			}
			const folderHits = new Map<string, FolderMatch>();
			const parsedQuery = trimmed ? parseSearchQuery(query) : null;
			if (parsedQuery && !parsedQuery.error) {
				for (const folder of allByFolder.keys()) {
					const hit = matchFolder(folder, query, this.searchMode);
					if (hit) folderHits.set(folder, hit);
				}
			}
			// Best (lowest) match score per folder, used to order folders while searching.
			const folderScores = new Map<string, number>();
			if (parsedQuery && !parsedQuery.error) {
				for (const session of filtered) {
					const result = matchSession(session, parsedQuery, this.searchMode);
					if (!result.matches) continue;
					const folder = session.cwd || "(unknown folder)";
					const current = folderScores.get(folder);
					if (current === undefined || result.score < current) folderScores.set(folder, result.score);
				}
			}
			const bestScore = (folder: string): number => folderScores.get(folder) ?? Number.POSITIVE_INFINITY;

			const groups = new Map<string, SessionInfo[]>();
			if (folderHits.size > 0) {
				const hits = [...folderHits].sort((a, b) =>
					FOLDER_MATCH_TIER[a[1]] - FOLDER_MATCH_TIER[b[1]] ||
					bestScore(a[0]) - bestScore(b[0]) ||
					latestModified(allByFolder.get(b[0])!) - latestModified(allByFolder.get(a[0])!));
				for (const [folder] of hits) groups.set(folder, orderFolderSessions(allByFolder.get(folder)!, this.sortMode));
			}
			for (const session of filtered) {
				const folder = session.cwd || "(unknown folder)";
				if (folderHits.has(folder)) continue; // already expanded by a folder-name match
				const list = groups.get(folder);
				if (list) list.push(session);
				else groups.set(folder, [session]);
			}
			// Folder order while searching: name/path hits by tier, then every folder by
			// the best match score of its sessions (a session whose NAME matches ranks
			// above one matched only through message text or cwd), then most recent.
			const ordered = [...groups.keys()].filter((folder) => folderHits.has(folder));
			const rest = [...groups.keys()].filter((folder) => !folderHits.has(folder));
			if (trimmed) rest.sort((a, b) => bestScore(a) - bestScore(b) || latestModified(groups.get(b)!) - latestModified(groups.get(a)!));
			ordered.push(...rest);
			const rows: FlatSessionNode[] = [];
			if (this.currentFolderCanonical && !trimmed) {
				const canonical = this.currentFolderCanonical;
				const isCurrent = (folder: string) => (canonicalizePath(folder) ?? folder) === canonical;
				// Pin the current cwd folder first, but only for the unfiltered list.
				// While searching, folder order must follow match relevance: the search
				// text includes all message text, so pinning would push weak incidental
				// matches from the current folder above a better match elsewhere.
				ordered.sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)));
			}
			for (const folder of ordered) {
				const sessions = groups.get(folder)!;
				const marker = `resume-plus-folder:${folder}`;
				const latest = latestModified(sessions);
				const folderSession = {
					path: marker,
					id: marker,
					cwd: folder,
					name: folderLabel(folder),
					created: new Date(latest),
					modified: new Date(latest),
					messageCount: sessions.length,
					firstMessage: "",
					allMessagesText: "",
				} as SessionInfo;
				rows.push({ session: folderSession, depth: 0, isLast: true, ancestorContinues: [], kind: "folder", folderPath: folder,
					folderMatch: folderHits.get(folder) });
				// Search reveals matches inside collapsed folders without changing saved state.
				if (this.collapsedFolders.has(folder) && !trimmed) continue;
				// Project the sorted GLOBAL tree. Foreign ancestors are explicit
				// references (not counted), so A→B→A retains every parent edge.
				const project = (nodes: SessionTreeNode[]): SessionTreeNode[] => nodes.flatMap((node) => {
					const children = project(node.children);
					return (node.session.cwd || "(unknown folder)") === folder || children.length ? [{ ...node, children }] : [];
				});
				// A folder-name match is already ordered naturally and shows every session,
				// so it never needs the global-tree projection (which is for threaded view).
				const children: FlatSessionNode[] = roots && !folderHits.has(folder) ? flattenSessionTree(project(roots)) : sessions.map((session, index) => ({
					session, depth: 0, isLast: index === sessions.length - 1, ancestorContinues: [],
				}));
				for (const node of children) rows.push({
					...node, depth: node.depth + 1, kind: "session", folderPath: folder,
					reference: (node.session.cwd || "(unknown folder)") !== folder,
				});
			}
			this.filteredSessions = rows;
		} else if (this.sortMode === "threaded" && !trimmed) {
			const roots = buildSessionTree(nameFiltered);
			this.filteredSessions = flattenSessionTree(roots);
		} else {
			const filtered = filterAndSortSessions(nameFiltered, query, this.sortMode, "all", this.searchMode);
			this.filteredSessions = filtered.map((session) => ({ session, depth: 0, isLast: true, ancestorContinues: [], kind: "session" }));
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredSessions.length - 1));
	}

	private toggleFolder(folder: string): void {
		if (this.collapsedFolders.has(folder)) this.collapsedFolders.delete(folder);
		else this.collapsedFolders.add(folder);
		this.filterSessions(this.searchInput.getValue());
	}

	private jumpFolder(direction: "up" | "down"): void {
		const indices = this.filteredSessions.map((node, index) => node.kind === "folder" ? index : -1).filter((index) => index >= 0);
		const target = direction === "up"
			? [...indices].reverse().find((index) => index < this.selectedIndex)
			: indices.find((index) => index > this.selectedIndex);
		if (target !== undefined) this.selectedIndex = target;
	}

	private setConfirmingDeletePath(path: string | null): void {
		this.confirmingDeletePath = path;
		this.onDeleteConfirmationChange?.(path);
	}

	private startDeleteConfirmationForSelectedSession(): void {
		const selected = this.filteredSessions[this.selectedIndex];
		if (!selected || selected.kind === "folder") return;

		// Prevent deleting current session
		if (this.isCurrentSessionPath(selected.session.path)) {
			this.onError?.("Cannot delete the currently active session");
			return;
		}

		this.setConfirmingDeletePath(selected.session.path);
	}

	private isCurrentSessionPath(path: string): boolean {
		if (!this.currentSessionCanonicalPath) return false;
		return (canonicalizePath(path) ?? path) === this.currentSessionCanonicalPath;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const theme = this.theme;
		const { keyText } = createHints(theme, this.keybindings);
		const lines: string[] = [];

		// Render search input
		lines.push(...this.searchInput.render(width));
		lines.push(""); // Blank line after search

		if (this.filteredSessions.length === 0) {
			let emptyMessage: string;
			if (this.nameFilter === "named") {
				const toggleKey = keyText("app.session.toggleNamedFilter");
				if (this.showCwd) {
					emptyMessage = `  No named sessions found. Press ${toggleKey} to show all.`;
				} else {
					emptyMessage = `  No named sessions in current folder. Press ${toggleKey} to show all, or Tab to view all.`;
				}
			} else if (this.showCwd) {
				// "All" scope - no sessions anywhere that match filter
				emptyMessage = "  No sessions found";
			} else {
				// "Current folder" scope - hint to try "all"
				emptyMessage = "  No sessions in current folder. Press Tab to view all.";
			}
			lines.push(theme.fg("muted", truncateToWidth(emptyMessage, width, "…")));
			return lines;
		}

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredSessions.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredSessions.length);

		// Render visible sessions (one line each with tree structure)
		for (let i = startIndex; i < endIndex; i++) {
			const node = this.filteredSessions[i]!;
			const session = node.session;
			const isFolder = node.kind === "folder";
			const isSelected = i === this.selectedIndex;
			const isConfirmingDelete = session.path === this.confirmingDeletePath;
			const isCurrent = this.isCurrentSessionPath(session.path);

			// Build tree prefix
			const prefix = this.buildTreePrefix(node);

			// Session display text (name or first message)
			const hasName = !!session.name;
			const displayText = isFolder ? `${this.collapsedFolders.has(node.folderPath ?? session.cwd) ? "▸" : "▾"} 📁 ${session.name ?? session.cwd}${node.folderMatch ? (node.folderMatch === "path" ? " · path match" : " · name match") : ""}`
				: `${node.reference ? `↗ [${shortenPath(session.cwd)}] ` : ""}${session.name ?? session.firstMessage}`;
			const normalizedMessage = displayText.replace(/[\x00-\x1f\x7f]/g, " ").trim();

			// Right side: message count and age
			const age = formatSessionDate(session.modified);
			const msgCount = String(session.messageCount);
			let rightPart = isFolder ? `${msgCount} sessions` : `${msgCount} ${age}`;
			if (this.showCwd && session.cwd) {
				rightPart = `${shortenPath(session.cwd)} ${rightPart}`;
			}
			if (this.showPath && !isFolder) {
				rightPart = `${shortenPath(session.path)} ${rightPart}`;
			}

			// Cursor
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";

			// Calculate available width for message
			const prefixWidth = visibleWidth(prefix);
			const rightWidth = visibleWidth(rightPart) + 2; // +2 for spacing
			const availableForMsg = width - 2 - prefixWidth - rightWidth; // -2 for cursor

			const truncatedMsg = truncateToWidth(normalizedMessage, Math.max(10, availableForMsg), "…");

			// Style message
			let messageColor: "error" | "warning" | "accent" | null = null;
			if (isConfirmingDelete) {
				messageColor = "error";
			} else if (isCurrent) {
				messageColor = "accent";
			} else if (hasName) {
				messageColor = "warning";
			}
			let styledMsg = messageColor ? theme.fg(messageColor, truncatedMsg) : truncatedMsg;
			if (isSelected) {
				styledMsg = theme.bold(styledMsg);
			}

			// Build line
			const leftPart = cursor + theme.fg("dim", prefix) + styledMsg;
			const leftWidth = visibleWidth(leftPart);
			const spacing = Math.max(1, width - leftWidth - visibleWidth(rightPart));
			const styledRight = theme.fg(isConfirmingDelete ? "error" : "dim", rightPart);

			let line = leftPart + " ".repeat(spacing) + styledRight;
			if (isSelected) {
				line = theme.bg("selectedBg", line);
			}
			lines.push(truncateToWidth(line, width));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredSessions.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredSessions.length})`;
			const scrollInfo = theme.fg("muted", truncateToWidth(scrollText, width, ""));
			lines.push(scrollInfo);
		}

		return lines;
	}

	private buildTreePrefix(node: FlatSessionNode): string {
		if (node.depth === 0) {
			return "";
		}

		const parts = node.ancestorContinues.map((continues) => (continues ? "│  " : "   "));
		const branch = node.isLast ? "└─ " : "├─ ";
		return parts.join("") + branch;
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		// Reserve before *all* actions, including delete confirmation and remapped confirm.
		if (matchesKey(keyData, "shift+enter")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (this.confirmingDeletePath === null && selected) {
				// Folder rows create a new session in that project; session rows open a terminal.
				if (selected.kind === "folder") this.onNewSessionInFolder?.(selected.folderPath!);
				else this.onOpenInNew?.(selected.session.path);
			}
			return;
		}

		// Handle delete confirmation state first - intercept all keys
		if (this.confirmingDeletePath !== null) {
			if (kb.matches(keyData, "tui.select.confirm")) {
				const pathToDelete = this.confirmingDeletePath;
				this.setConfirmingDeletePath(null);
				void this.onDeleteSession?.(pathToDelete);
				return;
			}
			if (kb.matches(keyData, "tui.select.cancel")) {
				this.setConfirmingDeletePath(null);
				return;
			}
			// Ignore all other keys while confirming
			return;
		}

		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.onToggleScope) {
				this.onToggleScope();
			}
			return;
		}

		if (kb.matches(keyData, "app.session.toggleSort")) {
			this.onToggleSort?.();
			return;
		}

		if (this.keybindings.matches(keyData, "app.session.toggleNamedFilter")) {
			this.onToggleNameFilter?.();
			return;
		}

		// Ctrl+P: toggle path display
		if (kb.matches(keyData, "app.session.togglePath")) {
			this.showPath = !this.showPath;
			this.onTogglePath?.(this.showPath);
			return;
		}

		// Ctrl+D: initiate delete confirmation (useful on terminals that don't distinguish Ctrl+Backspace from Backspace)
		if (kb.matches(keyData, "app.session.delete")) {
			this.startDeleteConfirmationForSelectedSession();
			return;
		}

		// Rename selected session
		if (kb.matches(keyData, "app.session.rename")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected && selected.kind !== "folder") {
				this.onRenameSession?.(selected.session.path);
			}
			return;
		}

		// Ctrl+Backspace: non-invasive convenience alias for delete
		// Only triggers deletion when the query is empty; otherwise it is forwarded to the input
		if (kb.matches(keyData, "app.session.deleteNoninvasive")) {
			if (this.searchInput.getValue().length > 0) {
				this.searchInput.handleInput(keyData);
				this.filterSessions(this.searchInput.getValue());
				return;
			}

			this.startDeleteConfirmationForSelectedSession();
			return;
		}

		const selected = this.filteredSessions[this.selectedIndex];
		if (this.showCwd && matchesKey(keyData, "alt+g")) {
			this.grouped = !this.grouped;
			this.filterSessions(this.searchInput.getValue());
			this.onToggleGrouping?.(this.grouped);
		}
		else if (this.showCwd && this.grouped && matchesKey(keyData, "shift+right")) {
			// Expand every folder at once.
			this.collapsedFolders.clear();
			this.filterSessions(this.searchInput.getValue());
		}
		else if (this.showCwd && this.grouped && matchesKey(keyData, "shift+left")) {
			// Collapse every folder at once (over all known sessions, so the state
			// survives scope switches and cleared searches).
			for (const session of this.allSessions) this.collapsedFolders.add(session.cwd || "(unknown folder)");
			this.filterSessions(this.searchInput.getValue());
		}
		else if (this.showCwd && this.grouped && matchesKey(keyData, "shift+up")) {
			this.jumpFolder("up");
		}
		// Shift+Down jumps between project roots.
		else if (this.showCwd && this.grouped && matchesKey(keyData, "shift+down")) {
			this.jumpFolder("down");
		}
		// Left/right collapse and expand folder roots.
		else if (selected?.kind === "folder" && !this.searchInput.getValue() && (matchesKey(keyData, "left") || matchesKey(keyData, "right"))) {
			const folder = selected.folderPath!;
			if (matchesKey(keyData, "left")) this.collapsedFolders.add(folder);
			else this.collapsedFolders.delete(folder);
			this.filterSessions(this.searchInput.getValue());
		}
		// Up arrow
		else if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		}
		// Down arrow
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = Math.max(0, Math.min(this.filteredSessions.length - 1, this.selectedIndex + 1));
		}
		// Page up - jump up by maxVisible items
		else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
		}
		// Page down - jump down by maxVisible items
		else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.max(0, Math.min(this.filteredSessions.length - 1, this.selectedIndex + this.maxVisible));
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected?.kind === "folder") {
				this.toggleFolder(selected.folderPath ?? selected.session.cwd);
			} else if (selected && this.onSelect) {
				this.onSelect(selected.session.path);
			}
		}
		// Escape - cancel
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterSessions(this.searchInput.getValue());
		}
	}
}

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

/**
 * Component that renders a session selector
 */
export class SessionSelectorComponent extends Container implements Focusable {
	handleInput(data: string): void {
		if (this.mode === "rename") {
			if (matchesKey(data, "shift+enter")) return;
			const kb = this.keybindings;
			if (kb.matches(data, "tui.select.cancel")) {
				this.exitRenameMode();
				return;
			}
			this.renameInput.handleInput(data);
			return;
		}

		this.sessionList.handleInput(data);
		this.requestRender();
	}

	private theme: PickerTheme;
	private disposed = false;
	private canRename = true;
	private sessionList: SessionList;
	private header: SessionSelectorHeader;
	private keybindings: KeybindingsManager;
	private scope: SessionScope = "all"; // resume-plus: default to the All panel
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private currentSessions: SessionInfo[] | null = null;
	private allSessions: SessionInfo[] | null = null;
	private currentSessionsLoader: SessionsLoader;
	private allSessionsLoader: SessionsLoader;
	private requestRender: () => void;
	private renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
	private currentLoading = false;
	private allLoading = false;
	private allLoadSeq = 0;

	private mode: "list" | "rename" = "list";
	private renameInput = new Input();
	private renameTargetPath: string | null = null;

	// Focusable implementation - propagate to sessionList for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.sessionList.focused = value;
		this.renameInput.focused = value;
		if (value && this.mode === "rename") {
			this.renameInput.focused = true;
		}
	}

	private buildBaseLayout(content: Component, options?: { showHeader?: boolean }): void {
		const theme = this.theme;
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));
		if (options?.showHeader ?? true) {
			this.addChild(this.header);
			this.addChild(new Spacer(1));
		}
		this.addChild(content);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
	}

	constructor(
		currentSessionsLoader: SessionsLoader,
		allSessionsLoader: SessionsLoader,
		onSelect: (sessionPath: string) => void,
		onCancel: () => void,
		onExit: () => void,
		requestRender: () => void,
		options: {
			theme: PickerTheme;
			onOpenInNew?: (sessionPath: string) => void;
			renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
			showRenameHint?: boolean;
			keybindings: KeybindingsManager;
			/** Current working directory; its folder is pinned first in the grouped view. */
			currentCwd?: string;
			/** Bare-word matcher: "substring" (default) or "fuzzy". */
			searchMode?: SearchMode;
			/** Set to enable folder-row Shift+Enter (new session in that folder). */
			newSessionInFolder?: (folderPath: string) => void;
		},
		currentSessionFilePath?: string,
	) {
		super();
		this.keybindings = options.keybindings;
		this.theme = options.theme;
		this.currentSessionsLoader = currentSessionsLoader;
		this.allSessionsLoader = allSessionsLoader;
		this.requestRender = requestRender;
		this.header = new SessionSelectorHeader(this.scope, this.sortMode, this.nameFilter, this.requestRender,
			this.theme, this.keybindings, !!options.onOpenInNew, options.searchMode ?? "substring");
		const renameSession = options?.renameSession;
		this.renameSession = renameSession;
		this.canRename = !!renameSession;
		this.header.setShowRenameHint(options?.showRenameHint ?? this.canRename);

		// Create session list (starts empty, will be populated after load)
		this.sessionList = new SessionList(
			[],
			this.scope === "all",
			this.sortMode,
			this.nameFilter,
			this.keybindings,
			this.theme,
			options.searchMode ?? "substring",
			currentSessionFilePath,
			options.currentCwd,
		);

		this.buildBaseLayout(this.sessionList);

		this.renameInput.onSubmit = (value) => {
			void this.confirmRename(value);
		};

		// Ensure header status timeouts are cleared when leaving the selector
		const clearStatusMessage = () => this.header.setStatusMessage(null);
		this.sessionList.onSelect = (sessionPath) => {
			clearStatusMessage();
			onSelect(sessionPath);
		};
		if (options.onOpenInNew) this.sessionList.onOpenInNew = (sessionPath) => {
			clearStatusMessage();
			options.onOpenInNew?.(sessionPath);
		};
		if (options.newSessionInFolder) this.sessionList.onNewSessionInFolder = (folderPath) => {
			clearStatusMessage();
			options.newSessionInFolder?.(folderPath);
		};
		this.sessionList.onToggleGrouping = (grouped) => this.header.setGrouped(grouped);
		this.sessionList.onCancel = () => {
			clearStatusMessage();
			onCancel();
		};
		this.sessionList.onExit = () => {
			clearStatusMessage();
			onExit();
		};
		this.sessionList.onToggleScope = () => this.toggleScope();
		this.sessionList.onToggleSort = () => this.toggleSortMode();
		this.sessionList.onToggleNameFilter = () => this.toggleNameFilter();
		this.sessionList.onRenameSession = (sessionPath) => {
			if (!renameSession) return;
			if (this.scope === "current" && this.currentLoading) return;
			if (this.scope === "all" && this.allLoading) return;

			const sessions = this.scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
			const session = sessions.find((s) => s.path === sessionPath);
			this.enterRenameMode(sessionPath, session?.name);
		};

		// Sync list events to header
		this.sessionList.onTogglePath = (showPath) => {
			this.header.setShowPath(showPath);
			this.requestRender();
		};
		this.sessionList.onDeleteConfirmationChange = (path) => {
			this.header.setConfirmingDeletePath(path);
			this.requestRender();
		};
		this.sessionList.onError = (msg) => {
			this.header.setStatusMessage({ type: "error", message: msg }, 3000);
			this.requestRender();
		};

		// Handle session deletion
		this.sessionList.onDeleteSession = async (sessionPath: string) => {
			const result = deleteSessionFile(sessionPath);

			if (result.ok) {
				if (this.currentSessions) {
					this.currentSessions = this.currentSessions.filter((s) => s.path !== sessionPath);
				}
				if (this.allSessions) {
					this.allSessions = this.allSessions.filter((s) => s.path !== sessionPath);
				}

				const sessions = this.scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
				const showCwd = this.scope === "all";
				this.sessionList.setSessions(sessions, showCwd);

				const msg = result.method === "trash" ? "Session moved to trash" : "Session deleted";
				this.header.setStatusMessage({ type: "info", message: msg }, 2000);
				await this.refreshSessionsAfterMutation();
			} else {
				const errorMessage = result.error ?? "Unknown error";
				this.header.setStatusMessage({ type: "error", message: `Failed to delete: ${errorMessage}` }, 3000);
			}

			this.requestRender();
		};

		// Default scope is All; current-folder sessions lazy-load on first Tab.
		void this.loadScope(this.scope, "initial");
	}

	private enterRenameMode(sessionPath: string, currentName: string | undefined): void {
		const theme = this.theme;
		const { keyText } = createHints(theme, this.keybindings);
		this.mode = "rename";
		this.renameTargetPath = sessionPath;
		this.renameInput.setValue(currentName ?? "");
		this.renameInput.focused = true;

		const panel = new Container();
		panel.addChild(new Text(theme.bold("Rename Session"), 1, 0));
		panel.addChild(new Spacer(1));
		panel.addChild(this.renameInput);
		panel.addChild(new Spacer(1));
		panel.addChild(
			new Text(
				theme.fg("muted", `${keyText("tui.select.confirm")} to save · ${keyText("tui.select.cancel")} to cancel`),
				1,
				0,
			),
		);

		this.buildBaseLayout(panel, { showHeader: false });
		this.requestRender();
	}

	private exitRenameMode(): void {
		this.mode = "list";
		this.renameTargetPath = null;

		this.buildBaseLayout(this.sessionList);

		this.requestRender();
	}

	private async confirmRename(value: string): Promise<void> {
		const next = value.trim();
		if (!next) return;
		const target = this.renameTargetPath;
		if (!target) {
			this.exitRenameMode();
			return;
		}

		// Find current name for callback
		const renameSession = this.renameSession;
		if (!renameSession) {
			this.exitRenameMode();
			return;
		}

		try {
			await renameSession(target, next);
			await this.refreshSessionsAfterMutation();
		} catch (error) {
			this.header.setStatusMessage({ type: "error", message: `Failed to rename: ${error instanceof Error ? error.message : String(error)}` }, 4000);
		} finally {
			this.exitRenameMode();
		}
	}

	private async loadScope(scope: SessionScope, reason: "initial" | "refresh" | "toggle"): Promise<void> {
		const showCwd = scope === "all";

		// Mark loading
		if (scope === "current") {
			this.currentLoading = true;
		} else {
			this.allLoading = true;
		}

		const seq = scope === "all" ? ++this.allLoadSeq : undefined;
		this.header.setScope(scope);
		this.header.setLoading(true);
		this.requestRender();

		const onProgress = (loaded: number, total: number) => {
			if (this.disposed || scope !== this.scope) return;
			if (seq !== undefined && seq !== this.allLoadSeq) return;
			this.header.setProgress(loaded, total);
			this.requestRender();
		};

		try {
			const sessions = await (scope === "current"
				? this.currentSessionsLoader(onProgress)
				: this.allSessionsLoader(onProgress));

			if (this.disposed || (seq !== undefined && seq !== this.allLoadSeq)) return;
			if (scope === "current") {
				this.currentSessions = sessions;
				this.currentLoading = false;
			} else {
				this.allSessions = sessions;
				this.allLoading = false;
			}

			if (scope !== this.scope) return;
			if (seq !== undefined && seq !== this.allLoadSeq) return;

			this.header.setLoading(false);
			this.sessionList.setSessions(sessions, showCwd);
			this.requestRender();
		} catch (err) {
			if (this.disposed || (seq !== undefined && seq !== this.allLoadSeq)) return;
			if (scope === "current") {
				this.currentLoading = false;
			} else {
				this.allLoading = false;
			}

			if (scope !== this.scope) return;
			if (seq !== undefined && seq !== this.allLoadSeq) return;

			const message = err instanceof Error ? err.message : String(err);
			this.header.setLoading(false);
			this.header.setStatusMessage({ type: "error", message: `Failed to load sessions: ${message}` }, 4000);

			if (reason === "initial") {
				this.sessionList.setSessions([], showCwd);
			}
			this.requestRender();
		}
	}

	private toggleSortMode(): void {
		// Cycle: threaded -> recent -> relevance -> threaded
		this.sortMode = this.sortMode === "threaded" ? "recent" : this.sortMode === "recent" ? "relevance" : "threaded";
		this.header.setSortMode(this.sortMode);
		this.sessionList.setSortMode(this.sortMode);
		this.requestRender();
	}

	private toggleNameFilter(): void {
		this.nameFilter = this.nameFilter === "all" ? "named" : "all";
		this.header.setNameFilter(this.nameFilter);
		this.sessionList.setNameFilter(this.nameFilter);
		this.requestRender();
	}

	private async refreshSessionsAfterMutation(): Promise<void> {
		if (this.disposed) return;
		if (this.scope === "current") this.allSessions = null;
		else this.currentSessions = null;
		await this.loadScope(this.scope, "refresh");
	}

	private toggleScope(): void {
		if (this.scope === "current") {
			this.scope = "all";
			this.header.setScope(this.scope);

			if (this.allSessions !== null) {
				this.header.setLoading(false);
				this.sessionList.setSessions(this.allSessions, true);
				this.requestRender();
				return;
			}

			if (!this.allLoading) {
				void this.loadScope("all", "toggle");
			}
			return;
		}

		this.scope = "current";
		this.header.setScope(this.scope);
		this.header.setLoading(this.currentLoading);
		this.sessionList.setSessions(this.currentSessions ?? [], false);
		if (this.currentSessions === null && !this.currentLoading) void this.loadScope("current", "toggle");
		this.requestRender();
	}

	dispose(): void {
		this.disposed = true;
		this.header.setStatusMessage(null);
	}

	getSessionList(): SessionList {
		return this.sessionList;
	}
}
