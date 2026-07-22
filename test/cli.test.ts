import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(output.trim()).toBe("agent-rewind 0.6.0");
  });

  it("prints an empty local validation report as JSON", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-rewind-report-"));
    temporaryDirectories.push(directory);
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
    expect(report.approvals.requested).toBe(0);
    expect(report.changes.actions).toBe(0);
  });

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
});
