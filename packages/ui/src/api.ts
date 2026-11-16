import type { EffectDiffResponse, RunDetail, RunsResponse } from "./types.js";

const API_BASE = "/api";

export async function getRuns(params?: {
  status?: string;
  mode?: string;
  limit?: number;
}): Promise<RunsResponse> {
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  if (params?.mode) query.set("mode", params.mode);
  if (params?.limit) query.set("limit", String(params.limit));

  const qs = query.toString();
  const url = `${API_BASE}/runs${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch runs: ${res.statusText}`);
  }
  return res.json();
}

export async function getRun(id: string): Promise<RunDetail> {
  const res = await fetch(`${API_BASE}/runs/${id}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch run ${id}: ${res.statusText}`);
  }
  return res.json();
}

export async function getEffects(id: string): Promise<EffectDiffResponse> {
  const res = await fetch(`${API_BASE}/runs/${id}/effects`);
  if (!res.ok) {
    throw new Error(`Failed to fetch effects for run ${id}: ${res.statusText}`);
  }
  return res.json();
}

export async function forkRun(
  runId: string,
  payload: {
    atSeq: number;
    edit: {
      input?: unknown;
      result?: unknown;
      mocks?: Array<{ stepName: string; occurrence?: number; result: unknown }>;
    };
  },
  apiToken?: string,
): Promise<{
  runId: string;
  forkRunId: string;
  parentRunId?: string;
  forkedFromSeq?: number;
  warnings?: string[];
}> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiToken) {
    headers.Authorization = `Bearer ${apiToken}`;
  }
  const res = await fetch(`${API_BASE}/runs/${runId}/fork`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Fork failed: ${res.statusText}`);
  }
  return res.json();
}
