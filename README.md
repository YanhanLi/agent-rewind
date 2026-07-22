# Agent Rewind

[中文](#中文说明) | [English](#english)

## 中文说明

Agent Rewind 是一个本地 MCP 文件操作代理。它会在 Agent 写入、编辑、移动文件或创建目录之前展示变更，让用户明确批准，并为已经执行的操作保存可验证的撤销记录。

它目前面向 macOS 上的 Claude Desktop，包装官方 Filesystem MCP Server。所有审批、快照和操作记录均保存在本机，不需要账号或云服务。

### 它解决什么问题

Claude Desktop 原生确认框主要展示工具名和参数。Agent Rewind 在此基础上提供：

- 执行前查看文件 diff、影响路径和快照大小；
- 拒绝单次操作，或仅在当前会话放行同一目录内的同类工具；
- 撤销单次操作或一组连续操作；
- 撤销前检查文件是否又被用户、IDE 或其他 Agent 修改；
- 撤销后重新计算哈希，确认文件确实回到原始状态。

检测到冲突时，Agent Rewind 会拒绝自动覆盖用户的新内容。

### 快速开始

需要 Node.js 22.5 或更高版本：

```bash
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind doctor /绝对路径/允许访问的目录
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind install claude --dry-run /绝对路径/允许访问的目录
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind install claude /绝对路径/允许访问的目录
```

安装命令只修改 Claude Desktop 配置中的 `filesystem-with-rewind` 条目，其他设置和 MCP Server 会保留。已有配置会先备份为同目录下带时间戳的 `.backup-*` 文件，再通过临时文件原子替换。重复安装相同配置不会再次写入或生成备份。

如果只想查看需要合并的配置片段，不修改文件：

```bash
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind config claude /绝对路径/允许访问的目录
```

该命令输出：

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

重启 Claude Desktop。不要同时为同一目录配置未包装的 Filesystem MCP Server，否则 Agent 可以绕过 Agent Rewind。

需要移除时，只删除 Agent Rewind 自己的条目并保留其他配置：

```bash
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind uninstall claude --dry-run
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind uninstall claude
```

第一次出现待审批操作时，浏览器会自动打开本地审批页。默认从 `http://127.0.0.1:3219` 开始监听；若端口被占用，会自动尝试后续端口。快照和操作记录保存在 `~/.agent-rewind/`。

Agent 可以调用 `rewind_begin_change_set` 和 `rewind_end_change_set` 明确标记一个多步骤任务，还可以为任务设置简短标签。未显式标记时，相隔不超过 30 秒的连续变更仍会自动聚合。整组撤销开始前会检查所有路径的最终状态；只要发现一个冲突，就不会修改任何文件。

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

- 只有经过这个 MCP Server 的操作才可见，Claude、Codex 或其他客户端的内置文件工具不在覆盖范围内。
- 本地 API 使用随机能力令牌和 Origin 校验，审批默认在两分钟后失效。
- 符号链接和特殊文件会被快照层拒绝。
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

已支持 `write_file`、`edit_file`、`create_directory` 和 `move_file`。只读工具会原样转发。OpenCode 和 Codex 适配将在 Claude Desktop 用户验证完成后再推进。

## English

Agent Rewind is a local MCP filesystem wrapper that previews mutations, requires explicit approval, and records verifiable undo information. It currently targets Claude Desktop on macOS and wraps the official Filesystem MCP Server.

Key properties:

- local diff and impact preview before execution;
- single-action and session-scoped folder approval;
- explicit or time-window-based change sets with task labels;
- conflict-aware single/change-set undo with post-restore hash verification;
- local SQLite ledger and content-addressed snapshots;
- no account or cloud service.
- safe Claude Desktop install/uninstall with dry-run, backup, and atomic replacement.
- local-only, privacy-minimized validation metrics via `agent-rewind report`.

Run the diagnostic, inspect the dry-run, then install:

```bash
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind doctor /absolute/allowed/directory
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind install claude --dry-run /absolute/allowed/directory
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind install claude /absolute/allowed/directory
```

See the Chinese section above for configuration details and safety boundaries.

## Development

```bash
git clone https://github.com/YanhanLi/agent-rewind.git
cd agent-rewind
npm install
npm run check
```

The project is licensed under the [MIT License](LICENSE).
