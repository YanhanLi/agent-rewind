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
  tool: string;
  summary: string;
  createdAt: string;
  status: "applied" | "undone" | "conflict";
  paths: PathChange[];
}

export interface PendingApproval {
  id: string;
  tool: string;
  summary: string;
  detail: string;
  arguments: unknown;
  paths: string[];
  scope: string;
  expiresAt: string;
}
