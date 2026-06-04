// Type definitions matching backend payloads in apps/workflow_d/api.py.
// Kept loose (optional fields) because the backend grows; the UI must
// tolerate missing properties without crashing.

export type Verdict =
  | "package_upgrade"
  | "code_change"
  | "not_applicable"
  | "needs_human"
  | "unknown";

export interface RunSummary {
  run_id: string;
  artifact_path?: string;
  events_path?: string;
  mtime?: number;
  // Present only for in-flight runs (from the API registry)
  state?: "running" | "completed" | "failed" | "cancelled" | string;
  started_at?: number;
  ended_at?: number;
  totals?: Record<string, number>;
  error?: string;
  // Enrichment from <rid>.start.json (persisted by /runs/start).
  project?: string;
  index_id?: string | null;
  vulns_path?: string;
  total_cves?: number;
}

export interface IndexEntry {
  index_id: string;
  name: string;
  source?: string | null;
  repo_root?: string | null;
  git_url?: string | null;
  branch?: string | null;
  files_indexed?: number;
  chunks?: number;
  created_at?: number;
  updated_at?: number;
  path?: string;
  legacy?: boolean;
}

export interface ConfigResponse {
  max_parallel_cves: number;
  default_parallel_cves: number;
  worker_choices: number[];
  default_repo_root?: string | null;
  default_severities: string[];
  models: { author?: string | null; verifier?: string | null };
}

export interface RunEvent {
  run_id: string;
  seq: number;
  ts: number;
  event: string;
  data: Record<string, unknown>;
}

export interface CVERow {
  cve_id: string;
  verdict: Verdict | string;
  model_verdict?: Verdict | string | null;
  human_action?: string | null;
  human_verdict?: Verdict | string | null;
  human_actor?: string | null;
  human_note?: string | null;
  component?: string;
  version?: string;
  severity?: string;
  state?: "queued" | "running" | "completed" | "failed" | string;
  decision?: string;
  has_patch?: boolean;
  files_touched?: string[];
  lines_added?: number;
  lines_removed?: number;
  rationale?: string;
}

export interface CVEDetailEnvelope {
  cve_id: string;
  verdict?: Verdict | string;
  payload?: Record<string, any>;
  // Backend returns the raw per-CVE JSON bundle. We treat it as `any` and
  // pull human-friendly fields opportunistically.
  [k: string]: any;
}

export interface FixProposalView {
  patch_unified_diff: string;
  files_touched: string[];
  lines_added: number;
  lines_removed: number;
  rationale: string;
  fix_confidence: number;
  verdict_override?: string | null;
}

export interface ApplyPatchResult {
  ok: boolean;
  check_only: boolean;
  repo_root: string;
  files_touched: string[];
  stdout: string;
  stderr: string;
  returncode: number;
}

export interface ModelsResponse {
  models: string[];
  author_default?: string | null;
  verifier_default?: string | null;
  source: "proxy" | "config" | "default";
  proxy_error?: string | null;
}

export interface IndexStatus {
  index_dir: string;
  present: boolean;
  files_indexed?: number;
  chunks?: number;
  repo_root?: string;
  running: boolean;
  last?: any;
  indexes?: IndexEntry[];
}

export interface DecisionRecord {
  run_id: string;
  cve_id: string;
  latest: null | {
    ts: number;
    actor: string;
    action: "approve" | "reject" | "reassign" | "note";
    new_verdict?: string | null;
    note?: string;
  };
  history: Array<NonNullable<DecisionRecord["latest"]>>;
}
