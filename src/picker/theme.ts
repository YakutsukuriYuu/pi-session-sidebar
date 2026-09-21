import type { Theme } from "@earendil-works/pi-coding-agent";

/** Instance-scoped host theme. Never mutate pi's global theme/keybindings. */
export type PickerTheme = Pick<Theme, "fg" | "bg" | "bold">;
