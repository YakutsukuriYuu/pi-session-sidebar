/**
 * Utilities for formatting keybinding hints in the UI.
 */

import type { Keybinding, KeyId } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { PickerTheme } from "./theme.ts";

export interface KeyTextFormatOptions {
	capitalize?: boolean;
}

function formatKeyPart(part: string, options: KeyTextFormatOptions): string {
	const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}

export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => formatKeyPart(part, options))
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"), options);
}

export function createHints(theme: PickerTheme, keybindings: KeybindingsManager) {
	const keyText = (keybinding: Keybinding): string => formatKeys(keybindings.getKeys(keybinding));
	return {
		keyText,
		keyHint: (keybinding: Keybinding, description: string): string =>
			theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`),
		rawKeyHint: (key: string, description: string): string =>
			theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`),
	};
}
