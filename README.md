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
- 撤销后重新计算哈希，确认文件确实回到原始状态；
- 撤销过程中即使在文件恢复后、账本提交前退出，下次操作也能从中间状态继续；
- 在批准后先持久化操作意图；若代理进程在写入后意外退出，下次启动会对账实际状态并补全可撤销记录；
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

历史记录中的 `Check undo` 会按需读取当前路径，并顺序校验撤销所需的全部本地快照，区分就绪、路径冲突和快照完整性异常。检查结果带时间戳且只缓存在当前页面；文件之后仍可能变化，因此真正执行撤销时会再次运行同一套预检。进程中断后处于 `partial` 状态的 change set 也会保留检查和继续撤销入口。

多个 mutation 可以同时等待审批，但获批后的二次状态检查、文件操作和账本提交会串行执行。若两个并发请求基于同一个旧状态修改同一路径，先执行的请求成功，后执行的请求会因状态已变化而拒绝，不会生成相互矛盾的撤销记录。显式 change set 的身份以审批时为准，即使等待期间任务组被结束或替换，最终账本仍保留用户当时看到的标签。

Claude Desktop、OpenCode 和 Codex 可以同时使用同一个数据目录。跨进程操作通过独立 SQLite 锁串行化，ledger 使用 WAL 和 busy timeout；因此另一个客户端启动恢复、执行 mutation 或撤销时，不会与正在进行的文件操作交错。进程被强制终止时，操作系统会自动释放锁，遗留 intent 仍由下一次启动对账。启动 GC 会为刚捕获但尚在等待审批的快照保留“审批超时 + 60 秒”的宽限期。

历史按 change set 建立本地索引，读取最近任务时只解析实际要显示的完整任务组，不再以固定动作数截断。升级已有数据目录时，旧记录会在一个 SQLite 写事务内自动回填索引；即使单个 change set 超过 500 个动作，历史计数、检查和撤销仍会覆盖全部动作。审批页的定时状态请求每组只携带前 5 个动作和路径并保留精确总数，完整详情仅在点击 `Load all details` 后读取，避免大型任务组被每秒重复传输和重绘。所有带本地历史或恢复信息的 GET 响应均标记为 `Cache-Control: no-store`。

审批页通过本地心跳判断是否仍在使用。页面关闭后，下一次待审批操作会重新打开浏览器；页面仍开着时不会反复弹出。

### 本地验证报告

Agent Rewind 会在本地记录审批、实际变更和撤销结果的最小事件。事件表在结构上只包含事件类型、工具名和撤销对象类型，不包含路径、文件内容、prompt 或工具参数，也不会自动上传。

查看聚合报告：

```bash
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind report
npm exec --yes --package=github:YanhanLi/agent-rewind -- agent-rewind report --json
```

报告用于早期用户测试，分享前应由用户本人检查。完整的五人测试流程和 go / iterate / pivot 门槛见 [用户验证方案](docs/USER_TESTING.md)。

### 意外退出恢复

每个已批准的变更会在执行前写入本地 SQLite intent。正常完成时，intent 和正式变更记录在同一事务中交接；如果 Agent Rewind、客户端或系统在文件操作后退出，下一次启动会先比较 intent 中的原始快照与磁盘现状：状态已变化则补全可撤销记录，状态未变化则丢弃未执行的 intent。恢复数量会显示在启动日志和 `agent-rewind report` 中。

补全的记录会进入审批页独立的 **Recovered changes** 队列，不会静默混入普通历史。文本文件会根据持久化的 before/after 快照显示 unified diff；二进制、目录和超过 128 KiB 的文件只显示类型、大小和短哈希摘要。检查证据后，可以选择 `Keep changes` 确认保留，也可以直接 `Undo set`；确认保留只结束待检查状态，不会移除之后的撤销能力。

这项机制处理的是“已进入 Agent Rewind 的操作在执行过程中被中断”，不是文件系统事务，也不能判断进程退出后由其他程序产生的写入。因此恢复出的记录在撤销前仍会执行冲突检查，用户应先查看变更内容再撤销。

### 安全边界

