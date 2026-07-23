# Agent Rewind

[中文](#中文说明) | [English](#english)

## 中文说明

Agent Rewind 是一个本地 MCP 文件操作代理。它会在 Agent 写入、编辑、移动或删除文件和目录之前展示变更，让用户明确批准，并为已经执行的操作保存可验证的撤销记录。

它目前支持 macOS 上的 Claude Desktop、OpenCode 和 Codex，包装官方 Filesystem MCP Server。所有审批、快照和操作记录均保存在本机，不需要账号或云服务。

### 它解决什么问题

Claude Desktop 原生确认框主要展示工具名和参数。Agent Rewind 在此基础上提供：

- 执行前查看文件 diff、影响路径和快照大小；
- 拒绝单次操作，或仅在当前会话放行同一目录内的同类工具；
- 撤销单次操作或一组连续操作；
- 撤销前检查文件是否又被用户、IDE 或其他 Agent 修改；
- 撤销后重新计算哈希，确认文件确实回到原始状态。
- 通过 `rewind_delete_file` 安全删除单个文件，并在误删后恢复原内容。
- 通过 `rewind_delete_directory` 递归删除目录，并恢复嵌套文件和空目录。

检测到冲突时，Agent Rewind 会拒绝自动覆盖用户的新内容。

### 一分钟演示

不修改任何真实项目或客户端配置，直接在系统临时目录体验完整流程：

```bash
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind demo
```

浏览器出现首次审批时选择 `Allow set`。演示会修改索引、移动文件并递归删除一个目录，随后可在审批页点击 `Undo set` 恢复整个任务。按 Ctrl+C 退出后，临时工作区、快照和 ledger 会自动删除。

用于 CI 或发布自检的无浏览器模式会自动批准、撤销并验证恢复结果：

```bash
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind demo --auto
```

### 快速开始

需要 Node.js 22.5 或更高版本：

```bash
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind doctor /绝对路径/允许访问的目录
```

选择正在使用的客户端。所有安装命令都支持 `--dry-run`：

```bash
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind install claude --dry-run /绝对路径/允许访问的目录
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind install claude /绝对路径/允许访问的目录

npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind install opencode --dry-run /绝对路径/允许访问的目录
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind install opencode /绝对路径/允许访问的目录

npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind install codex --dry-run /绝对路径/允许访问的目录
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind install codex /绝对路径/允许访问的目录
```

Claude Desktop 和 OpenCode 安装器只修改 `filesystem-with-rewind` 条目，保留其他设置和 MCP Server。已有配置会先备份为同目录下带时间戳的 `.backup-*` 文件，再通过临时文件原子替换；OpenCode 的 JSONC 注释也会保留。Codex 安装器使用官方 `codex mcp add/get/remove` 命令，不自行重写 TOML。重复安装相同配置不会再次写入。

如果只想查看需要合并的配置片段，不修改文件：

```bash
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind config claude /绝对路径/允许访问的目录
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind config opencode /绝对路径/允许访问的目录
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind config codex /绝对路径/允许访问的目录
```

例如，Claude Desktop 命令输出：

```json
{
  "mcpServers": {
    "filesystem-with-rewind": {
      "command": "npm",
      "args": [
        "exec",
        "--yes",
        "--package=github:YanhanLi/agent-rewind",
        "--",
        "agent-rewind",
        "/绝对路径/允许访问的目录"
      ]
    }
  }
}
```

重启对应客户端。不要同时为同一目录配置未包装的 Filesystem MCP Server，否则 Agent 可以绕过 Agent Rewind。

### 可选 Guard 模式

OpenCode 和 Codex 自带编辑工具，默认不会经过 MCP。Guard 模式会在客户端侧阻断这些直接编辑，并提示 Agent 改用 `filesystem-with-rewind`：

```bash
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind guard opencode --dry-run
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind guard opencode

npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind guard codex --dry-run
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind guard codex
```

OpenCode guard 阻断内置 `edit`、`write` 和 `apply_patch`。Codex guard 使用官方 `PreToolUse` hook 阻断 `apply_patch`；安装后必须在 Codex 的 `/hooks` 中审查并信任。两者都无法可靠识别所有 shell 写文件命令，因此 guard 不是完整沙箱。

移除命令为 `agent-rewind unguard opencode` 和 `agent-rewind unguard codex`。安装器只删除内容完全匹配的 Agent Rewind 插件或 hook，检测到人工修改时会停止。详细覆盖矩阵和验证步骤见 [Guard mode](docs/GUARD_MODE.md)。

需要移除时，只删除 Agent Rewind 自己的条目并保留其他配置：

```bash
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind uninstall claude --dry-run
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind uninstall claude
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind uninstall opencode
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind uninstall codex
```

第一次出现待审批操作时，浏览器会自动打开本地审批页。默认从 `http://127.0.0.1:3219` 开始监听；若端口被占用，会自动尝试后续端口。快照和操作记录保存在 `~/.agent-rewind/`。

Agent 可以调用 `rewind_begin_change_set` 和 `rewind_end_change_set` 明确标记一个多步骤任务，还可以为任务设置简短标签。显式组持续到 `rewind_end_change_set`，不受自动聚合窗口影响。第一次操作出现时可选择 `Allow set`：之后只有同一显式组、首次批准目录范围内的操作会自动放行；组结束、路径越界或普通自动分组都会重新审批。`Allow in folder` 的范围更宽，会在当前进程内放行同类工具和目录，应谨慎选择。

未显式标记时，相隔不超过 30 秒的连续变更仍会自动聚合，但不会出现 `Allow set`。整组撤销开始前会检查所有路径的最终状态；只要发现一个冲突，就不会修改任何文件。

审批页通过本地心跳判断是否仍在使用。页面关闭后，下一次待审批操作会重新打开浏览器；页面仍开着时不会反复弹出。

### 本地验证报告

Agent Rewind 会在本地记录审批、实际变更和撤销结果的最小事件。事件表在结构上只包含事件类型、工具名和撤销对象类型，不包含路径、文件内容、prompt 或工具参数，也不会自动上传。

查看聚合报告：

```bash
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind report
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind report --json
```

报告用于早期用户测试，分享前应由用户本人检查。完整的五人测试流程和 go / iterate / pivot 门槛见 [用户验证方案](docs/USER_TESTING.md)。

### 安全边界

- 只有经过这个 MCP Server 的操作才可见，Claude、OpenCode、Codex 或其他客户端的内置文件工具不在覆盖范围内。
- 可选 OpenCode guard 会阻断内置 `edit`、`write` 和 `apply_patch`；可选 Codex guard 会阻断 `apply_patch`。guard 不会自动安装，也不会修改 OpenCode 全局 permission。
- shell 命令、第三方插件和绕过平台标准 hook 的工具仍可能直接写文件。Guard 模式是路由约束，不是操作系统级强制边界。
- 本地 API 使用随机能力令牌和 Origin 校验，审批默认在两分钟后失效。
- 符号链接和特殊文件会被快照层拒绝。
- `rewind_delete_directory` 不能删除配置根目录；目录内任何条目无法完整快照时，删除不会开始。
- 单文件快照默认上限为 16 MiB，总存储上限为 1 GiB，记录默认保留 7 天。
- 当前是单机、单用户工具，不应作为网络服务暴露。

可通过环境变量调整测试参数：

```bash
AGENT_REWIND_MAX_FILE_MB=32 \
AGENT_REWIND_MAX_TOTAL_MB=2048 \
AGENT_REWIND_RETENTION_DAYS=14 \
AGENT_REWIND_APPROVAL_TIMEOUT_MS=180000 \
AGENT_REWIND_CHANGE_SET_WINDOW_MS=45000 \
node dist/cli.js /绝对路径/允许访问的目录
```

### 当前范围

已支持 `write_file`、`edit_file`、`create_directory`、`move_file`，以及 Agent Rewind 自己提供的 `rewind_delete_file` 和 `rewind_delete_directory`。两个删除工具分别只接受现有普通文件和现有目录，类型不匹配或路径缺失会在审批前拒绝。只读工具会原样转发。客户端能力依据 [OpenCode MCP](https://opencode.ai/docs/mcp-servers/)、[OpenCode plugins](https://opencode.ai/docs/plugins/)、[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp#configure-with-configtoml) 和 [Codex hooks](https://learn.chatgpt.com/docs/hooks) 文档实现。

## English

Agent Rewind is a local MCP filesystem wrapper that previews mutations, requires explicit approval, and records verifiable undo information. It supports Claude Desktop, OpenCode, and Codex on macOS and wraps the official Filesystem MCP Server.

Key properties:

- local diff and impact preview before execution;
- single-action, explicit change-set, and session-scoped folder approval;
- explicit or time-window-based change sets with task labels;
- conflict-aware single/change-set undo with post-restore hash verification;
- approved, reversible single-file deletion through `rewind_delete_file`;
- recursive directory deletion with restorable file and empty-directory manifests;
- local SQLite ledger and content-addressed snapshots;
- no account or cloud service.
- safe Claude Desktop install/uninstall with dry-run, backup, and atomic replacement.
- local-only, privacy-minimized validation metrics via `agent-rewind report`.
- safe client configuration for Claude Desktop, OpenCode JSONC, and Codex `config.toml` via the official Codex CLI.
- optional, reversible OpenCode and Codex guards that route direct edit tools toward Agent Rewind MCP.

Run the diagnostic, inspect the dry-run, then install:

```bash
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind demo
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind doctor /absolute/allowed/directory
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind install claude --dry-run /absolute/allowed/directory
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind install claude /absolute/allowed/directory
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind install opencode /absolute/allowed/directory
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind install codex /absolute/allowed/directory
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind guard opencode
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind guard codex
```

Guard mode blocks OpenCode's direct edit tools and Codex `apply_patch`, but shell writes remain outside the proxy. See the Chinese section and [guard-mode documentation](docs/GUARD_MODE.md) for exact boundaries.

## Development

```bash
git clone https://github.com/YanhanLi/agent-rewind.git
cd agent-rewind
npm install
npm run check
```

The project is licensed under the [MIT License](LICENSE).
