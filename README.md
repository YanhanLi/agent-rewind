# Agent Rewind

Agent Rewind is a local MCP wrapper that previews filesystem changes and makes
approved changes safely undoable. It currently targets Claude Desktop on macOS
and wraps the official MCP Filesystem Server.

Version 0.2 is a user-testing build. It supports `write_file`, `edit_file`,
`create_directory`, and `move_file`. Read-only tools pass through unchanged.

## Run locally

```bash
npm install
npm run build
node /absolute/path/to/agent-rewind/dist/cli.js /absolute/allowed/directory
```

The local approval page runs at `http://127.0.0.1:3219` and opens when the first
filesystem action needs approval. Snapshots and the change ledger are stored in
`~/.agent-rewind/`.

Run the diagnostic before configuring a client:

```bash
node /absolute/path/to/agent-rewind/dist/cli.js doctor /absolute/allowed/directory
```

## Claude Desktop

Build the project, then add this server to Claude Desktop's configuration:

```json
{
  "mcpServers": {
    "filesystem-with-rewind": {
      "command": "node",
      "args": [
        "/absolute/path/to/agent-rewind/dist/cli.js",
        "/absolute/allowed/directory"
      ]
    }
  }
}
```

Restart Claude Desktop after changing its configuration. Do not configure the
unwrapped Filesystem MCP Server for the same directory, because calls through
that server would bypass Agent Rewind.

## Safety behavior

- A mutating call waits for explicit approval in the local page.
- Every local API request requires a random capability token and same-origin validation.
- Approval expires after two minutes; occupied ports fall forward from 3219 automatically.
- "Allow in folder" applies only to the same tool and directory tree for the current process.
- The target is checked again after approval to prevent a time-of-check/time-of-use race.
- Undo proceeds only when the current path still matches the recorded post-change hash.
- Undo is verified against the original pre-change hash.
- Conflicting external edits are never overwritten automatically.
- Individual snapshots default to 16 MiB, the store defaults to 1 GiB, and records expire after 7 days.

These defaults can be adjusted for testing:

```bash
AGENT_REWIND_MAX_FILE_MB=32 \
AGENT_REWIND_MAX_TOTAL_MB=2048 \
AGENT_REWIND_RETENTION_DAYS=14 \
AGENT_REWIND_APPROVAL_TIMEOUT_MS=180000 \
node dist/cli.js /absolute/allowed/directory
```

## Current boundaries

- Only operations routed through this MCP server are visible.
- The approval page is process-local and listens only on `127.0.0.1`; it is not a multi-user service.
- Symlinks and special filesystem entries are rejected by the snapshot layer.
- OpenCode and Codex adapters are planned after the MCP feasibility gate.
