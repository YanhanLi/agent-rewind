import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import type { ChangeRecord, ChangeSetPreview, ChangeSetView, PendingApproval } from "./model.js";
import type { RewindService } from "./rewind-service.js";
import { RewindConflictError, SnapshotIntegrityError } from "./snapshot-store.js";

interface Waiter {
  request: PendingApproval;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

const HISTORY_ACTION_PREVIEW_LIMIT = 5;
const HISTORY_PATH_PREVIEW_LIMIT = 5;

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
      process.env.AGENT_REWIND_NO_BROWSER !== "1" &&
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
    setSecurityHeaders(response);
    try {
      const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${this.activePort}`);
      if (request.method === "GET" && requestUrl.pathname === "/") {
        const presentedToken = requestUrl.searchParams.get("token");
        if (presentedToken !== null && presentedToken !== this.token) {
          return this.unauthorized(response);
        }
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(page(presentedToken === this.token ? this.token : undefined));
        return;
      }
      if (!this.authorized(request)) return this.unauthorized(response);
      if (request.method === "GET" && requestUrl.pathname === "/api/state") {
        this.lastHeartbeat = Date.now();
        const changeSets = this.rewind.listChangeSets();
        response.end(
          JSON.stringify({
            pending: [...this.pending.values()].map(({ request: item }) => item),
            changes: this.rewind.list().map(publicChange),
            changeSets: changeSets.map((changeSet) => publicChangeSet(changeSet)),
            recovered: changeSets
              .filter((changeSet) => changeSet.recoveryStatus === "pending")
              .map((changeSet) => publicChangeSet(changeSet)),
          }),
        );
        return;
      }
      const changeSetDetails = requestUrl.pathname.match(/^\/api\/change-sets\/([^/]+)$/);
      if (request.method === "GET" && changeSetDetails) {
        const id = decodeURIComponent(changeSetDetails[1]);
        const changeSet = this.rewind.getChangeSet(id);
        if (!changeSet) throw new Error(`Unknown change set: ${id}`);
        response.end(JSON.stringify(publicChangeSet(changeSet, false)));
        return;
      }
      const recoveryPreview = requestUrl.pathname.match(
        /^\/api\/change-sets\/([^/]+)\/recovery-preview$/,
      );
      if (request.method === "GET" && recoveryPreview) {
        response.end(
          JSON.stringify({ previews: await this.rewind.recoveryPreviews(recoveryPreview[1]) }),
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
      const undoReadiness = requestUrl.pathname.match(
        /^\/api\/change-sets\/([^/]+)\/undo-readiness$/,
      );
      if (request.method === "GET" && undoReadiness) {
        response.end(JSON.stringify(await this.rewind.checkUndoReadiness(undoReadiness[1])));
        return;
      }
      const reviewSet = requestUrl.pathname.match(/^\/api\/change-sets\/([^/]+)\/review$/);
      if (request.method === "POST" && reviewSet) {
        response.end(JSON.stringify(await this.rewind.reviewRecoveredChangeSet(reviewSet[1])));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      if (error instanceof SnapshotIntegrityError) {
        process.stderr.write(`Agent Rewind snapshot verification failed: ${error.message}\n`);
      }
      const failure = publicApiError(error);
      response.statusCode = failure.status;
      response.end(
        JSON.stringify({
          error: failure.message,
          code: failure.code,
          ...(failure.target ? { target: failure.target } : {}),
        }),
      );
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

function publicChange(record: ChangeRecord) {
  return {
    id: record.id,
    changeSetId: record.changeSetId,
    changeSetLabel: record.changeSetLabel,
    tool: record.tool,
    summary: record.summary,
    createdAt: record.createdAt,
    status: record.status,
    recoveredAt: record.recoveredAt,
    reviewedAt: record.reviewedAt,
    paths: record.paths.map((change) => change.path),
  };
}

function publicChangeSet(changeSet: ChangeSetPreview | ChangeSetView, preview = true) {
  const affectedPaths = preview
    ? changeSet.affectedPaths.slice(0, HISTORY_PATH_PREVIEW_LIMIT)
    : changeSet.affectedPaths;
  const changes = preview
    ? changeSet.changes.slice(0, HISTORY_ACTION_PREVIEW_LIMIT)
    : changeSet.changes;
  return {
    id: changeSet.id,
    label: changeSet.label,
    createdAt: changeSet.createdAt,
    updatedAt: changeSet.updatedAt,
    status: changeSet.status,
    recoveryStatus: changeSet.recoveryStatus,
    actionCount: changeSet.actionCount,
    affectedPathCount:
      preview && "affectedPathCount" in changeSet
        ? changeSet.affectedPathCount
        : changeSet.affectedPaths.length,
    affectedPaths,
    changes: changes.map(publicChange),
    detailsTruncated:
      preview && "detailsTruncated" in changeSet
        ? changeSet.detailsTruncated
        : affectedPaths.length < changeSet.affectedPaths.length ||
          changes.length < changeSet.changes.length,
  };
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

function publicApiError(error: unknown): {
  status: number;
  code: string;
  message: string;
  target?: string;
} {
  if (error instanceof RewindConflictError) {
    return {
      status: 409,
      code: "undo_conflict",
      message: `Undo stopped because this path changed after the Agent action: ${error.target}. Your newer content was not overwritten.`,
      target: error.target,
    };
  }
  if (error instanceof SnapshotIntegrityError) {
    return {
      status: 422,
      code: "snapshot_integrity",
      message:
        "Undo stopped because a recovery snapshot could not be verified. Unverified content was not written; check the terminal for details.",
    };
  }
  return {
    status: 409,
    code: "request_failed",
    message: error instanceof Error ? error.message : "The request could not be completed.",
  };
}

function page(token?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">
<title>Agent Rewind</title><style>
:root{font-family:ui-sans-serif,system-ui;color:#171717;background:#f5f5f4}*{box-sizing:border-box}body{margin:0;overflow-x:hidden}header{background:#171717;color:white;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px}h1{font-size:18px;margin:0;letter-spacing:0;white-space:nowrap}main{width:100%;max-width:920px;margin:28px auto;padding:0 18px}h2{font-size:14px;text-transform:uppercase;color:#666;margin:26px 0 10px}.feedback{display:none;margin:0 0 18px;color:#991b1b;background:#fef2f2;border-left:3px solid #dc2626;padding:11px 12px;font-size:13px;line-height:1.45;overflow-wrap:anywhere}.feedback.visible{display:block}.item{width:100%;background:white;border:1px solid #ddd;border-radius:6px;padding:16px;margin:10px 0;min-width:0}.recovered{border-color:#d97706}.notice{margin:12px 0;color:#7c2d12;background:#fffbeb;border-left:3px solid #d97706;padding:10px 12px;font-size:13px;line-height:1.45}.readiness{margin:12px 0 0;border-left:3px solid #a3a3a3;padding:8px 10px;color:#525252;background:#fafafa;font-size:12px;line-height:1.45;overflow-wrap:anywhere}.readiness.ready{border-color:#15803d;color:#166534;background:#f0fdf4}.readiness.conflict{border-color:#dc2626;color:#991b1b;background:#fef2f2}.readiness.snapshot_integrity{border-color:#d97706;color:#92400e;background:#fffbeb}.preview{margin-top:12px}.preview pre{margin:6px 0 0;background:#fafafa;white-space:pre;overflow-wrap:normal}.row{display:flex;gap:10px;align-items:center;justify-content:space-between;min-width:0}.row>div{min-width:0}.row>div:last-child{display:flex;gap:5px;flex:none}.summary{max-width:100%;font-weight:650;overflow-wrap:anywhere}.meta{max-width:100%;font:12px ui-monospace,monospace;color:#777;margin-top:5px;overflow-wrap:anywhere}.actions{margin-top:12px;border-top:1px solid #e7e5e4}.action{padding:9px 0;border-bottom:1px solid #eee;font-size:13px;overflow-wrap:anywhere}.action:last-child{border-bottom:0}.paths{margin-top:8px;color:#555;font-size:12px;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f4;border:1px solid #e7e5e4;padding:12px;font-size:12px;max-height:300px;max-width:100%;overflow:auto}button{border:0;border-radius:5px;padding:8px 13px;min-height:32px;font-weight:650;cursor:pointer;white-space:nowrap}button:disabled{cursor:wait;opacity:.55}.approve,.keep{background:#15803d;color:white}.reject{background:#dc2626;color:white}.undo{background:#171717;color:white}.empty{color:#777;padding:22px 0}.status{font-size:12px;padding:3px 7px;background:#eee;border-radius:4px}.recovery-status{background:#fef3c7;color:#92400e}@media(max-width:600px){header{padding:16px 18px}header span{display:none}main{margin:18px 0;padding:0 12px;max-width:100vw}.item{padding:16px;max-width:calc(100vw - 24px);overflow:hidden}.row{width:100%;max-width:100%;align-items:stretch;flex-direction:column;overflow:hidden}.row>div:first-child{width:100%;max-width:100%}.summary{word-break:break-all}.row>div:last-child{width:100%;max-width:100%;display:grid;grid-template-columns:minmax(0,1fr);margin-top:4px}.row button{padding:8px 6px;font-size:12px;width:100%;white-space:normal;overflow-wrap:anywhere}}
</style></head><body><header><h1>Agent Rewind</h1><span>Local approval and recovery</span></header><main><div id="feedback" class="feedback" role="status" aria-live="polite"></div><h2>Waiting for approval</h2><div id="pending"></div><h2>Recovered changes</h2><div id="recovered"></div><h2>Change history</h2><div id="history"></div></main><script>
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bootstrapToken=${JSON.stringify(token ?? null)};if(bootstrapToken){sessionStorage.setItem('agent-rewind-token',bootstrapToken);history.replaceState(null,'',location.pathname)}const token=bootstrapToken||sessionStorage.getItem('agent-rewind-token')||'';const headers={'X-Agent-Rewind-Token':token};
const previewCache=new Map();const readinessCache=new Map();const detailsCache=new Map();let actionInFlight=false;
const pathCount=x=>x.affectedPathCount??x.affectedPaths.length;const countSummary=x=>x.actionCount+' action'+(x.actionCount===1?'':'s')+' across '+pathCount(x)+' path'+(pathCount(x)===1?'':'s');
const setTitle=x=>x.label?esc(x.label):countSummary(x);const setMeta=x=>(x.label?countSummary(x)+' · ':'')+new Date(x.createdAt).toLocaleString()+' · change set '+esc(x.id.slice(0,8));
const feedback=document.querySelector('#feedback');const showError=message=>{feedback.textContent=message;feedback.classList.add('visible')};const clearError=()=>{feedback.textContent='';feedback.classList.remove('visible')};
const syncBusy=()=>document.querySelectorAll('button').forEach(button=>button.disabled=actionInFlight);
async function post(url,button){if(actionInFlight)return;actionInFlight=true;clearError();if(button)button.disabled=true;try{const r=await fetch(url,{method:'POST',headers});const body=await r.json();if(!r.ok){showError(body.error||'The action could not be completed.');return}readinessCache.clear();detailsCache.clear()}catch{showError('Agent Rewind could not reach its local service.')}finally{actionInFlight=false;await refresh()}}
const postSet=(button,action)=>post('/api/change-sets/'+encodeURIComponent(button.dataset.setId)+'/'+action,button);
async function checkUndo(button){if(actionInFlight)return;actionInFlight=true;clearError();button.disabled=true;const id=button.dataset.setId;const key=button.dataset.stateKey;try{const r=await fetch('/api/change-sets/'+encodeURIComponent(id)+'/undo-readiness',{headers});const body=await r.json();if(!r.ok){showError(body.error||'Undo readiness could not be checked.');return}readinessCache.set(id,{key,result:body})}catch{showError('Agent Rewind could not reach its local service.')}finally{actionInFlight=false;await refresh()}}
async function loadDetails(button){if(actionInFlight)return;actionInFlight=true;clearError();button.disabled=true;const id=button.dataset.setId;try{const r=await fetch('/api/change-sets/'+encodeURIComponent(id),{headers});const body=await r.json();if(!r.ok){showError(body.error||'Change-set details could not be loaded.');return}detailsCache.set(id,{key:stateKey(body),result:body})}catch{showError('Agent Rewind could not reach its local service.')}finally{actionInFlight=false;await refresh()}}
const actions=x=>{const cached=detailsCache.get(x.id);const d=cached?.key===stateKey(x)?cached.result:x;const morePaths=pathCount(d)-d.affectedPaths.length;const moreActions=d.actionCount-d.changes.length;const more=[];if(morePaths>0)more.push(morePaths+' more path'+(morePaths===1?'':'s'));if(moreActions>0)more.push(moreActions+' more action'+(moreActions===1?'':'s'));return \`<div class="paths">\${d.affectedPaths.map(esc).join('<br>')}\${morePaths>0?'…<br>':''}</div><div class="actions">\${d.changes.map(c=>\`<div class="action">\${esc(c.summary)}</div>\`).join('')}</div>\${more.length?\`<div class="meta">\${esc(more.join(' and '))} not loaded.</div><button data-set-id="\${esc(x.id)}" onclick="loadDetails(this)">Load all details</button>\`:''}\`};
const canUndo=x=>x.status==='applied'||x.status==='partial'||x.status==='conflict';const stateKey=x=>x.status+'|'+x.updatedAt;const readiness=x=>{const cached=readinessCache.get(x.id);if(!cached||cached.key!==stateKey(x))return '<div class="readiness">Undo readiness has not been checked. Checking reads current paths and verifies required local snapshots.</div>';const r=cached.result;return \`<div class="readiness \${esc(r.status)}">\${esc(r.message)}\${r.target?' '+esc(r.target):''} Checked \${new Date(r.checkedAt).toLocaleTimeString()}; execution will verify again.</div>\`};
const undoControls=x=>canUndo(x)?\`<button data-set-id="\${esc(x.id)}" data-state-key="\${esc(stateKey(x))}" onclick="checkUndo(this)">\${readinessCache.has(x.id)?'Check again':'Check undo'}</button><button class="undo" data-set-id="\${esc(x.id)}" onclick="postSet(this,'undo')">Undo set</button>\`:'';
const historyCard=x=>\`<div class="item"><div class="row"><div><div class="summary">\${setTitle(x)}</div><div class="meta">\${setMeta(x)}</div></div><div><span class="status">\${esc(x.status)}</span> \${undoControls(x)}</div></div>\${canUndo(x)?readiness(x):''}\${actions(x)}</div>\`;
const recoveredCard=x=>{const previews=previewCache.get(x.id);return \`<div class="item recovered"><div class="row"><div><div class="summary">\${setTitle(x)}</div><div class="meta">\${setMeta(x)}</div></div><div><span class="status recovery-status">needs review</span>\${undoControls(x)}<button class="keep" data-set-id="\${esc(x.id)}" onclick="postSet(this,'review')">Keep changes</button></div></div><div class="notice">Agent Rewind found this change after an interrupted operation. Review the snapshot-backed evidence before keeping or undoing it.</div>\${canUndo(x)?readiness(x):''}\${previews?previews.map(p=>\`<div class="preview"><div class="meta">\${esc(p.path)} · \${esc(p.kind)}</div><pre>\${esc(p.detail)}</pre></div>\`).join(''):'<div class="meta">Loading snapshot evidence...</div>'}\${actions(x)}</div>\`};
async function renderRecovered(items){document.querySelector('#recovered').innerHTML=items.length?items.map(recoveredCard).join(''):'<div class="empty">No interrupted changes need review.</div>';syncBusy();await Promise.all(items.filter(x=>!previewCache.has(x.id)).map(async x=>{try{const r=await fetch('/api/change-sets/'+encodeURIComponent(x.id)+'/recovery-preview',{headers});if(r.ok)previewCache.set(x.id,(await r.json()).previews)}catch{}}));document.querySelector('#recovered').innerHTML=items.length?items.map(recoveredCard).join(''):'<div class="empty">No interrupted changes need review.</div>';syncBusy()}
async function refresh(){let r;try{r=await fetch('/api/state',{headers})}catch{return}if(!r.ok)return;const s=await r.json();document.querySelector('#pending').innerHTML=s.pending.length?s.pending.map(x=>\`<div class="item"><div class="row"><div><div class="summary">\${esc(x.summary)}</div><div class="meta">\${esc(x.tool)} · expires \${new Date(x.expiresAt).toLocaleTimeString()}\${x.changeSetLabel?' · '+esc(x.changeSetLabel):''}</div></div><div><button class="reject" onclick="post('/api/approvals/\${x.id}/reject',this)">Reject</button> \${x.changeSetId?\`<button onclick="post('/api/approvals/\${x.id}/approve-set',this)">Allow set</button>\`:''} <button onclick="post('/api/approvals/\${x.id}/approve-session',this)">Allow in folder</button> <button class="approve" onclick="post('/api/approvals/\${x.id}/approve',this)">Approve</button></div></div><div class="meta">Scope: \${esc(x.scope)}</div><pre>\${esc(x.detail)}</pre></div>\`).join(''):'<div class="empty">No actions are waiting.</div>';syncBusy();await renderRecovered(s.recovered);const history=s.changeSets.filter(x=>x.recoveryStatus!=='pending');document.querySelector('#history').innerHTML=history.length?history.map(historyCard).join(''):'<div class="empty">No recorded changes yet.</div>';syncBusy()}if(token){refresh();setInterval(refresh,1000)}else{showError('This page has no active Agent Rewind session. Open it from the current Agent Rewind process.')}
</script></body></html>`;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}
