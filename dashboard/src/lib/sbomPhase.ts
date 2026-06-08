/**
 * SBOM (Workflow B) phase machine — shared between Overview card and the
 * Workflow B page so they always agree on what state B is in.
 *
 * Phases:
 *   noBuild  → no CVE-BUILD has ever run
 *   waiting  → CVE-BUILD is in flight (or done) but the BOM upload line
 *              hasn't been detected in the console for this build yet
 *   uploaded → BOM uploaded for the current CVE-BUILD, CVE delta has NOT
 *              yet landed in S3 for this pipeline run
 *   s3       → A new CSV/JSON object has appeared in the configured S3
 *              bucket after the pipeline start (or, when S3 polling is
 *              not configured, after the CVE-BUILD start time)
 *   failed   → CVE-BUILD failed/aborted before reaching BOM upload
 */

import type { Status } from "../types";

export type SbomPhase = "noBuild" | "waiting" | "uploaded" | "s3" | "failed";

interface BuildHeadline {
  number: number;
  building: boolean;
  result?: string | null;
  timestamp?: number;
}

interface SbomSummaryLike {
  buildNumber: number;
  bomUploaded: boolean;
}

interface S3SignalLike {
  /** True when AWS credentials + bucket are configured (we trust the signal). */
  configured: boolean;
  /** Epoch ms of the most-recently-uploaded matching object. */
  lastModifiedMs: number;
}

export function computeSbomPhase(
  niosBuild: BuildHeadline | null | undefined,
  sbomSummary: SbomSummaryLike | null | undefined,
  impactBuild: BuildHeadline | null | undefined,
  s3Signal?: S3SignalLike | null | undefined,
  pipelineStartTs?: number | null,
): SbomPhase {
  if (!niosBuild) return "noBuild";
  const result = (niosBuild.result ?? "").toUpperCase();
  const uploaded =
    sbomSummary?.buildNumber === niosBuild.number &&
    sbomSummary?.bomUploaded === true;
  if (!uploaded) {
    if (!niosBuild.building && (result === "FAILURE" || result === "ABORTED")) {
      return "failed";
    }
    return "waiting";
  }
  // BOM uploaded — did the CVE delta reach S3 for this run?
  //
  // Primary signal: configured S3 poller saw a new object whose
  // lastModified is >= the pipeline-start anchor (or, fallback, the
  // current CVE-BUILD start). This is the authoritative gate that
  // unblocks Impact Analyser.
  const niosTs = niosBuild.timestamp ?? 0;
  const anchorTs = pipelineStartTs && pipelineStartTs > 0
    ? Math.min(pipelineStartTs, niosTs || pipelineStartTs)
    : niosTs;
  if (s3Signal?.configured) {
    if (s3Signal.lastModifiedMs > 0 && anchorTs > 0 && s3Signal.lastModifiedMs >= anchorTs) {
      return "s3";
    }
    return "uploaded";
  }
  // Fallback when S3 isn't configured: detect d-impact firing as proxy.
  const impactTs = impactBuild?.timestamp ?? 0;
  if (niosTs > 0 && impactTs >= niosTs) return "s3";
  return "uploaded";
}

/**
 * Map a phase to the display status + progress used by status pills and
 * progress bars in the workflow cards / page headers.
 */
export function sbomPhaseToStatus(
  phase: SbomPhase,
  niosBuilding: boolean,
): { status: Status; progress: number } {
  switch (phase) {
    case "noBuild":  return { status: "pending", progress: 0 };
    case "waiting":  return { status: "running", progress: niosBuilding ? 30 : 60 };
    case "uploaded": return { status: "running", progress: 85 };
    case "s3":       return { status: "success", progress: 100 };
    case "failed":   return { status: "failed",  progress: 100 };
  }
}
