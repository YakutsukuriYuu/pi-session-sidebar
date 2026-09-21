# pi-session-sidebar

Pi 的会话工作台：**常驻左侧会话栏**（ChatGPT 风格）+ **原生级会话选择器** `/r`（原 [pi-resume-plus](https://github.com/YakutsukuriYuu/pi-resume-plus) 的全部能力）。

```text
┌────────────────────┬──────────────────────────┐
│ Pi 会话            │                          │
│                    │                          │
│ Ctrl+Shift+H 聚焦  │      当前对话内容        │
│                    │                          │
│  ▾ my-project    2 │                          │
│  ● 修复登录 bug    │                          │
│    插件设计讨论    │                          │
│  ▸ blog          5 │                          │
│                    │                          │
│  2 项目 · 7 会话   │                          │
└────────────────────┴──────────────────────────┘
```

## 组成

### 1. 左侧常驻会话栏

- 按项目分组显示所有 Pi 会话，当前会话用 `●` 标记
- **tmux 式焦点模型**：`Ctrl+Shift+H` 把键盘焦点交给侧栏，再按一次或 `Esc` 归还
- 焦点在侧栏时：输入即搜索（标题、首条消息、项目路径），Pi 主区域完全收不到按键
- 窄终端（< 100 列）自动隐藏并释放焦点，恢复后自动出现

侧栏持有焦点时的按键：

| 按键 | 作用 |
| --- | --- |
| 直接打字 | 搜索（`Backspace` 删除，`Ctrl+U` 清空） |
| `↑` / `↓` | 移动选择 |
| `←` / `→` | 折叠 / 展开项目分组 |
| `Enter` | 会话行：切换并**焦点交还右侧**；项目行：折叠/展开 |
| `Shift+Enter` | 会话行：切换并**焦点留在侧栏**；项目行：**在该项目下新建会话**并切过去 |
| `Ctrl+N` | 新建会话 |
| `Ctrl+R` | 重命名所选会话（不限当前会话） |
| `Ctrl+D` | 删除所选会话（trash 优先，活跃会话受保护） |
| `Ctrl+O` | 在新终端窗口打开所选会话（活跃时询问 fork） |
| `Esc` / `Ctrl+Shift+H` | 焦点交还右侧 |

### 2. `/r` 会话选择器（原 pi-resume-plus）

原生 `/resume` 的完整复制 + 项目目录树增强，不修改 pi 本体：

- `/r` 或 `/resume-tree` — 打开选择器（默认 **All 面板**，当前目录置顶；Tab 切到 Current Folder 与原生逐行一致）
- `pi --rr`（或 `--resume-plus`）— 启动后立即自动打开选择器；Esc/Ctrl+C 取消则留在当前会话
- 搜索：默认**严格子串**（多词 AND）；`"文本"` = 模糊匹配；`re:` 正则；`searchMode: "fuzzy"` 可切回原生语义
- 排序：threaded / recent / relevance，与原生逐行相等
- Ctrl+N 命名过滤、Ctrl+P 路径显示、Ctrl+D 删除、Ctrl+R 重命名
- 跨目录线程：`↗ [目录] 名称` 引用行，A→B→A 回环 fork 也不断链
- Alt+G 分组/原生平铺切换；Shift+↑↓ 跳项目；Shift+←/→ 全部折叠/展开
- Shift+Enter：会话行 = 新终端打开；项目行 = 该项目下新建会话
- 活跃会话检测（每 PID 一个原子文件）；空会话自动清理

## 安装

```bash
# 方式一：pi 包管理（推荐）
pi install git:github.com/YakutsukuriYuu/pi-session-sidebar

# 方式二：克隆到扩展目录
git clone https://github.com/YakutsukuriYuu/pi-session-sidebar.git ~/.pi/agent/extensions/pi-session-sidebar

# 开发模式
pi -e /path/to/pi-session-sidebar/index.ts
```

> 从 pi-resume-plus 迁移：删除旧的 `~/.pi/agent/extensions/resume-plus`，把其中的
> `config.json` 拷到本插件根目录即可（格式兼容，新增 `sidebar` 段可选）。

## 配置

配置位于插件根目录 `config.json`（参考 `config.example.json`），编辑后 `/reload` 生效。
格式错误会**关闭加载并给出错误通知**（fail-closed），不会静默退回默认值。

```json
{
  "sidebar": {
    "enabled": true,
    "width": 30,
    "showAllProjects": true,
    "focusKey": "ctrl+shift+h"
  },
  "shiftEnter": {
    "enabled": true,
    "mode": "same",
    "piPath": "pi",
    "terminal": { "type": "system" }
  },
  "searchMode": "substring",
  "folderNewSession": { "enabled": true, "cleanupUnused": true }
}
```

| 字段 | 说明 |
|---|---|
| `sidebar.enabled` | 侧栏开关（也可 `/session-sidebar on\|off`） |
| `sidebar.width` | 侧栏宽度 20-60（也可 `/session-sidebar width <n>`） |
| `sidebar.showAllProjects` | `false` 时只显示当前项目的会话 |
| `sidebar.focusKey` | 聚焦快捷键，需终端支持 Kitty keyboard protocol 才能区分 shift 组合键 |
| `shiftEnter.*` | 新终端打开：enabled / mode(`same`\|`fork`) / piPath / terminal |
| `searchMode` | `substring`（默认）/ `fuzzy`（原生 pi 语义） |
| `folderNewSession.*` | 项目行 Shift+Enter 新建会话 + 空会话自动清理 |

`/session-sidebar` 的运行时修改（on/off/width/all/current）只回写 `sidebar` 段，其他段原样保留。

## 工作原理

### 侧栏：终端合成器

Pi 的扩展 API 不提供"修改主布局"的正式接口，侧栏采用与
[pi-sidebar-tui](https://pi.dev/packages/pi-sidebar-tui) 相同的终端合成技术，
并把面板从右侧移到了左侧：

1. 收窄 `terminal.columns`，Pi 主区域按缩小后的宽度渲染；
2. 包装 `tui.doRender`，改写每帧的转义序列把主内容整体右移（`\r` 后追加光标右移、
   `\x1b[2K` 改为只清到行尾、绝对列定位加偏移、聚焦时隐藏右侧光标）；
3. 帧结束后用绝对定位绘制侧栏，DECSC/DECRC 保存/恢复光标，只重写变化的行；
4. 全程包裹同步输出标记（`\x1b[?2026h/l`），主区域和侧栏原子更新。

### 焦点隔离

- **未聚焦**：`onTerminalInput` 监听器返回 `undefined`，Pi 拿到原生输入
- **聚焦**：消费**所有**按键（未绑定的键也不漏给 Pi），用 `matchesKey()` 解码
- Kitty 协议的**按键释放/重复事件**无条件吞掉，否则一次按键会触发两次
- 对话框/选择器打开时（重命名、删除确认、`/r`）监听器自动让路

### 动作分发

`ctx.switchSession()` / `ctx.newSession()` 只存在于命令处理器的上下文中。侧栏触发的
切换/新建通过 `ctx.ui.setEditorText()` 写入命令再提交一次回车事件来分发（pi 的编辑器
会把文本块里的 `\r` 规范化成字面换行，所以文本和回车必须是两次独立事件）。
"切换但留在侧栏"通过一次性标记文件在扩展重载后恢复焦点。

### 数据来源

- 会话列表：`SessionManager.listAll()` / `SessionManager.list(cwd)`
- 刷新时机：`session_start`、`session_info_changed`、`agent_settled`、`session_tree`
- 活跃会话：`~/.pi/agent/resume-plus-active/<pid>.json`（兼容旧目录名）

不直接读写任何 session JSONL 文件（重命名除外：经 `SessionManager.open()` 追加
`session_info` 条目，格式与 `/name` 一致）。

## 限制

- 仅在 TUI 模式生效，RPC/print 模式自动跳过
- `Ctrl+Shift+H` 需要终端支持 Kitty keyboard protocol（Ghostty、kitty、WezTerm、
  iTerm2 新版支持）；不支持时用 `/session-sidebar nav` 聚焦、`Esc` 离开
- 输入框有未发送草稿时，切换/新建会被拒绝（命令要借编辑器提交），先发送或清空
- 侧栏不支持鼠标
- 会话内分支树（`/tree` 的 fork 结构）暂不在侧栏显示，计划中

## 测试

```bash
npm install
npm run check        # 类型检查 + 侧栏冒烟测试 + 选择器 50 项对照测试
npm run test:tui     # 真实 PTY：/r 流程、--rr、全折叠/展开、项目下新建会话
```

### Sources / 致谢

- 终端合成技术参考 [pi-sidebar-tui](https://github.com/bi0h4z4rd88/pi-sidebar-tui)（MIT）
- 选择器组件派生自 pi 0.85.1 源码（见 `UPSTREAM.md`，MIT）
- [Pi 扩展文档](https://pi.dev/docs/latest/extensions)
