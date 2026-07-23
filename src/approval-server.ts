import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import type { PendingApproval } from "./model.js";
import type { RewindService } from "./rewind-service.js";

interface Waiter {
  request: PendingApproval;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalServer {
  private readonly pending = new Map<string, Waiter>();
  private readonly sessionRules: Array<{ tool: string; scope: string }> = [];
  private readonly changeSetRules = new Map<string, string>();
  private readonly token = process.env.AGENT_REWIND_TOKEN ?? randomBytes(24).toString("base64url");
  private httpServer?: Server;
  private activePort = 0;
  private lastHeartbeat = 0;
  private lastBrowserOpen = 0;

  constructor(
    private readonly rewind: RewindService,
    private readonly requestedPort: number,
    private readonly timeoutMs = 120_000,
    private readonly openBrowser: (url: string) => void = (url) => {
      execFile("open", [url]);
    },
    private readonly platform = process.platform,
  ) {}

  async start(): Promise<void> {
    let lastError: Error | undefined;
    for (let candidate = this.requestedPort; candidate <= this.requestedPort + 20; candidate += 1) {
      try {
        this.httpServer = await this.listen(candidate);
        this.activePort = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
        lastError = error as Error;
      }
    }
    if (!this.httpServer) throw lastError ?? new Error("No approval UI port is available");
    process.stderr.write(`Agent Rewind approval UI: ${this.url()}\n`);
  }

  request(input: Omit<PendingApproval, "id" | "expiresAt">): Promise<boolean> {
    this.rewind.recordEvent({ type: "approval_requested", tool: input.tool });
    if (
      this.sessionRules.some((rule) => matchesRule(rule, input)) ||
      matchesChangeSetRule(this.changeSetRules, input)
    ) {
      this.rewind.recordEvent({ type: "approval_auto_approved", tool: input.tool });
      return Promise.resolve(true);
    }
    const id = randomUUID();
    const request = {
      ...input,
      id,
      expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(),
    };
    const now = Date.now();
    if (
      this.platform === "darwin" &&
      now - this.lastHeartbeat > 3_000 &&
      now - this.lastBrowserOpen > 3_000
    ) {
      this.lastBrowserOpen = now;
      this.openBrowser(this.url());
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.rewind.recordEvent({ type: "approval_expired", tool: request.tool });
        resolve(false);
      }, this.timeoutMs);
      this.pending.set(id, { request, resolve, timer });
    });
  }

  get port(): number {
    return this.activePort;
  }

  endChangeSet(id: string): void {
    this.changeSetRules.delete(id);
  }

  async stop(): Promise<void> {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
      this.pending.delete(id);
    }
    if (!this.httpServer) return;
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.close((error) => (error ? reject(error) : resolve()));
    });
    this.httpServer = undefined;
  }

  private url(): string {
    return `http://127.0.0.1:${this.activePort}/?token=${encodeURIComponent(this.token)}`;
  }

  private listen(port: number): Promise<Server> {
    return new Promise<Server>((resolve, reject) => {
      const server = createServer((request, response) => void this.route(request, response));
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve(server);
      });
    });
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    try {
      const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${this.activePort}`);
      if (request.method === "GET" && requestUrl.pathname === "/") {
        if (requestUrl.searchParams.get("token") !== this.token) return this.unauthorized(response);
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(page(this.token));
        return;
      }
      if (!this.authorized(request)) return this.unauthorized(response);
      if (request.method === "GET" && requestUrl.pathname === "/api/state") {
        this.lastHeartbeat = Date.now();
        response.end(
          JSON.stringify({
            pending: [...this.pending.values()].map(({ request: item }) => item),
            changes: this.rewind.list(),
            changeSets: this.rewind.listChangeSets(),
          }),
        );
        return;
      }
      const approval = requestUrl.pathname.match(
        /^\/api\/approvals\/([^/]+)\/(approve|approve-session|approve-set|reject)$/,
      );
      if (request.method === "POST" && approval) {
        const waiter = this.pending.get(approval[1]);
        if (!waiter) throw new Error("Approval request no longer exists");
        if (approval[2] === "approve-set" && !waiter.request.changeSetId) {
          throw new Error("This action is not part of an explicit change set");
        }
        this.pending.delete(approval[1]);
        clearTimeout(waiter.timer);
        if (approval[2] === "approve-set") {
          this.changeSetRules.set(waiter.request.changeSetId!, waiter.request.scope);
          this.rewind.recordEvent({
            type: "approval_change_set_approved",
            tool: waiter.request.tool,
          });
        } else if (approval[2] === "approve-session") {
          this.sessionRules.push({ tool: waiter.request.tool, scope: waiter.request.scope });
          this.rewind.recordEvent({
            type: "approval_session_approved",
            tool: waiter.request.tool,
          });
        } else {
          this.rewind.recordEvent({
            type: approval[2] === "reject" ? "approval_rejected" : "approval_approved",
            tool: waiter.request.tool,
          });
        }
        waiter.resolve(approval[2] !== "reject");
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      const undo = requestUrl.pathname.match(/^\/api\/changes\/([^/]+)\/undo$/);
      if (request.method === "POST" && undo) {
        response.end(JSON.stringify(await this.rewind.undo(undo[1])));
        return;
      }
      const undoSet = requestUrl.pathname.match(/^\/api\/change-sets\/([^/]+)\/undo$/);
      if (request.method === "POST" && undoSet) {
        response.end(JSON.stringify(await this.rewind.undoChangeSet(undoSet[1])));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      response.statusCode = 409;
      response.end(JSON.stringify({ error: (error as Error).message }));
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${this.activePort}`) return false;
    return request.headers["x-agent-rewind-token"] === this.token;
  }

  private unauthorized(response: ServerResponse): void {
    response.statusCode = 403;
    response.end(JSON.stringify({ error: "Forbidden" }));
  }
}

