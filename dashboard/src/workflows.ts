import type { WorkflowId } from "./types";

/**
 * Display metadata for each workflow. Keep this as the single source of truth
 * for human-friendly names so the letter (E/B/D) is only used as a badge.
 */
export const workflowMeta: {
  id: WorkflowId;
  shortName: string;
  fullName: string;
}[] = [
  { id: "E", shortName: "Build & Unit Tests", fullName: "Build & Unit Tests" },
  { id: "B", shortName: "SBOM & CVE Scan", fullName: "SBOM & CVE Scan" },
  { id: "D", shortName: "Impact Analysis", fullName: "Impact Analysis" },
];

export const workflowShortName = (id: WorkflowId): string =>
  workflowMeta.find((w) => w.id === id)?.shortName ?? id;
