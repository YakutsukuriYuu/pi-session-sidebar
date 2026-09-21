import { decodeKittyPrintable, isKeyRelease, isKeyRepeat, isKittyProtocolActive, matchesKey } from "@earendil-works/pi-tui";
import type { KeyId } from "@earendil-works/pi-tui";
import type { SidebarKeyConfig } from "./config.ts";

/**
 * Semantic action decoded from a raw terminal key sequence while the sidebar
 * holds focus.
 */
export type SidebarAction =
  | { type: "exit" }
  | { type: "toggleSidebar" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  /** Switch to the selected session; keepFocus decides where focus lands after. */
  | { type: "switch"; keepFocus: boolean }
  | { type: "new" }
  | { type: "rename" }
  /** Width shortcuts: one column per press. */
  | { type: "wider" }
  | { type: "narrower" }
  /** Bulk project operations and project-to-project jumps. */
  | { type: "collapseAll" }
  | { type: "expandAll" }
  | { type: "prevFolder" }
  | { type: "nextFolder" }
  /** Directional focus switch between pi's editor and the sidebar. */
  | { type: "focusSidebar" }
  | { type: "focusEditor" }
  | { type: "backspace" }
  | { type: "clearSearch" }
  | { type: "type"; text: string }
  /** Nothing bound: still consumed (true focus isolation). */
  | { type: "ignore" };

/**
 * Sequences some terminals send for a shifted symbol key instead of the key id.
 *
 * kitty CSI-u reports the *base* key code, so Shift+= arrives as `ESC[61;6u` and
 * a configured "ctrl+shift+=" matches it directly. Other terminals report the
 * *produced character* instead: "+" is codepoint 43 and "_" is 95. Those cannot
 * be written as key ids at all — pi splits key ids on "+", so "ctrl+shift++"
 * parses to garbage and never matches — hence this explicit table.
 */
const KEY_SEQUENCE_VARIANTS: Record<string, readonly string[]> = {
  "ctrl+shift+=": ["\x1b[43;6u", "\x1b[27;6;43~", "\x1b[43;6~"],
  "ctrl+shift+-": ["\x1b[95;6u", "\x1b[27;6;95~", "\x1b[95;6~"],
};

/**
 * Match raw input against a user-configured key id, including the terminal
 * variants listed above.
 */
export function matchesConfiguredKey(data: string, keyId: string): boolean {
  if (!data || !keyId) return false;
  if (KEY_SEQUENCE_VARIANTS[keyId]?.includes(data)) return true;
  try {
    return matchesKey(data, keyId as KeyId);
  } catch {
    // An unparsable user-supplied key id must never crash the extension.
    return false;
  }
}

/**
 * Keys whose legacy encoding is a control code that already means something
 * else: ctrl+h is 0x08 (Backspace), ctrl+i is 0x09 (Tab), ctrl+j is 0x0a (LF)
 * and ctrl+m is 0x0d (CR). Terminals only tell them apart once the kitty
 * keyboard protocol is active, so without it they are skipped — otherwise
 * every Backspace would toggle the panel.
 */
const LEGACY_AMBIGUOUS_KEYS = new Set(["ctrl+h", "ctrl+i", "ctrl+j", "ctrl+m"]);

/** Split a configured value into individual key ids (comma-separated lists allowed). */
function configuredKeys(value: string): string[] {
  return value
    .split(",")
    .map((key) => key.trim().toLowerCase())
    .filter(Boolean);
}

/** False when this terminal cannot distinguish the key from a control code. */
export function isKeyUsable(keyId: string): boolean {
  return isKittyProtocolActive() || !LEGACY_AMBIGUOUS_KEYS.has(keyId);
}

/** Configured keys this terminal has to skip, for a one-time hint. */
export function unusableConfiguredKeys(configured: string): string[] {
  return configuredKeys(configured).filter((key) => !isKeyUsable(key));
}

/** Match raw input against a configured key or comma-separated list of keys. */
export function matchesConfiguredKeys(data: string, configured: string): boolean {
  if (!data || !configured) return false;
  return configuredKeys(configured).some(
    (keyId) => isKeyUsable(keyId) && matchesConfiguredKey(data, keyId),
  );
}

/**
 * Events that must be swallowed no matter where focus is.
 *
 * Key releases carry no input content, but pi's editor does not filter them, so
 * a release would otherwise be matched again by the shortcut dispatcher — one
 * keypress would toggle twice. The same applies to auto-repeat of the sidebar
 * shortcuts: holding the toggle key would flip the panel back and forth, and
 * holding a width key would race past the intended column.
 */
export function isInertKeyEvent(data: string, keys: SidebarKeyConfig): boolean {
  if (!data) return true;
  if (isKeyRelease(data)) return true;
  if (!isKeyRepeat(data)) return false;
  return [keys.focus, keys.toggle, keys.wider, keys.narrower].some((key) =>
    matchesConfiguredKeys(data, key),
  );
}

/**
 * Decode one raw terminal input chunk into a sidebar action.
 *
 * The sidebar is a real focus owner: while it is focused every key belongs to
 * it, so an `ignore` result still means "consume".
 */
export function decodeSidebarKey(data: string, keys: SidebarKeyConfig): SidebarAction {
  if (!data) return { type: "ignore" };

  // Kitty protocol reports press, repeat and release. A release must never
  // re-trigger an action: without this, pressing a shortcut would act on press
  // and act again on the key-up event.
  if (isKeyRelease(data)) return { type: "ignore" };

  // Auto-repeat is fine for navigation and typing, but commit-like actions
  // must not fire over and over while a key is held down.
  const repeat = isKeyRepeat(data);

  // Leave focus: the focus shortcut itself (so it toggles) or Escape.
  if (!repeat && matchesKey(data, "escape")) return { type: "exit" };
  if (!repeat && matchesConfiguredKeys(data, keys.focus)) return { type: "exit" };
  if (!repeat && matchesConfiguredKeys(data, keys.toggle)) return { type: "toggleSidebar" };

  // Project bulk operations and jumps. Checked before the plain arrows, which
  // matchesKey keeps separate (it matches modifiers exactly).
  if (!repeat && matchesConfiguredKeys(data, keys.collapseAll)) return { type: "collapseAll" };
  if (!repeat && matchesConfiguredKeys(data, keys.expandAll)) return { type: "expandAll" };
  if (!repeat && matchesConfiguredKeys(data, keys.prevFolder)) return { type: "prevFolder" };
  if (!repeat && matchesConfiguredKeys(data, keys.nextFolder)) return { type: "nextFolder" };

  // Directional focus switch (ctrl+left / ctrl+right by default).
  if (!repeat && matchesConfiguredKeys(data, keys.focusLeft)) return { type: "focusSidebar" };
  if (!repeat && matchesConfiguredKeys(data, keys.focusRight)) return { type: "focusEditor" };

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
  if (!repeat && matchesConfiguredKeys(data, keys.wider)) return { type: "wider" };
  if (!repeat && matchesConfiguredKeys(data, keys.narrower)) return { type: "narrower" };
  if (!repeat && matchesKey(data, "ctrl+u")) return { type: "clearSearch" };
  if (matchesKey(data, "backspace")) return { type: "backspace" };
  if (!repeat && matchesKey(data, "tab")) return { type: "right" };
  if (!repeat && matchesKey(data, "shift+tab")) return { type: "left" };

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
