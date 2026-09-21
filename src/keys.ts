import { decodeKittyPrintable, isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
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
  /** Ctrl+Shift+= / Ctrl+Shift+-: sidebar width, one column per press. */
  | { type: "wider" }
  | { type: "narrower" }
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

  // Kitty protocol reports press, repeat and release. A release must never
  // re-trigger an action: without this, pressing the focus key would focus on
  // press and immediately unfocus again on the key-up event.
  if (isKeyRelease(data)) return { type: "ignore" };

  // Auto-repeat is fine for navigation and typing, but commit-like actions
  // must not fire over and over while a key is held down.
  const repeat = isKeyRepeat(data);

  // Leave focus: the focus shortcut itself (so it toggles) or Escape.
  if (!repeat && matchesKey(data, "escape")) return { type: "exit" };
  if (!repeat && isFocusKey(data, focusKey)) return { type: "exit" };

  if (matchesKey(data, "up")) return { type: "up" };
  if (matchesKey(data, "down")) return { type: "down" };
  if (matchesKey(data, "left")) return { type: "left" };
  if (matchesKey(data, "right")) return { type: "right" };

  // Shift+Enter must be checked before plain Enter.
  if (!repeat && (matchesKey(data, "shift+enter") || matchesKey(data, "shift+return"))) {
    return { type: "switch", keepFocus: true };
  }
  if (!repeat && (matchesKey(data, "enter") || matchesKey(data, "return"))) {
    return { type: "switch", keepFocus: false };
  }

  if (!repeat && matchesKey(data, "ctrl+n")) return { type: "new" };
  if (!repeat && matchesKey(data, "ctrl+r")) return { type: "rename" };
  if (!repeat && isWiderKey(data)) return { type: "wider" };
  if (!repeat && isNarrowerKey(data)) return { type: "narrower" };
  if (!repeat && matchesKey(data, "ctrl+u")) return { type: "clearSearch" };
  if (matchesKey(data, "backspace")) return { type: "backspace" };
  if (!repeat && matchesKey(data, "tab")) return { type: "right" };
  if (!repeat && matchesKey(data, "shift+tab")) return { type: "left" };

  const printable = printableText(data);
  if (printable) return { type: "type", text: printable };

  return { type: "ignore" };
}

/**
 * Events that must be swallowed no matter where focus is.
 *
 * Key releases carry no input content, but pi's editor does not filter them, so
 * a release would otherwise be matched again by the shortcut dispatcher — one
 * keypress would toggle focus twice. The same applies to auto-repeat of the
 * focus shortcut while it is held down.
 */
export function isInertKeyEvent(data: string, focusKey: string): boolean {
  if (!data) return true;
  if (isKeyRelease(data)) return true;
  if (isKeyRepeat(data) && isFocusKey(data, focusKey)) return true;
  return false;
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

/**
 * Raw sequences for the width shortcuts.
 *
 * The `=` / `-` key ids cover terminals that report the *base* key code (kitty
 * CSI-u sends `ESC[61;6u` for Shift+=), while the explicit sequences cover
 * terminals that report the *produced character* (`+` is codepoint 43). The
 * latter cannot be written as a key id at all: pi splits key ids on "+", so
 * "ctrl+shift++" parses to garbage and never matches.
 */
const WIDER_SEQUENCES = ["\x1b[43;6u", "\x1b[27;6;43~", "\x1b[43;6~"];
const NARROWER_SEQUENCES = ["\x1b[95;6u", "\x1b[27;6;95~", "\x1b[95;6~"];

/** Ctrl+Shift+= (grow the sidebar). */
export function isWiderKey(data: string): boolean {
  if (WIDER_SEQUENCES.includes(data)) return true;
  try {
    return matchesKey(data, "ctrl+shift+=" as KeyId);
  } catch {
    return false;
  }
}

/** Ctrl+Shift+- (shrink the sidebar). `_` is accepted for the shifted variant. */
export function isNarrowerKey(data: string): boolean {
  if (NARROWER_SEQUENCES.includes(data)) return true;
  try {
    return matchesKey(data, "ctrl+shift+-" as KeyId) || matchesKey(data, "ctrl+shift+_" as KeyId);
  } catch {
    return false;
  }
}
