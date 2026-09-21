import { decodeKittyPrintable, matchesKey } from "@earendil-works/pi-tui";
import type { KeyId } from "@earendil-works/pi-tui";

/**
 * Semantic action decoded from a raw terminal key sequence while the sidebar
 * holds focus.
 */
export type SidebarAction =
  | { type: "exit" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  /** Switch to the selected session; keepFocus decides where focus lands after. */
  | { type: "switch"; keepFocus: boolean }
  | { type: "new" }
  | { type: "rename" }
  | { type: "backspace" }
  | { type: "clearSearch" }
  | { type: "type"; text: string }
  /** Nothing bound: still consumed (true focus isolation). */
  | { type: "ignore" };

/**
 * Decode one raw terminal input chunk into a sidebar action.
 *
 * The sidebar is a real focus owner: while it is focused every key belongs to
 * it, so an `ignore` result still means "consume".
 */
export function decodeSidebarKey(data: string, focusKey: string): SidebarAction {
  if (!data) return { type: "ignore" };

  // Leave focus: the focus shortcut itself (so it toggles) or Escape.
  if (matchesKey(data, "escape")) return { type: "exit" };
  if (isFocusKey(data, focusKey)) return { type: "exit" };

  if (matchesKey(data, "up")) return { type: "up" };
  if (matchesKey(data, "down")) return { type: "down" };
  if (matchesKey(data, "left")) return { type: "left" };
  if (matchesKey(data, "right")) return { type: "right" };

  // Shift+Enter must be checked before plain Enter.
  if (matchesKey(data, "shift+enter") || matchesKey(data, "shift+return")) {
    return { type: "switch", keepFocus: true };
  }
  if (matchesKey(data, "enter") || matchesKey(data, "return")) {
    return { type: "switch", keepFocus: false };
  }

  if (matchesKey(data, "ctrl+n")) return { type: "new" };
  if (matchesKey(data, "ctrl+r")) return { type: "rename" };
  if (matchesKey(data, "ctrl+u")) return { type: "clearSearch" };
  if (matchesKey(data, "backspace")) return { type: "backspace" };
  if (matchesKey(data, "tab")) return { type: "right" };
  if (matchesKey(data, "shift+tab")) return { type: "left" };

  const printable = printableText(data);
  if (printable) return { type: "type", text: printable };

  return { type: "ignore" };
}

/**
 * Extract printable text from an input chunk.
 *
 * Handles Kitty protocol CSI-u printable sequences as well as plain text
 * chunks; anything containing control characters (including ESC-led
 * sequences) is rejected so unknown keys stay unbound.
 */
function printableText(data: string): string | null {
  if (!data) return null;
  const kitty = decodeKittyPrintable(data);
  if (kitty) return kitty;
  for (const ch of data) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return null;
  }
  return data;
}

/** True when `data` matches the configured focus shortcut (guarded cast). */
function isFocusKey(data: string, focusKey: string): boolean {
  try {
    return matchesKey(data, focusKey as KeyId);
  } catch {
    return false;
  }
}
