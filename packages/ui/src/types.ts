export interface RunSummary {
  id: string;
  workflowType: string;
  status: "running" | "completed" | "failed";
  mode: "live" | "shadow";
  input: unknown;
  parentRunId: string | null;
  forkedFromSeq: number | null;
  forkEdit: unknown;
  timing: {
    createdAt: string;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
  };
}

export interface RunEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RunTask {
  id: string;
  runId: string;
  stepKey: string;
  attempt: number;
  status: string;
  runAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastHeartbeatAt: string | null;
}

export interface RunDetail {
  id: string;
  workflowType: string;
  status: string;
  mode: string;
  input: unknown;
  parentRunId: string | null;
  forkedFromSeq: number | null;
  forkEdit: unknown;
  timing: {
    createdAt: string;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
  };
  events: RunEvent[];
  tasks: RunTask[];
}

export interface EffectDiffItem {
  stepName: string;
  occurrence: number;
  reusedFromParent: boolean;
  inputChangedFromParent: boolean;
  status: "reused" | "modified" | "added" | "live";
  parent: {
    seq?: number;
    input?: unknown;
    result?: unknown;
    effects: Array<{
      kind: string;
      request: unknown;
      wouldHaveResult?: unknown;
      resultSource?: string;
    }>;
  } | null;
  shadow: {
    seq?: number;
    input?: unknown;
    result?: unknown;
    effects: Array<{
      kind: string;
      request: unknown;
      wouldHaveResult?: unknown;
      resultSource?: string;
      reusedFromParent?: boolean;
      inputChangedFromParent?: boolean;
    }>;
  } | null;
}

export interface EffectDiffResponse {
  runId: string;
  isFork: boolean;
  parentRunId: string | null;
  forkedFromSeq: number | null;
  mode: string;
  steps: EffectDiffItem[];
}
