import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { TerminalConfig } from "./config.ts";

export function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
export function appleScriptQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}
function expand(path: string): string { return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path; }
export function resolveExecutable(command: string, env = process.env): string {
  const expanded = expand(command);
  const candidates = isAbsolute(expanded) || expanded.includes("/") || expanded.includes("\\")
    ? [resolve(expanded)] : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, expanded));
  for (const file of candidates) {
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; } catch { /* next */ }
  }
  throw new Error(`找不到可执行文件 ${command}；请在插件 config.json 中配置绝对路径`);
}
export function detectTerminal(configured?: TerminalConfig, env = process.env, platform: string = process.platform): string {
  if (configured?.type && configured.type !== "system") return configured.type;
  const program = (env.TERM_PROGRAM ?? "").toLowerCase();
  if (program.includes("iterm")) return "iTerm2";
  if (program.includes("wezterm") || env.WEZTERM_PANE) return "WezTerm";
  if (program.includes("ghostty") || env.GHOSTTY_RESOURCES_DIR) return "Ghostty";
  if (env.KITTY_WINDOW_ID) return "Kitty";
  if (program.includes("alacritty") || env.ALACRITTY_WINDOW_ID) return "Alacritty";
  if (program.includes("apple_terminal")) return "Terminal.app";
  if (platform === "darwin") return "Terminal.app";
  if (platform === "linux") {
    if (env.KONSOLE_VERSION) return "konsole";
    if (env.GNOME_TERMINAL_SCREEN) return "gnome-terminal";
    return "x-terminal-emulator";
  }
  throw new Error("此系统需要配置 terminal.type=custom；不会回退到 macOS 启动器");
}
export type LaunchPlan = { command: string; args: string[]; wait: boolean };
/** Pure argument construction, independently testable without opening windows. */
export function buildLaunchPlan(terminal: TerminalConfig | undefined, cwd: string, session: string,
  mode: "same" | "fork", pi: string, env = process.env, platform: string = process.platform): LaunchPlan {
  if (terminal?.type === "custom") {
    const executable = terminal.executable || terminal.path;
    if (!executable) throw new Error("custom 终端缺少 executable/path 配置");
    const values = { cwd, session, pi, mode };
    return { command: expand(executable), args: (terminal.args ?? []).map((arg) =>
      arg.replace(/\{(cwd|session|pi|mode)\}/g, (_, key: keyof typeof values) => values[key])), wait: false };
  }
  const type = detectTerminal(terminal, env, platform);
  const piArgs = [mode === "fork" ? "--fork" : "--session", session];
  // Explicit POSIX shell: do not depend on whether the user's login shell is fish/zsh/bash.
  const command = `cd -- ${shellQuote(cwd)} && ${shellQuote(pi)} ${piArgs.map(shellQuote).join(" ")}`;
  const shellCommand = `/bin/sh -c ${shellQuote(command)}`;
  if (type === "iTerm2" || type === "Terminal.app") {
    if (platform !== "darwin") throw new Error(`${type} 只能用于 macOS`);
    const app = expand(terminal?.path ?? (type === "iTerm2" ? "iTerm2" : "Terminal"));
    const body = type === "iTerm2" ? [
      `tell application ${appleScriptQuote(app)}`, "activate",
      "set newWindow to (create window with default profile)",
      `tell current session of newWindow to write text ${appleScriptQuote(shellCommand)}`, "end tell",
    ].join("\n") : `tell application ${appleScriptQuote(app)}\nactivate\ndo script ${appleScriptQuote(shellCommand)}\nend tell`;
    return { command: "osascript", args: ["-e", body], wait: true };
  }
  const binary = terminal?.path;
  switch (type) {
    case "WezTerm": return { command: binary ?? "wezterm", args: ["start", "--always-new-process", "--cwd", cwd, "--", pi, ...piArgs], wait: false };
    case "Kitty": return { command: binary ?? "kitty", args: ["--directory", cwd, pi, ...piArgs], wait: false };
    case "Ghostty":
      return platform === "darwin"
        ? { command: "open", args: ["-na", binary ?? "Ghostty", "--args", `--working-directory=${cwd}`, "-e", pi, ...piArgs], wait: true }
        : { command: binary ?? "ghostty", args: [`--working-directory=${cwd}`, "-e", pi, ...piArgs], wait: false };
    case "Alacritty": return { command: binary ?? "alacritty", args: ["--working-directory", cwd, "-e", pi, ...piArgs], wait: false };
    case "gnome-terminal": return { command: binary ?? type, args: ["--window", `--working-directory=${cwd}`, "--", pi, ...piArgs], wait: true };
    case "konsole": return { command: binary ?? type, args: ["--separate", "--workdir", cwd, "-e", pi, ...piArgs], wait: false };
    case "x-terminal-emulator": case "xterm":
      return { command: binary ?? type, args: ["-e", "/bin/sh", "-c", command], wait: false };
    default: throw new Error(`不支持的终端：${type}`);
  }
}
async function executePlan(plan: LaunchPlan): Promise<void> {
  const executable = resolveExecutable(plan.command);
  if (plan.wait) {
    try { await promisify(execFile)(executable, plan.args, { timeout: 60000, maxBuffer: 1024 * 1024 }); }
    catch (error) { throw new Error(`启动器失败（检查终端安装／自动化权限）：${error instanceof Error ? error.message : String(error)}`); }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, plan.args, { detached: true, stdio: "ignore" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error(`启动器退出：${signal ?? code}`));
    });
    child.once("spawn", () => {
      timer = setTimeout(() => { child.unref(); resolve(); }, 300);
    });
  });
}
export async function launchInTerminal(terminal: TerminalConfig | undefined, cwd: string, session: string,
  mode: "fork" | "same", piPath = "pi"): Promise<void> {
  // Never silently use a different project when a directory was moved/deleted.
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`项目目录不存在：${cwd}（普通 Enter 仍使用 pi 原生 cwd 恢复流程）`);
  if (!existsSync(session) || !statSync(session).isFile()) throw new Error(`Session 文件不存在：${session}`);
  const pi = resolveExecutable(piPath);
  const plan = buildLaunchPlan(terminal, cwd, session, mode, pi);
  if (plan.command === "open" && terminal?.path && !existsSync(expand(terminal.path))) throw new Error(`终端路径不存在：${terminal.path}`);
  await executePlan(plan);
}
