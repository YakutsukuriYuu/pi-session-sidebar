# pi-session-sidebar

ChatGPT 风格的左侧会话导航栏，直接嵌入 [Pi](https://pi.dev) 的终端 TUI。

```text
┌────────────────────┬──────────────────────────┐
│  Pi 会话           │                          │
│                    │                          │
│  Ctrl+Shift+H 导航 │      当前对话内容        │
│                    │                          │
│  ▾ my-project    2 │                          │
│  ● 修复登录 bug    │                          │
│    插件设计讨论    │                          │
│  ▸ blog          5 │                          │
│                    │                          │
│  2 项目 · 7 会话   │                          │
└────────────────────┴──────────────────────────┘
```

## 功能

- **左侧固定会话栏**：按项目分组显示所有 Pi 会话，当前会话用 `●` 标记
- **键盘导航模式**：`Ctrl+Shift+H` 进入，方向键移动，Enter 切换会话
  - 进入后头部显示 `导航中` 徽标、选中行高亮、分隔线变为青色，Esc 退出
- **搜索**：导航模式下按 `/` 过滤会话标题、首条消息、项目路径
- **新建会话**：导航模式下按 `n`
- **重命名**：导航模式下按 `r`（仅当前会话）
- **项目折叠**：`←` / `→` 折叠或展开项目分组
- **窄终端自动折叠**：终端宽度小于 100 列时自动隐藏，恢复后自动出现
- **宽度可调**：`/session-sidebar width 30`

## 安装

```bash
# 从本地目录安装
pi install /path/to/pi-session-sidebar

# 或开发模式直接加载
pi -e /path/to/pi-session-sidebar/index.ts
```

## 使用

| 操作 | 方式 |
| --- | --- |
| 进入/退出会话导航 | `Ctrl+Shift+H` 或 `/session-sidebar nav` |
| 移动选择 | `↑` / `↓`（或 `g` / `G` 跳首尾） |
| 切换会话 | `Enter` |
| 折叠/展开项目 | `←` / `→` 或 `Enter`（选中分组行时） |
| 新建会话 | `n` |
| 重命名当前会话 | `r` |
| 搜索会话 | `/`，`Esc` 清除 |
| 退出导航 | `Esc` 或再按 `Ctrl+Shift+H` |

### 命令

```text
/session-sidebar nav         进入/退出会话导航（不依赖快捷键）
/session-sidebar on          开启侧栏
/session-sidebar off         关闭侧栏
/session-sidebar width 30    设置宽度（20-60）
/session-sidebar all         显示所有项目的会话（默认）
/session-sidebar current     只显示当前项目的会话
/session-sidebar refresh     手动刷新会话列表
```

配置保存在 `~/.pi/agent/pi-session-sidebar.json`。

## 工作原理

Pi 的扩展 API 不提供"修改主布局"的正式接口，所以本插件采用了与
[pi-sidebar-tui](https://pi.dev/packages/pi-sidebar-tui) 相同的终端合成
（compositor）技术，并把面板从右侧移到了左侧：

1. 通过 `Object.defineProperty` 收窄 `terminal.columns`，Pi 主区域按缩小后的
   宽度渲染；
2. 包装 `tui.doRender`，在 Pi 写入每一帧时改写转义序列，把主内容整体右移
   侧栏宽度（`\r` 后追加光标右移、`\x1b[2K` 改为只清到行尾、绝对列定位加
   偏移）；
3. 帧结束后，用绝对定位把会话栏绘制到左侧列，DECSC/DECRC 保存/恢复光标，
   只重写发生变化的行以避免闪烁；
4. 所有绘制包裹在同步输出标记（`\x1b[?2026h` / `\x1b[?2026l`）中，保证主区
   域和侧栏原子更新。

### 导航模式的动作分发

`ctx.switchSession()` / `ctx.newSession()` 只存在于 **命令处理器** 的上下文
（`ExtensionCommandContext`）中，快捷键和事件处理器拿不到。因此导航模式下
的动作按键会通过 `onTerminalInput` 的数据变换通道注入一条合成命令
（如 `/session-sidebar switch <id>\r`），Pi 会像用户亲手输入一样分发该命令，
从而以合法的命令上下文完成会话切换。

### 数据来源

- 会话列表：`SessionManager.listAll()` / `SessionManager.list(cwd)`
- 标题：会话的 `session_info` 名称，缺省用首条用户消息
- 刷新时机：`session_start`、`session_info_changed`、`agent_settled`、
  `session_tree` 事件

不直接读写任何 session JSONL 文件。

## 限制

- 仅在 TUI 模式生效（`pi` 交互模式），RPC/print 模式自动跳过
- 终端宽度 < 100 列时自动隐藏，恢复宽度后自动出现；自动隐藏时会同时退出导航模式
- `Ctrl+Shift+H` 需要终端支持 Kitty keyboard protocol 才能识别（Ghostty、kitty、
  WezTerm、iTerm2 新版均支持）。如果按下无反应，说明终端不上报该组合键，请改用
  `/session-sidebar nav`，或在 `~/.pi/agent/keybindings.json` 中重新绑定
- 导航模式只拦截导航键（方向键、Enter、Esc、`n`、`r`、`/`、`g`、`G`），其余按键
  （包括 Shift+Enter、Ctrl+C、正常输入）都会直接传给编辑器
- 输入框里有未发送的草稿时，导航模式里的切换/新建/重命名会被拒绝（防止草稿被
  注入的命令污染），请先发送或清空草稿
- 导航模式不支持鼠标（终端鼠标事件处理留待后续版本）
- 会话内分支树（`/tree` 的 fork 结构）暂不在侧栏显示，计划中

## 开发

```bash
npm install
npm run check     # 类型检查 + 逻辑冒烟测试
```

### Sources / 致谢

- 终端合成技术参考 [pi-sidebar-tui](https://github.com/bi0h4z4rd88/pi-sidebar-tui)（MIT）
- [Pi 扩展文档](https://pi.dev/docs/latest/extensions)
