/**
 * Central runtime configuration.
 *
 * All values are read from Vite env vars (VITE_*) so they can be overridden
 * per environment without code changes:
 *
 *   - .env.local            (developer machine, gitignored)
 *   - .env.development      (committed dev defaults)
 *   - .env.production       (committed prod defaults)
 *   - Real env at build time (CI / container)
 *
 * Add new settings here, never read import.meta.env directly from components.
 */

type DataSource = "mock" | "live";

const env = import.meta.env;

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v == null) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

function num(v: string | undefined, fallback: number): number {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  appName: env.VITE_APP_NAME ?? "Security Pipeline",
  dataSource: ((env.VITE_DATA_SOURCE as DataSource) ?? "mock") as DataSource,

  api: {
    /** Base URL of the dashboard backend (proxies Jenkins / DTrack / S3). */
    baseUrl: env.VITE_API_BASE_URL ?? "",
    /** How often (ms) the UI polls for run updates when in live mode. */
    pollIntervalMs: num(env.VITE_POLL_INTERVAL_MS, 5000),
  },

  jenkins: {
    baseUrl: env.VITE_JENKINS_BASE_URL ?? "",
    /**
     * Jenkins job names per workflow.
     *
     * Each workflow has multiple jobs. The key here MUST match the `id` of the
     * corresponding Job in the data model so we can build a console URL with
     * `jenkinsJobUrl(workflowId, jobId)`.
     *
     * Override per-environment via env vars, e.g.:
     *   VITE_JENKINS_JOB_E_ORCHESTRATOR=nios-orchestrator
     *   VITE_JENKINS_JOB_E_MIRROR=jammy-mirror-sync
     */
    jobs: {
      // Workflow E — Build & Unit Tests
      E: {
        "e-orchestrator": env.VITE_JENKINS_JOB_E_ORCHESTRATOR ?? "",
        "e-mirror":       env.VITE_JENKINS_JOB_E_MIRROR ?? "",
        "e-nios-build":   env.VITE_JENKINS_JOB_E_NIOS_BUILD ?? "",
        "e-quick-ut":     env.VITE_JENKINS_JOB_E_QUICK_UT ?? "",
        "e-slow-ut":      env.VITE_JENKINS_JOB_E_SLOW_UT ?? "",
      },
      // Workflow B — SBOM & CVE Scan
      B: {
        "b-extract": env.VITE_JENKINS_JOB_B_EXTRACT ?? "",
        "b-dtrack":  env.VITE_JENKINS_JOB_B_DTRACK ?? "",
        "b-s3":      env.VITE_JENKINS_JOB_B_S3 ?? "",
      },
      // Workflow D — Impact Analysis
      D: {
        "d-poll":   env.VITE_JENKINS_JOB_D_POLL ?? "",
        "d-index":  env.VITE_JENKINS_JOB_D_INDEX ?? "",
        "d-impact": env.VITE_JENKINS_JOB_D_IMPACT ?? "",
        "d-report": env.VITE_JENKINS_JOB_D_REPORT ?? "",
      },
    } as Record<"E" | "B" | "D", Record<string, string>>,
  },

  dependencyTrack: {
    baseUrl: env.VITE_DTRACK_BASE_URL ?? "",
    projectId: env.VITE_DTRACK_PROJECT_ID ?? "",
  },

  s3: {
    bucket: env.VITE_S3_BUCKET ?? "",
    cvePrefix: env.VITE_S3_CVE_PREFIX ?? "cve-output/",
    region: env.VITE_S3_REGION ?? "us-east-1",
  },

  impactAnalyser: {
    apiUrl: env.VITE_IMPACT_API_URL ?? "",
    defaultAuthorModel: env.VITE_IMPACT_AUTHOR_MODEL ?? "",
    defaultVerifierModel: env.VITE_IMPACT_VERIFIER_MODEL ?? "",
  },

  features: {
    consoleDrawer: bool(env.VITE_FEAT_CONSOLE, true),
    notifications: bool(env.VITE_FEAT_NOTIFICATIONS, true),
    metrics: bool(env.VITE_FEAT_METRICS, true),
  },
} as const;

export type AppConfig = typeof config;

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

export type WorkflowKey = "E" | "B" | "D";

/** Jenkins job name for a given workflow + job id (from the data model). */
export function jenkinsJobName(wf: WorkflowKey, jobId: string): string {
  return config.jenkins.jobs[wf]?.[jobId] ?? "";
}

/** Link to the Jenkins job page (latest build). Empty string if not configured. */
export function jenkinsJobUrl(wf: WorkflowKey, jobId: string): string {
  const name = jenkinsJobName(wf, jobId);
  if (!config.jenkins.baseUrl || !name) return "";
  return `${config.jenkins.baseUrl}/job/${encodeURIComponent(name)}`;
}

/** Link to a specific Jenkins build's console page. */
export function jenkinsConsoleUrl(
  wf: WorkflowKey,
  jobId: string,
  buildNumber: number | string
): string {
  const base = jenkinsJobUrl(wf, jobId);
  if (!base) return "";
  return `${base}/${buildNumber}/console`;
}

/**
 * Backend endpoint that proxies the Jenkins progressive console log.
 *
 * Expected backend contract:
 *   GET {API_BASE}/runs/{runId}/jobs/{jobId}/log?since={byteOffset}
 *   →  { text: string, nextOffset: number, more: boolean }
 *
 * This avoids CORS issues talking to Jenkins directly from the browser and
 * lets the backend inject auth tokens.
 */
export function jobLogUrl(runId: string, jobId: string, since = 0): string {
  if (!config.api.baseUrl) return "";
  return `${config.api.baseUrl}/runs/${encodeURIComponent(
    runId
  )}/jobs/${encodeURIComponent(jobId)}/log?since=${since}`;
}
