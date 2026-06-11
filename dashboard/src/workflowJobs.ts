/**
 * Static mapping of internal job IDs → display title for each workflow.
 *
 * The Jenkins URL is resolved at render time via `jenkinsJobUrl(wf, id)`
 * (see src/config.ts). Note: pointing a job at a Jenkins instance on a new
 * host also requires updating the proxy routes in `vite.config.ts` and the
 * host → proxy mapping in `src/api/jenkinsClient.ts`; otherwise the browser
 * will try to reach Jenkins directly and hit CORS/auth failures.
 *
 * `dependsOn` defines the pipeline ordering — a job won't start until its
 * upstream dependency finishes. Used by the UI to show "Waiting for …"
 * placeholders when a pipeline run is in progress.
 */
import { jenkinsJobUrl, type WorkflowKey } from "./config";

interface JobSpec {
  id: string;
  title: string;
  /** The job ID that must finish before this one starts. */
  dependsOn?: string;
  /** Short description shown on the waiting card. */
  waitDescription?: string;
}

const SPECS: Record<WorkflowKey, JobSpec[]> = {
  E: [
    {
      id: "e-orchestrator",
      title: "NIOS-CVE-Repo (Orchestrator)",
      waitDescription: "Syncs the Ubuntu Jammy mirror, creates a bugfix branch, patches ubuntu.json, and triggers downstream builds.",
    },
    {
      id: "e-nios-build",
      title: "NIOS Build",
      dependsOn: "e-orchestrator",
      waitDescription: "Will be triggered by the Orchestrator after mirror sync and branch push. Builds the full NIOS image. Typically takes ~4 hours.",
    },
    {
      id: "e-quick-ut",
      title: "Quick UT",
      waitDescription: "Triggered by NIOS Build while it runs. Executes the quick unit test suite in parallel with NIOS Build and Slow UT.",
    },
    {
      id: "e-slow-ut",
      title: "Slow UT",
      waitDescription: "Triggered by NIOS Build while it runs. Executes the full slow unit test suite in parallel with NIOS Build and Quick UT.",
    },
  ],
  B: [],
  D: [
    { id: "d-impact", title: "Impact Analyser pipeline" },
  ],
};

export interface ResolvedJobSpec {
  id: string;
  title: string;
  jenkinsUrl: string;
  dependsOn?: string;
  waitDescription?: string;
}

export function workflowJobSpecs(wf: WorkflowKey): ResolvedJobSpec[] {
  return SPECS[wf].map((s) => ({
    ...s,
    jenkinsUrl: jenkinsJobUrl(wf, s.id),
  }));
}
