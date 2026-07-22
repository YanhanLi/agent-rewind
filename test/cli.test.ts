import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("CLI", () => {
  it("prints its version", () => {
    const output = execFileSync(process.execPath, [path.resolve("dist/cli.js"), "--version"], {
      encoding: "utf8",
    });
    expect(output.trim()).toBe("agent-rewind 0.4.0");
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
      command: "npx",
      args: ["--yes", "github:YanhanLi/agent-rewind", root],
    });
  });
});
