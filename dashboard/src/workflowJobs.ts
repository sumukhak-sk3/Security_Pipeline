/**
 * Static mapping of internal job IDs → display title for each workflow.
 *
 * The Jenkins URL is resolved at render time via `jenkinsJobUrl(wf, id)`
 * (see src/config.ts), so swapping endpoints is a config-only change.
 */
import { jenkinsJobUrl, type WorkflowKey } from "./config";

interface JobSpec {
  id: string;
  title: string;
}

const SPECS: Record<WorkflowKey, JobSpec[]> = {
  E: [
    { id: "e-orchestrator", title: "NIOS-CVE-Repo (Orchestrator)" },
    { id: "e-nios-build",   title: "NIOS Build" },
    { id: "e-quick-ut",     title: "Quick UT" },
    { id: "e-slow-ut",      title: "Slow UT" },
  ],
  B: [
    // Filled in once Workflow B Jenkins jobs are wired.
  ],
  D: [
    { id: "d-impact", title: "Impact Analyser pipeline" },
  ],
};

export interface ResolvedJobSpec {
  id: string;
  title: string;
  jenkinsUrl: string;
}

export function workflowJobSpecs(wf: WorkflowKey): ResolvedJobSpec[] {
  return SPECS[wf].map((s) => ({ ...s, jenkinsUrl: jenkinsJobUrl(wf, s.id) }));
}
