// Thin fetch wrapper around the FastAPI backend.
// Base URL is injected at build time via vite.config.ts → __API_BASE__.

declare const __API_BASE__: string;

export const API_BASE: string =
  (typeof __API_BASE__ !== "undefined" && __API_BASE__) ||
  import.meta.env.VITE_API_BASE ||
  "http://localhost:8088";

async function http<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const headers = new Headers(init?.headers || {});
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(API_BASE + path, { ...init, headers, body });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j?.detail ?? JSON.stringify(j);
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${detail}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export const api = {
  health: () => http<any>("/health"),
  models: () => http<import("./types").ModelsResponse>("/models"),

  listRuns: async () => {
    const j = await http<{ runs: import("./types").RunSummary[] }>("/runs");
    return j.runs || [];
  },
  getRun: (rid: string) =>
    http<{
      run_id: string;
      status: any;
      artifact: any;
    }>(`/runs/${rid}`),
  getRunCVEs: async (rid: string) => {
    const j = await http<{ cves: import("./types").CVERow[] }>(
      `/runs/${rid}/cves`,
    );
    return j.cves || [];
  },
  getCVE: (rid: string, cve: string) =>
    http<import("./types").CVEDetailEnvelope>(`/runs/${rid}/cves/${cve}`),
  getPatch: (rid: string, cve: string) =>
    http<{ repo_root: string; fix: import("./types").FixProposalView }>(
      `/runs/${rid}/cves/${cve}/patch`,
    ),
  applyPatch: (rid: string, cve: string, checkOnly = false) =>
    http<import("./types").ApplyPatchResult>(
      `/runs/${rid}/cves/${cve}/apply_patch`,
      { method: "POST", json: { check_only: checkOnly } },
    ),
  getEvents: async (rid: string, sinceSeq = 0) => {
    const j = await http<{ events: import("./types").RunEvent[] }>(
      `/runs/${rid}/events?since_seq=${sinceSeq}`,
    );
    return j.events || [];
  },
  startRun: (payload: Record<string, unknown>) =>
    http<{ run_id: string }>("/runs/start", { method: "POST", json: payload }),

  cancelRun: (rid: string) =>
    http<{ run_id: string; cancel_requested: boolean }>(
      `/runs/${rid}/cancel`,
      { method: "POST", json: {} },
    ),

  config: () => http<import("./types").ConfigResponse>("/config"),

  listIndexes: async () => {
    const j = await http<{ indexes: import("./types").IndexEntry[] }>(
      "/indexes",
    );
    return j.indexes || [];
  },

  getDecision: (rid: string, cve: string) =>
    http<import("./types").DecisionRecord>(
      `/runs/${rid}/cves/${cve}/decision`,
    ),
  postDecision: (rid: string, cve: string, payload: Record<string, unknown>) =>
    http<import("./types").DecisionRecord>(
      `/runs/${rid}/cves/${cve}/decision`,
      { method: "POST", json: payload },
    ),

  indexStatus: () => http<import("./types").IndexStatus>("/index/status"),
  indexBuild: (payload: Record<string, unknown>) =>
    http<{ state: string }>("/index/build", { method: "POST", json: payload }),

  jenkinsUploadSbom: async (file: File) => {
    const fd = new FormData();
    fd.append("sbom_file", file);
    const res = await fetch(API_BASE + "/jenkins/upload-sbom", {
      method: "POST",
      body: fd,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const j = await res.json();
        detail = j?.detail ?? JSON.stringify(j);
      } catch {
        /* ignore */
      }
      throw new Error(`${res.status} ${detail}`);
    }
    return (await res.json()) as {
      ticket: string;
      filename: string;
      size_bytes: number;
      state: string;
    };
  },

  jenkinsTrigger: (payload: Record<string, unknown>) =>
    http<{ ticket: string; state: string; queue_url?: string }>("/jenkins/trigger", {
      method: "POST",
      json: payload,
    }),

  reportXlsxUrl: (rid: string) => `${API_BASE}/runs/${rid}/report.xlsx`,

  streamUrl: (rid: string) => {
    const wsBase = API_BASE.replace(/^http/i, "ws");
    return `${wsBase}/runs/${rid}/stream`;
  },
};
