import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((item) => rm(item, { recursive: true })));
});

describe("CLI", () => {
  it("prints its version", () => {
    const output = execFileSync(process.execPath, [path.resolve("dist/cli.js"), "--version"], {
      encoding: "utf8",
    });
    expect(output.trim()).toBe("agent-rewind 0.27.0");
  });

  it("prints an empty local validation report as JSON", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-report-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o755);
    const output = execFileSync(
      process.execPath,
      [path.resolve("dist/cli.js"), "report", "--json"],
      { encoding: "utf8", env: { ...process.env, AGENT_REWIND_DATA_DIR: directory } },
    );
    const report = JSON.parse(output) as {
      period: { firstEventAt: string | null };
      approvals: { requested: number };
      changes: { actions: number };
    };

    expect(report.period.firstEventAt).toBeNull();
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect(report.approvals.requested).toBe(0);
    expect(report.changes.actions).toBe(0);
  });

  it("refuses a symlinked data directory without changing its target permissions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-data-link-"));
    temporaryDirectories.push(directory);
    const actual = path.join(directory, "actual");
    const linked = path.join(directory, "linked");
    await mkdir(actual);
    await chmod(actual, 0o755);
    await symlink(actual, linked);

    expect(() =>
      execFileSync(process.execPath, [path.resolve("dist/cli.js"), "report", "--json"], {
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, AGENT_REWIND_DATA_DIR: linked },
      }),
    ).toThrow();
    expect((await lstat(actual)).mode & 0o777).toBe(0o755);
  });

  it("runs the isolated demo through approval, mutation, and undo", async () => {
    const output = execFileSync(
      process.execPath,
      [path.resolve("dist/cli.js"), "demo", "--auto"],
      { encoding: "utf8", timeout: 15_000 },
    );
    const workspace = output.match(/^Demo workspace: (.+)$/m)?.[1];

    expect(output).toContain("Demo verification passed");
    expect(workspace).toBeDefined();
    await expect(lstat(workspace!)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("exits cleanly when MCP stdin closes or the process receives SIGTERM", async () => {
    for (const mode of ["stdin", "SIGTERM"] as const) {
      const root = await mkdtemp(path.join(os.tmpdir(), `agent-rewind-exit-${mode}-root-`));
      const data = await mkdtemp(path.join(os.tmpdir(), `agent-rewind-exit-${mode}-data-`));
      temporaryDirectories.push(root, data);
      const port = 36_200 + Math.floor(Math.random() * 300);
      const child = spawn(
        process.execPath,
        [path.resolve("dist/cli.js"), "--port", String(port), root],
        {
          env: {
            ...process.env,
            AGENT_REWIND_DATA_DIR: data,
            AGENT_REWIND_NO_BROWSER: "1",
          },
          stdio: "pipe",
        },
      );
      try {
        await waitForStderr(child, "Agent Rewind approval UI:");
        const exited = waitForExit(child, 3_000);
        if (mode === "stdin") child.stdin.end();
        else child.kill("SIGTERM");
        await expect(exited).resolves.toEqual({ code: 0, signal: null });
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }
  }, 15_000);

  it("generates a Claude Desktop configuration", () => {
    const root = path.resolve("test-workspace");
    const output = execFileSync(
      process.execPath,
      [path.resolve("dist/cli.js"), "config", "claude", root],
      { encoding: "utf8" },
    );
    const config = JSON.parse(output) as {
      mcpServers: { "filesystem-with-rewind": { command: string; args: string[] } };
    };
    expect(config.mcpServers["filesystem-with-rewind"]).toEqual({
      command: "npm",
      args: [
        "exec",
        "--yes",
        "--package=github:YanhanLi/agent-rewind",
        "--",
        "agent-rewind",
        root,
      ],
    });
  });

  it("generates OpenCode JSON and Codex TOML configurations", () => {
    const root = path.resolve("test-workspace");
    const openCodeOutput = execFileSync(
      process.execPath,
      [path.resolve("dist/cli.js"), "config", "opencode", root],
      { encoding: "utf8" },
    );
    const openCode = JSON.parse(openCodeOutput) as {
      mcp: { "filesystem-with-rewind": { type: string; command: string[] } };
    };
    expect(openCode.mcp["filesystem-with-rewind"]).toMatchObject({
      type: "local",
      command: expect.arrayContaining(["agent-rewind", root]),
    });

    const codex = execFileSync(
      process.execPath,
      [path.resolve("dist/cli.js"), "config", "codex", root],
      { encoding: "utf8" },
    );
    expect(codex).toContain("[mcp_servers.filesystem-with-rewind]");
    expect(codex).toContain(JSON.stringify(root));
  });

  it("installs and uninstalls its Claude entry without removing existing servers", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-cli-"));
    temporaryDirectories.push(directory);
    const filename = path.join(directory, "Claude", "config.json");
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(
      filename,
      JSON.stringify({ mcpServers: { existing: { command: "existing-server" } } }),
    );
    const env = { ...process.env, AGENT_REWIND_CLAUDE_CONFIG: filename };
    const root = path.join(directory, "workspace");
    await mkdir(root);

    const installed = execFileSync(
      process.execPath,
      [path.resolve("dist/cli.js"), "install", "claude", root],
      { encoding: "utf8", env },
    );
    expect(installed).toContain("Updated Claude Desktop configuration");
    const afterInstall = JSON.parse(await readFile(filename, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(afterInstall.mcpServers.existing).toBeDefined();
    expect(afterInstall.mcpServers["filesystem-with-rewind"]).toBeDefined();

    execFileSync(process.execPath, [path.resolve("dist/cli.js"), "uninstall", "claude"], {
      encoding: "utf8",
      env,
    });
    const afterUninstall = JSON.parse(await readFile(filename, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(afterUninstall.mcpServers.existing).toBeDefined();
    expect(afterUninstall.mcpServers["filesystem-with-rewind"]).toBeUndefined();
  });

  it("installs and removes OpenCode and Codex guards in isolated paths", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-guards-cli-"));
    temporaryDirectories.push(directory);
    const openCodeGuard = path.join(directory, "opencode", "agent-rewind-guard.js");
    const codexHooks = path.join(directory, "codex", "hooks.json");
    const codexGuard = path.join(directory, "data", "codex-guard.mjs");
    const env = {
      ...process.env,
      AGENT_REWIND_OPENCODE_GUARD: openCodeGuard,
      AGENT_REWIND_CODEX_HOOKS: codexHooks,
      AGENT_REWIND_CODEX_GUARD: codexGuard,
    };

    execFileSync(process.execPath, [path.resolve("dist/cli.js"), "guard", "opencode"], { env });
    execFileSync(process.execPath, [path.resolve("dist/cli.js"), "guard", "codex"], { env });
    expect(await readFile(openCodeGuard, "utf8")).toContain("tool.execute.before");
    expect(await readFile(codexHooks, "utf8")).toContain("PreToolUse");
    expect(await readFile(codexGuard, "utf8")).toContain("permissionDecision");

    execFileSync(process.execPath, [path.resolve("dist/cli.js"), "unguard", "opencode"], { env });
    execFileSync(process.execPath, [path.resolve("dist/cli.js"), "unguard", "codex"], { env });
    await expect(readFile(openCodeGuard, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(codexGuard, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(codexHooks, "utf8")).not.toContain("apply_patch");
  });
});

function waitForStderr(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (!output.includes(expected)) return;
      cleanup();
      resolve();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Agent Rewind exited early (${code ?? signal}): ${output}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for: ${expected}`));
    }, 5_000);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("Agent Rewind did not exit cleanly"));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}
