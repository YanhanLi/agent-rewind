export type EntryState =
  | { kind: "missing"; hash: string }
  | { kind: "file"; hash: string; blob: string; size: number }
  | { kind: "directory"; hash: string; entries: string[] };

export interface PathChange {
  path: string;
  before: EntryState;
  after: EntryState;
}

export interface ChangeRecord {
  id: string;
  changeSetId: string;
  changeSetLabel?: string;
  tool: string;
  summary: string;
  createdAt: string;
  status: "applied" | "undone" | "conflict";
  paths: PathChange[];
}

export interface ChangeSetView {
  id: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
  status: "applied" | "undone" | "conflict" | "partial";
  actionCount: number;
  affectedPaths: string[];
  changes: ChangeRecord[];
}

export interface PendingApproval {
  id: string;
  tool: string;
  summary: string;
  detail: string;
  arguments: unknown;
  paths: string[];
  scope: string;
  changeSetId?: string;
  changeSetLabel?: string;
  expiresAt: string;
}

export type LocalEventType =
  | "approval_requested"
  | "approval_approved"
  | "approval_session_approved"
  | "approval_change_set_approved"
  | "approval_auto_approved"
  | "approval_rejected"
  | "approval_expired"
  | "change_applied"
  | "undo_started"
  | "undo_succeeded"
  | "undo_conflict";

export interface LocalEvent {
  type: LocalEventType;
  tool?: string;
  target?: "change" | "change_set";
}

export interface ValidationReport {
  generatedAt: string;
  period: { firstEventAt: string | null; lastEventAt: string | null };
  approvals: {
    requested: number;
    approved: number;
    sessionApproved: number;
    changeSetApproved: number;
    autoApproved: number;
    rejected: number;
    expired: number;
  };
  changes: {
    changeSets: number;
    actions: number;
    applied: number;
    undone: number;
    conflicts: number;
  };
  undo: { attempted: number; succeeded: number; conflicts: number };
  tools: Record<string, number>;
}
