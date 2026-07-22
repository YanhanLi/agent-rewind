# Guard mode

Agent Rewind normally protects only calls made through its MCP server. Guard mode is an optional client-side rule that blocks selected built-in edit tools and tells the agent to use the guarded MCP tools instead.

## Coverage

| Client | Guarded built-ins | Still outside Agent Rewind |
| --- | --- | --- |
| OpenCode | `edit`, `write`, `apply_patch` | `bash`, third-party plugins, direct user edits |
| Codex | `apply_patch` (`Edit` and `Write` matcher aliases) | shell commands, specialized tools that opt out of hooks, direct user edits |

Guard mode is a routing guardrail, not an operating-system sandbox. A shell command such as `sed -i`, `python` writing a file, or `rm` can still change files without creating an Agent Rewind snapshot.

## Install

Inspect the generated files first:

```bash
agent-rewind guard opencode --dry-run
agent-rewind guard codex --dry-run
```

Then install:

```bash
agent-rewind guard opencode
agent-rewind guard codex
```

The OpenCode command installs `~/.config/opencode/plugins/agent-rewind-guard.js`. The plugin throws before built-in file edit tools execute.

The Codex command installs `~/.codex/hooks.json` plus `~/.agent-rewind/hooks/codex-guard.mjs`. It merges its `PreToolUse` group with existing hooks instead of replacing them. Codex requires non-managed hooks to be reviewed: restart Codex, open `/hooks`, inspect the Agent Rewind hook, and trust it before relying on the guard.

Run `agent-rewind doctor /allowed/directory` after restarting. A configured MCP channel and configured guard are reported separately.

## Remove

```bash
agent-rewind unguard opencode --dry-run
agent-rewind unguard opencode
agent-rewind unguard codex --dry-run
agent-rewind unguard codex
```

Uninstall removes only exact Agent Rewind-managed content. If the plugin or script was modified, the command stops instead of deleting it. Removing the MCP client entry and removing guard mode are separate operations.

## Test expectation

After enabling guard mode, ask the client to modify a small test file without naming a tool. A direct built-in edit should be rejected, after which the model should retry with `filesystem-with-rewind` and display the local approval page. Also test a shell-based write separately; it should be treated as an explicitly documented bypass rather than recorded as a rewindable action.