function matchesRule(
  rule: { tool: string; scope: string },
  request: Pick<PendingApproval, "tool" | "paths">,
): boolean {
  if (rule.tool !== request.tool) return false;
  return request.paths.every((target) => {
    const relative = path.relative(rule.scope, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function matchesChangeSetRule(
  rules: Map<string, string>,
  request: Pick<PendingApproval, "changeSetId" | "paths">,
): boolean {
  if (!request.changeSetId) return false;
  const scope = rules.get(request.changeSetId);
  if (!scope) return false;
  return request.paths.every((target) => {
    const relative = path.relative(scope, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function page(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Rewind</title><style>
:root{font-family:ui-sans-serif,system-ui;color:#171717;background:#f5f5f4}*{box-sizing:border-box}body{margin:0;overflow-x:hidden}header{background:#171717;color:white;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px}h1{font-size:18px;margin:0;letter-spacing:0;white-space:nowrap}main{width:100%;max-width:920px;margin:28px auto;padding:0 18px}h2{font-size:14px;text-transform:uppercase;color:#666;margin:26px 0 10px}.item{width:100%;background:white;border:1px solid #ddd;border-radius:6px;padding:16px;margin:10px 0;min-width:0}.row{display:flex;gap:10px;align-items:center;justify-content:space-between;min-width:0}.row>div{min-width:0}.row>div:last-child{display:flex;gap:5px;flex:none}.summary{max-width:100%;font-weight:650;overflow-wrap:anywhere}.meta{max-width:100%;font:12px ui-monospace,monospace;color:#777;margin-top:5px;overflow-wrap:anywhere}.actions{margin-top:12px;border-top:1px solid #e7e5e4}.action{padding:9px 0;border-bottom:1px solid #eee;font-size:13px;overflow-wrap:anywhere}.action:last-child{border-bottom:0}.paths{margin-top:8px;color:#555;font-size:12px;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f4;border:1px solid #e7e5e4;padding:12px;font-size:12px;max-height:300px;max-width:100%;overflow:auto}button{border:0;border-radius:5px;padding:8px 13px;min-height:32px;font-weight:650;cursor:pointer;white-space:nowrap}.approve{background:#15803d;color:white}.reject{background:#dc2626;color:white}.undo{background:#171717;color:white}.empty{color:#777;padding:22px 0}.status{font-size:12px;padding:3px 7px;background:#eee;border-radius:4px}@media(max-width:600px){header{padding:16px 18px}header span{display:none}main{margin:18px 0;padding:0 12px;max-width:100vw}.item{padding:16px;max-width:calc(100vw - 24px);overflow:hidden}.row{width:100%;max-width:100%;align-items:stretch;flex-direction:column;overflow:hidden}.row>div:first-child{width:100%;max-width:100%}.summary{word-break:break-all}.row>div:last-child{width:100%;max-width:100%;display:grid;grid-template-columns:minmax(0,1fr);margin-top:4px}.row button{padding:8px 6px;font-size:12px;width:100%;white-space:normal;overflow-wrap:anywhere}}
</style></head><body><header><h1>Agent Rewind</h1><span>Local approval and recovery</span></header><main><h2>Waiting for approval</h2><div id="pending"></div><h2>Change history</h2><div id="history"></div></main><script>
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const token=${JSON.stringify(token)};const headers={'X-Agent-Rewind-Token':token};
const countSummary=x=>x.actionCount+' action'+(x.actionCount===1?'':'s')+' across '+x.affectedPaths.length+' path'+(x.affectedPaths.length===1?'':'s');
const setTitle=x=>x.label?esc(x.label):countSummary(x);const setMeta=x=>(x.label?countSummary(x)+' · ':'')+new Date(x.createdAt).toLocaleString()+' · change set '+esc(x.id.slice(0,8));
async function post(url){const r=await fetch(url,{method:'POST',headers});const body=await r.json();if(!r.ok)alert(body.error);await refresh()}
async function refresh(){const r=await fetch('/api/state',{headers});if(!r.ok)return;const s=await r.json();document.querySelector('#pending').innerHTML=s.pending.length?s.pending.map(x=>\`<div class="item"><div class="row"><div><div class="summary">\${esc(x.summary)}</div><div class="meta">\${esc(x.tool)} · expires \${new Date(x.expiresAt).toLocaleTimeString()}\${x.changeSetLabel?' · '+esc(x.changeSetLabel):''}</div></div><div><button class="reject" onclick="post('/api/approvals/\${x.id}/reject')">Reject</button> \${x.changeSetId?\`<button onclick="post('/api/approvals/\${x.id}/approve-set')">Allow set</button>\`:''} <button onclick="post('/api/approvals/\${x.id}/approve-session')">Allow in folder</button> <button class="approve" onclick="post('/api/approvals/\${x.id}/approve')">Approve</button></div></div><div class="meta">Scope: \${esc(x.scope)}</div><pre>\${esc(x.detail)}</pre></div>\`).join(''):'<div class="empty">No actions are waiting.</div>';document.querySelector('#history').innerHTML=s.changeSets.length?s.changeSets.map(x=>\`<div class="item"><div class="row"><div><div class="summary">\${setTitle(x)}</div><div class="meta">\${setMeta(x)}</div></div><div><span class="status">\${esc(x.status)}</span> \${x.status==='applied'?\`<button class="undo" onclick="post('/api/change-sets/\${x.id}/undo')">Undo set</button>\`:''}</div></div><div class="paths">\${x.affectedPaths.map(esc).join('<br>')}</div><div class="actions">\${x.changes.map(c=>\`<div class="action">\${esc(c.summary)}</div>\`).join('')}</div></div>\`).join(''):'<div class="empty">No recorded changes yet.</div>'}refresh();setInterval(refresh,1000);
</script></body></html>`;
}
