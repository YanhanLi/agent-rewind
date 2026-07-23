export type EntryState =
  | { kind: "missing"; hash: string }
  | { kind: "file"; hash: string; blob: string; size: number }
  | { kind: "directory"; hash: string; entries: string[]; children?: Record<string, EntryState> };

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
  recoveredAt?: string;
  reviewedAt?: string;
  status: "applied" | "undone" | "conflict";
  paths: PathChange[];
}

export interface ChangeIntent {
  id: string;
  changeSetId: string;
  changeSetLabel?: string;
  tool: string;
  summary: string;
  createdAt: string;
  paths: Array<{ path: string; before: EntryState }>;
}

export interface ChangeSetView {
  id: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
  status: "applied" | "undone" | "conflict" | "partial";
  recoveryStatus?: "pending" | "reviewed";
  actionCount: number;
  affectedPaths: string[];
  changes: ChangeRecord[];
}

export interface ChangeSetPreview extends Omit<ChangeSetView, "affectedPaths" | "changes"> {
  affectedPathCount: number;
  affectedPaths: string[];
  changes: ChangeRecord[];
  detailsTruncated: boolean;
}

export interface RecoveryPreview {
  path: string;
  kind: "text" | "summary";
  detail: string;
}

export interface UndoReadiness {
  status: "ready" | "conflict" | "snapshot_integrity" | "unavailable";
  checkedAt: string;
  message: string;
  target?: string;
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
  | "intent_recovered"
  | "intent_discarded"
  | "recovery_reviewed"
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
  recovery: { recovered: number; discarded: number; reviewed: number };
  tools: Record<string, number>;
}
