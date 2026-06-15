/**
 * Jenkins trigger client.
 *
 * In development the Vite dev-server proxies `/_jenkins/inca/*` to the real
 * Jenkins instance and injects Basic-Auth headers (see vite.config.ts), so the
 * browser never sees CORS or credentials.
 *
 * The orchestrator URL (NIOS-CVE-Repo) is the entry point of Workflow E.
 * It accepts an optional OVERRIDE_BRANCH parameter — if provided, the
 * automation scripts create and push that branch; otherwise they auto-generate
 * `bugfix/ubuntu-mirror-YYYY-MM-DD`.
 */

import { toProxyUrl } from "./jenkinsClient";

// Standardize on the same env var used by the rest of the app
// (src/config.ts → jenkinsJobUrl("E", "e-orchestrator")).
const ORCHESTRATOR_URL = import.meta.env.VITE_JENKINS_JOB_E_ORCHESTRATOR ?? "";

export interface TriggerResult {
  ok: boolean;
  status: number;
  queueUrl?: string;
  error?: string;
}

/**
 * Trigger the Workflow E orchestrator (NIOS-CVE-Repo) Jenkins job.
 *
 * @param opts.dryRun  If true, only pings /api/json (read-only) to validate auth.
 * @param opts.branch  Optional branch name override (passed as OVERRIDE_BRANCH param).
 */
export async function triggerWorkflowE(opts?: {
  dryRun?: boolean;
  branch?: string;
}): Promise<TriggerResult> {
  const dryRun = opts?.dryRun ?? false;
  const branch = opts?.branch?.trim() ?? "";

  if (!ORCHESTRATOR_URL) {
    return { ok: false, status: 0, error: "VITE_JENKINS_JOB_E_ORCHESTRATOR not configured" };
  }

  const proxyBase = toProxyUrl(ORCHESTRATOR_URL);
  if (!proxyBase) {
    return { ok: false, status: 0, error: "Invalid orchestrator URL" };
  }

  // Dry-run: just ping the job API to confirm connectivity + auth
  if (dryRun) {
    try {
      const res = await fetch(`${proxyBase}/api/json`, {
        headers: { Accept: "application/json" },
      });
      return { ok: res.ok, status: res.status };
    } catch (err: any) {
      return { ok: false, status: 0, error: err?.message ?? "Network error" };
    }
  }

  // Real trigger: POST to /build with branch param as query string
  // Note: /build with query params works with API token auth without needing a CSRF crumb.
  // /buildWithParameters requires a session-bound crumb which is tricky through a proxy.
  try {
    const queryParams = new URLSearchParams();
    queryParams.set("delay", "0sec");

    let endpoint: string;
    if (branch) {
      // Always ensure branch is under bugfix/ folder
      const fullBranch = branch.startsWith("bugfix/") ? branch : `bugfix/${branch}`;
      // Use /buildWithParameters when we have params, passed as query string
      queryParams.set("OVERRIDE_BRANCH", fullBranch);
      endpoint = `${proxyBase}/buildWithParameters?${queryParams.toString()}`;
    } else {
      // No params — use /build
      endpoint = `${proxyBase}/build?${queryParams.toString()}`;
    }

    const res = await fetch(endpoint, {
      method: "POST",
    });

    // A successful trigger returns 201 with a Location header
    const queueUrl = res.headers.get("Location") ?? undefined;
    return { ok: res.status === 201 || res.ok, status: res.status, queueUrl };
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message ?? "Network error" };
  }
}
