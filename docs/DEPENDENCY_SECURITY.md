# 依赖安全 / Dependency security

## 中文说明

本页如实记录上游依赖告警，而不是依靠仅在仓库根目录生效的 `overrides` 隐藏它们。Agent Rewind 作为另一个项目的依赖安装时，npm 不会传递这类覆盖规则，因此本地开发环境应与真实使用者解析出相同的依赖树。

Agent Rewind 0.28.0 的全新安装可能出现：

- `@modelcontextprotocol/server-filesystem` 声明的 `glob@10.5.0` 弃用告警；
- `@modelcontextprotocol/sdk` 引入的 `@hono/node-server@1.19.14` moderate 告警。npm 可能按受影响的依赖路径多次计算同一条 advisory。

Agent Rewind 不直接调用 `glob`，使用的是 MCP SDK 的 stdio client/server transport，而不是 Hono 的 HTTP 静态文件服务。Hono 告警涉及 Windows 上 `serve-static` 对编码反斜杠的路径穿越，Agent Rewind 当前只支持 macOS。这些事实降低了当前产品中的可达性，但不会消除上游告警。

项目会在官方 MCP 包更新依赖范围后移除这些告警。只在本仓库强制使用 Hono 2 或 glob 13 不是有效修复，因为 npm 使用者仍会获得上游声明的版本。

使用 npm 官方审计端点复核生产依赖：

```bash
npm run audit:high
```

该命令会展示 moderate 告警，但只在出现 high 或 critical 漏洞时失败。部分 npm 镜像没有实现 audit API，因此脚本会明确使用官方 registry。

报告安全问题时，请勿在公开 issue 中附带私有文件内容、快照、审批 URL 或能力令牌；应优先使用 GitHub 仓库的私有 security advisory 流程。

## English

This document records known upstream dependency warnings instead of hiding them with a root-package `overrides` entry. npm does not propagate such overrides when Agent Rewind is installed as another project's dependency, so local development and consumer installs must resolve the same tree.

## Current findings

As of Agent Rewind 0.28.0, a fresh install may show:

- a deprecation warning for `glob@10.5.0`, declared by `@modelcontextprotocol/server-filesystem`;
- moderate findings for `@hono/node-server@1.19.14`, pulled in by `@modelcontextprotocol/sdk` (npm may count the same advisory once for each affected dependency path).

Agent Rewind does not call `glob` directly. It uses the SDK's stdio client and server transports, not Hono's HTTP static-file serving. The Hono advisory concerns encoded-backslash path traversal in `serve-static` on Windows, while Agent Rewind's supported platform is currently macOS. These facts reduce reachability for the current product, but they do not remove the upstream findings.

The project will remove these warnings when the official MCP packages update their dependency ranges. Forcing Hono 2 or glob 13 in this repository is not an acceptable fix because npm consumers would still receive the upstream versions.

## Reproduce

Run the production-dependency gate against npm's official audit endpoint:

```bash
npm run audit:high
```

The command reports moderate findings for visibility but fails only if npm reports a high or critical vulnerability. Some npm mirrors do not implement the audit API; the script therefore selects the official registry explicitly.

For the most representative check, pack Agent Rewind and install the tarball into an empty temporary project. This verifies the dependency tree seen by a real consumer rather than only the repository root.

## Reporting

Do not include private file contents, snapshots, approval URLs, or capability tokens in a public issue. Report a vulnerability through GitHub's private security-advisory flow for the repository when possible.
