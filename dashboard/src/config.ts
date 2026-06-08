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
    pollIntervalMs: num(env.VITE_POLL_INTERVAL_MS, 120_000),
  },

  jenkins: {
    /**
     * Default Jenkins base URL — kept for fallback / display only.
     * Per-job URLs below take precedence and may live on a different instance.
     */
    baseUrl: env.VITE_JENKINS_BASE_URL ?? "https://jenkins.inca.infoblox.com",
    /**
     * FULL Jenkins job URL per workflow + job id (no trailing slash, no
     * `/buildWithParameters` or build number).
     *
     * The key MUST match the `id` of the matching Job in the data model.
     * Empty string = no Jenkins backing (e.g. the orchestrator/mirror
     * jobs run as shell scripts on a VM, not in Jenkins).
     *
     * Override per env var to point at a different folder or instance.
     */
    jobs: {
      // Workflow E — Build & Unit Tests
      E: {
        "e-orchestrator": env.VITE_JENKINS_JOB_E_ORCHESTRATOR ?? "",
        "e-mirror":       env.VITE_JENKINS_JOB_E_MIRROR ?? "",
        "e-nios-build":   env.VITE_JENKINS_JOB_E_NIOS_BUILD ??
                          "https://jenkins.inca.infoblox.com/job/NIOS-CVE-Analyser/job/NIOS-CVE-Build/job/CVE-BUILD",
        "e-quick-ut":     env.VITE_JENKINS_JOB_E_QUICK_UT ??
                          "http://10.197.38.69:8080/job/Automation_Quick_UT/job/unit_test_Bondi",
        "e-slow-ut":      env.VITE_JENKINS_JOB_E_SLOW_UT ??
                          "http://10.197.38.69:8080/job/Automation_Slow_UT/job/develop_9_2_base",
      },
      // Workflow B — SBOM & CVE Scan (still TBD — leave blank)
      B: {
        "b-extract": env.VITE_JENKINS_JOB_B_EXTRACT ?? "",
        "b-dtrack":  env.VITE_JENKINS_JOB_B_DTRACK ?? "",
        "b-s3":      env.VITE_JENKINS_JOB_B_S3 ?? "",
      },
      // Workflow D — Impact Analysis (all stages run inside one Jenkins pipeline)
      D: {
        "d-poll":   env.VITE_JENKINS_JOB_D_POLL ??
                    "https://jenkins.inca.infoblox.com/view/NIOS-CVE/job/NIOS-CVE-Analyser/job/test",
        "d-index":  env.VITE_JENKINS_JOB_D_INDEX ??
                    "https://jenkins.inca.infoblox.com/view/NIOS-CVE/job/NIOS-CVE-Analyser/job/test",
        "d-impact": env.VITE_JENKINS_JOB_D_IMPACT ??
                    "https://jenkins.inca.infoblox.com/view/NIOS-CVE/job/NIOS-CVE-Analyser/job/test",
        "d-report": env.VITE_JENKINS_JOB_D_REPORT ??
                    "https://jenkins.inca.infoblox.com/view/NIOS-CVE/job/NIOS-CVE-Analyser/job/test",
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
    /** Backend API base URL (the FastAPI-style service the Jenkinsfile hits). */
    apiUrl: env.VITE_IMPACT_API_URL ?? "http://10.120.23.89:8088",
    /** Frontend UI URL — also used as the default redirect button target. */
    uiUrl: env.VITE_IMPACT_UI_URL ?? "http://10.120.23.89:5173",
    defaultAuthorModel: env.VITE_IMPACT_AUTHOR_MODEL ?? "",
    defaultVerifierModel: env.VITE_IMPACT_VERIFIER_MODEL ?? "",
    /** URL for the "open analyser" redirect button on the Impact Analysis page. */
    redirectUrl:
      env.VITE_IMPACT_REDIRECT_URL ??
      env.VITE_IMPACT_UI_URL ??
      "http://10.120.23.89:5173",
    redirectLabel: env.VITE_IMPACT_REDIRECT_LABEL ?? "Open Impact Analyser",
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

/** Full Jenkins job URL for a given workflow + job id (empty if not configured). */
export function jenkinsJobUrl(wf: WorkflowKey, jobId: string): string {
  return (config.jenkins.jobs[wf]?.[jobId] ?? "").replace(/\/+$/, "");
}

/** Console URL for a specific build of a Jenkins job. */
export function jenkinsConsoleUrl(
  wf: WorkflowKey,
  jobId: string,
  buildNumber: number | string
): string {
  const base = jenkinsJobUrl(wf, jobId);
  if (!base) return "";
  return `${base}/${buildNumber}/console`;
}

/** Convenience: the bare Jenkins job name (last URL segment, decoded). */
export function jenkinsJobName(wf: WorkflowKey, jobId: string): string {
  const url = jenkinsJobUrl(wf, jobId);
  if (!url) return "";
  const last = url.split("/").pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
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
