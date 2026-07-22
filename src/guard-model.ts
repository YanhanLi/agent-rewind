export interface GuardUpdateResult {
  changed: boolean;
  files: string[];
  preview: Record<string, string>;
}

export type GuardState = "configured" | "missing" | "conflict";
