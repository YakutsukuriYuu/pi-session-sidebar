import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SidebarRenderState } from "./model.ts";
import { renderSidebar } from "./render.ts";

// No background by default so terminal transparency shows through.
// Set PI_SESSION_SIDEBAR_BG="#rrggbb" to paint an opaque panel.
const SIDEBAR_BG = (() => {
  const raw = process.env["PI_SESSION_SIDEBAR_BG"];
  const hex = raw ? raw.replace("#", "") : "";
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return "";
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
})();
const BG_RESET = "\x1b[49m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const FG_CYAN = "\x1b[96m";

function moveCursor(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

type AnyObject = Record<string | number | symbol, unknown>;

function descriptorFor(obj: AnyObject, key: string): PropertyDescriptor | undefined {
  let target: AnyObject | null = obj;
  while (target) {
    const d = Object.getOwnPropertyDescriptor(target, key);
    if (d) return d;
    const proto = Object.getPrototypeOf(target);
    target = (proto ?? null) as AnyObject | null;
  }
  return undefined;
}

/**
 * Compositor that reserves the left `width` columns of the terminal for the
 * session sidebar.
 *
 * Strategy (left variant of the pi-sidebar-tui technique):
 *  1. Narrow `terminal.columns` so pi renders its content at a reduced width.
 *  2. Wrap `tui.doRender`: while pi writes its frame, rewrite the emitted
 *     escape sequences so pi's content is shifted right by `width` columns:
 *       - `\r` / `\r\n`          → append `ESC[width C` (cursor right)
 *       - `ESC[2K`               → `ESC[0K` (erase only to end of line)
 *       - `ESC[<c>G`             → `ESC[<c+width>G` (absolute column)
 *       - `ESC[<r>;<c>H`         → `ESC[<r>;<c+width>H`
 *       - `ESC[H`                → `ESC[1;<width+1>H`
 *       - pi's own sync markers  → stripped (we emit our own frame markers)
 *       - `ESC[2J` (full clear)  → kept; forces a full sidebar repaint
 *  3. After pi's frame, paint the sidebar into columns 1..width with absolute
 *     cursor positioning, saving/restoring the cursor (DECSC/DECRC) and only
 *     rewriting rows that changed.
 */
export class SessionSidebarCompositor {
  private tui: any;
  private terminal: any;
  private getState: () => SidebarRenderState;
  private originalColumnsDesc: PropertyDescriptor | undefined;
  private originalColumnsOwnDesc: PropertyDescriptor | undefined;
  private originalDoRender: ((...args: any[]) => any) | null = null;
  private originalWrite: (data: string) => void;
  private disposed = false;

  /** Total reserved columns, including the 1-column separator. */
  readonly reservedWidth: number;
  /** Minimum raw terminal width; below this the sidebar auto-collapses. */
  private readonly minRawColumns: number;

  private cachedLines: string[] | null = null;
  private cachedRows = 0;
  private cachedFocused = false;
  private cacheValid = false;
  /** Called when the sidebar auto-hides because the terminal got too narrow. */
  onAutoHide: (() => void) | null = null;
  private autoHideNotified = false;

  constructor(
    tui: any,
    getState: () => SidebarRenderState,
    width: number,
    minRawColumns = 100,
  ) {
    this.tui = tui;
    this.terminal = tui.terminal;
    this.getState = getState;
    this.reservedWidth = width;
    this.minRawColumns = minRawColumns;
    this.originalWrite = this.terminal.write.bind(this.terminal);
  }

  install(): void {
    this.originalColumnsDesc = descriptorFor(this.terminal, "columns");
    this.originalColumnsOwnDesc = Object.getOwnPropertyDescriptor(this.terminal, "columns");
    const origDesc = this.originalColumnsDesc;
    const terminal = this.terminal;
    const self = this;

    Object.defineProperty(terminal, "columns", {
      configurable: true,
      enumerable: true,
      get() {
        const d = origDesc;
        const raw = d?.get
          ? (d.get.call(terminal) ?? 80)
          : (typeof d?.value === "number" ? d.value : 80);
        if (raw < self.minRawColumns) return raw; // auto-collapse
        return Math.max(1, raw - self.reservedWidth);
      },
    });

    if (typeof this.tui.doRender === "function") {
      const originalDoRender = this.tui.doRender;
      this.originalDoRender = originalDoRender;
      this.tui.doRender = function (...args: any[]) {
        if (self.disposed) return originalDoRender.apply(this, args);

        const writeOwnDesc = Object.getOwnPropertyDescriptor(terminal, "write");
        const originalWrite = terminal.write;
        let forceFullPaint = false;
        let result: any;
        let didThrow = false;
        let thrown: unknown;

        // When the terminal is too narrow the sidebar is inactive: render pi
        // completely untouched (pi full-redraws on the width change itself).
        if (!self.active()) {
          self.cacheValid = false;
          try {
            return originalDoRender.apply(this, args);
          } finally {
            self.notifyAutoHide();
          }
        }
        self.autoHideNotified = false;

        self.originalWrite("\x1b[?2026h"); // begin synchronized output
        try {
          Object.defineProperty(terminal, "write", {
            configurable: true,
            enumerable: true,
            writable: true,
            value(this: any, data: string) {
              if (typeof data !== "string") return originalWrite.call(this, data);
              if (data.includes("\x1b[2J")) forceFullPaint = true;
              return originalWrite.call(this, self.shiftRight(data));
            },
          });

          try {
            result = originalDoRender.apply(this, args);
          } catch (error) {
            didThrow = true;
            thrown = error;
          }

          if (!didThrow) {
            try {
              self.paintInternal(forceFullPaint, false);
            } catch {
              // Sidebar painting must never break pi's render cycle.
            }
          }
        } finally {
          if (writeOwnDesc) {
            Object.defineProperty(terminal, "write", writeOwnDesc);
          } else {
            Reflect.deleteProperty(terminal, "write");
          }
          self.originalWrite("\x1b[?2026l"); // end synchronized output
        }

        if (didThrow) throw thrown;
        return result;
      };
    }
  }

  /** Standalone repaint (state change outside a pi render cycle). */
  paint(): void {
    this.paintInternal(false, true);
  }

  /** True when the terminal is wide enough for the sidebar. */
  isActive(): boolean {
    return this.active();
  }

  private active(): boolean {
    return this.rawColumns() >= this.minRawColumns;
  }

  private notifyAutoHide(): void {
    if (this.autoHideNotified) return;
    this.autoHideNotified = true;
    this.onAutoHide?.();
  }

  private rawColumns(): number {
    const d = this.originalColumnsDesc;
    const raw = d?.get
      ? d.get.call(this.terminal)
      : (typeof d?.value === "number" ? d.value : undefined);
    return typeof raw === "number" && Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 80;
  }

  /** Shift pi's frame right by reservedWidth columns. */
  private shiftRight(data: string): string {
    const w = this.reservedWidth;
    const shift = `\x1b[${w}C`;
    const hideCursor = this.getState().focused;
    return data.replace(
      /(\x1b\[\?2026[hl])|(\x1b\[2J)|(\x1b\[(\d+);(\d+)H)|(\x1b\[H)|(\x1b\[(\d+)G)|(\x1b\[2K)|(\r\n)|(\r(?!\n))|(\x1b\[\?25[hl])/g,
      (match, sync, clear, cup, row, col, home, cha, chaCol, el, crlf, cr, cursor) => {
        if (sync !== undefined) return ""; // strip pi's sync markers
        if (clear !== undefined) return match; // keep full clear (we repaint after)
        if (cup !== undefined) return `\x1b[${row};${Number(col) + w}H`;
        if (home !== undefined) return `\x1b[1;${w + 1}H`;
        if (cha !== undefined) return `\x1b[${Number(chaCol) + w}G`;
        if (el !== undefined) return "\x1b[0K"; // erase only to end of line
        if (crlf !== undefined) return match + shift;
        if (cr !== undefined) return match + shift;
        // While the sidebar owns the keyboard, pi's main pane is unfocused, so
        // its text cursor must not be shown.
        if (cursor !== undefined) return hideCursor ? "\x1b[?25l" : match;
        return match;
      },
    );
  }

  private formatLine(line: string | undefined, width: number): string {
    const content = line === undefined ? "" : truncateToWidth(line, width, "", true);
    const padding = Math.max(0, width - visibleWidth(content));
    return `${SIDEBAR_BG}${content}${" ".repeat(padding)}${BG_RESET}`;
  }

  private paintInternal(forceFull: boolean, standalone: boolean): void {
    if (this.disposed) return;
    if (!this.active()) {
      this.cacheValid = false;
      this.notifyAutoHide();
      return;
    }
    this.autoHideNotified = false;

    const rawRows = Math.max(1, this.terminal.rows ?? 24);
    const w = this.reservedWidth;
    const contentWidth = w - 1; // last reserved column is the separator

    const state = this.getState();
    const { lines } = renderSidebar(state, contentWidth, rawRows);
    // Separator doubles as a focus indicator: accent color while focused.
    const separator = state.focused ? `${FG_CYAN}│${RESET}` : `${DIM}│${RESET}`;

    const formatted: string[] = [];
    for (let row = 1; row <= rawRows; row++) {
      formatted.push(this.formatLine(lines[row - 1], contentWidth));
    }

    const dimensionsChanged =
      this.cachedRows !== rawRows ||
      this.cachedLines === null ||
      this.cachedFocused !== state.focused;
    const shouldPaintAll = forceFull || !this.cacheValid || dimensionsChanged;
    const rows = shouldPaintAll
      ? formatted.map((_, index) => index)
      : formatted.reduce<number[]>((changed, line, index) => {
          if (this.cachedLines?.[index] !== line) changed.push(index);
          return changed;
        }, []);

    if (rows.length === 0) return;

    let buf = standalone ? "\x1b[?2026h" : "";
    buf += "\x1b7";    // save cursor (DECSC)
    buf += "\x1b[?7l"; // disable auto-wrap

    for (const index of rows) {
      const row = index + 1;
      buf += moveCursor(row, 1);
      buf += formatted[index];
      buf += moveCursor(row, w);
      buf += separator;
    }

    buf += "\x1b[?7h"; // enable auto-wrap
    buf += "\x1b8";    // restore cursor (DECRC)
    if (standalone) buf += "\x1b[?2026l";

    try {
      this.originalWrite(buf);
    } catch {
      this.cacheValid = false;
      return;
    }

    this.cachedLines = formatted;
    this.cachedRows = rawRows;
    this.cachedFocused = state.focused;
    this.cacheValid = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.originalColumnsOwnDesc) {
      Object.defineProperty(this.terminal, "columns", this.originalColumnsOwnDesc);
    } else {
      Reflect.deleteProperty(this.terminal, "columns");
    }

    if (this.originalDoRender !== null) {
      this.tui.doRender = this.originalDoRender;
    }
  }
}