- 只有经过这个 MCP Server 的操作才可见，Claude、OpenCode、Codex 或其他客户端的内置文件工具不在覆盖范围内。
- 可选 OpenCode guard 会阻断内置 `edit`、`write` 和 `apply_patch`；可选 Codex guard 会阻断 `apply_patch`。guard 不会自动安装，也不会修改 OpenCode 全局 permission。
- shell 命令、第三方插件和绕过平台标准 hook 的工具仍可能直接写文件。Guard 模式是路由约束，不是操作系统级强制边界。
- 本地 API 使用随机能力令牌和 Origin 校验，审批默认在两分钟后失效。首次授权页会把 URL 中的令牌转入当前端口的 `sessionStorage` 并立即清理地址栏；刷新继续使用同一浏览器会话，裸页面不会读取历史。页面与 API 响应同时设置 CSP、禁止 framing、`no-referrer`、`nosniff` 和 `no-store`。
- 恢复 diff 仅通过带能力令牌的 localhost 审批页提供，不写入最小化事件表；它仍可能包含本地文件内容，分享页面截图前应自行检查。
- 符号链接和特殊文件会被快照层拒绝。
- `rewind_delete_directory` 不能删除配置根目录；目录内任何条目无法完整快照时，删除不会开始。
- 进程意外退出后会在下次启动对账未完成的 intent；如果目标暂时无法读取，intent 会保留到后续启动，不会自动丢弃原始快照。
- 撤销会在写回前重新校验内容寻址 blob 的大小和 SHA-256；文件和被删目录先在目标同级构建暂存内容，再原子提交，校验或写入失败不会留下半恢复目录。
- 撤销 Agent 新建的文件或目录时，会先把完整目标原子移动到带所有权 marker 的同级隔离目录，再清理内容；强制退出后的重试只回收 marker 与绝对目标均匹配的遗留暂存，不会按名称前缀删除用户目录。
- 单次撤销和 change set 撤销都可识别“文件已恢复、账本仍显示 applied”的中间态并继续完成；已落账的 change-set action 不会被重复执行。
- `conflict` 表示最近一次撤销被后续修改阻止，而不是永久终态；路径重新回到记录中的合法 before/after 状态后，可先运行 `Check undo` 再安全重试。
- change set 会在修改任何路径前顺序校验全部待用快照；冲突与快照完整性失败使用不同的 API 错误码，并在审批页显示不会被定时刷新清掉的操作提示。
- 已存在的内容寻址 blob 会在去重前重新校验；若之后再次捕获到相同哈希的可信内容，损坏文件或符号链接会被原子替换，异常目录则保留并拒绝自动删除。
- 数据根和 blob 目录每次初始化都会通过不跟随符号链接的目录句柄收紧为 `0700`，新 blob 使用 `0600`；最终数据路径若是符号链接会被拒绝。
- MCP stdin 关闭或收到 SIGINT/SIGTERM 时，会先结束待审批请求并等待已获批 mutation 落账，再关闭上游子进程、本地 HTTP 服务和 SQLite。
- 多个本地客户端共享 `~/.agent-rewind` 时，恢复、mutation 和撤销会跨进程串行；这保证账本一致性，但一个长时间未返回的上游操作也会让其他客户端等待。
- 单文件快照默认上限为 16 MiB，总存储上限为 1 GiB，记录默认保留 7 天。
- mutation 前的 `before` 内容必须能完整快照，否则操作不会开始；执行后的 `after` 内容若遇到配额或单文件上限，会退化为流式哈希和大小记录，仍可完成冲突检查、落账与撤销，但恢复预览可能只显示摘要。
- 当前是单机、单用户工具，不应作为网络服务暴露。

依赖审计的已知告警、实际可达性和复核命令见 [依赖安全说明](docs/DEPENDENCY_SECURITY.md)。项目不使用只在本仓库生效、却无法传递给 npm 使用者的 `overrides` 来制造本地零告警结果。

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
- resumable undo when a process exits after restoration but before ledger commit;
- approved, reversible single-file deletion through `rewind_delete_file`;
- recursive directory deletion with restorable file and empty-directory manifests;
- local SQLite ledger and content-addressed snapshots;
- transactionally migrated, indexed change-set history without per-set action truncation;
- bounded five-item history previews with exact counts and on-demand complete details;
- `Cache-Control: no-store` on authenticated local history and recovery responses;
- capability-token URL cleanup with session-scoped reload support and an unauthenticated empty shell;
- CSP, frame denial, no-referrer, nosniff, and same-origin browser isolation headers;
- SHA-256 verification of snapshot blobs and staged atomic file/directory restoration;
- bounded change-set snapshot preflight and actionable conflict/integrity feedback in the approval UI;
- on-demand, timestamped undo-readiness checks, including resumable partial change sets;
- atomic quarantine for undoing newly created paths, with ownership-verified stale staging cleanup;
- retryable conflict records and atomic self-repair when trusted content with the same hash is captured again;
- owner-only data/blob permissions with no-follow validation of final storage directories;
- crash recovery through persistent pre-mutation intents and startup reconciliation;
- a dedicated recovery-review queue with explicit keep or undo decisions;
- bounded snapshot-backed diffs with binary, directory, and large-file summaries;
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
npm run audit:high
```

The project is licensed under the [MIT License](LICENSE).
