/**
 * Shared helpers for mapping Jenkins build/stage data to dashboard primitives.
 * Centralised so the workflow page, the overview, and the job card all agree
 * on what "progress" and "status" mean for a given build.
 */
import type {
  JenkinsBuild,
  JenkinsRunDescribe,
  JenkinsStage,
  JenkinsStageStatus,
} from "../api/jenkinsClient";
import type { Status } from "../types";

/** Jenkins build → internal Status union. */
export function buildStatus(b: JenkinsBuild | null): Status {
  if (!b) return "pending";
  if (b.building) return "running";
  switch (b.result) {
    case "SUCCESS":  return "success";
    case "FAILURE":
    case "ABORTED":
    case "UNSTABLE": return "failed";
    default:         return "pending";
  }
}

/** wfapi stage status → internal Status union. */
export function stageStatus(s: JenkinsStageStatus): Status {
  switch (s) {
    case "SUCCESS":              return "success";
    case "IN_PROGRESS":          return "running";
    case "PAUSED_PENDING_INPUT": return "running";
    case "QUEUED":               return "pending";
    case "NOT_EXECUTED":         return "skipped";
    case "FAILED":
    case "ABORTED":
    case "UNSTABLE":             return "failed";
    default:                     return "pending";
  }
}

/**
 * Compute progress 0–100 for a build.
 *
 * Priority:
 *   1. If stages are available → completed_stages / total_stages
 *      (running stage counts as half-done). This is the most accurate
 *      and updates as the pipeline advances.
 *   2. Else if building → elapsed / estimatedDuration (rough).
 *   3. Else → 100 (build is finished, regardless of outcome).
 */
export function computeProgress(
  build: JenkinsBuild | null,
  stages: JenkinsStage[] | null | undefined,
): number {
  if (!build) return 0;

  if (stages && stages.length > 0) {
    let score = 0;
    for (const s of stages) {
      const st = stageStatus(s.status);
      if (st === "success" || st === "failed" || st === "skipped") score += 1;
      else if (st === "running") score += 0.5;
    }
    const pct = Math.round((score / stages.length) * 100);
    return Math.max(0, Math.min(100, pct));
  }

  if (!build.building) return 100;

  const elapsed = Date.now() - build.timestamp;
  const est = build.estimatedDuration && build.estimatedDuration > 0
    ? build.estimatedDuration
    : 0;
  if (!est) return 50;
  return Math.min(99, Math.max(1, Math.round((elapsed / est) * 100)));
}

/** Convenience: pull the headline build (running > last completed). */
export function headlineBuild(job: { lastBuild: JenkinsBuild | null; lastCompletedBuild: JenkinsBuild | null } | null): JenkinsBuild | null {
  if (!job) return null;
  if (job.lastBuild?.building) return job.lastBuild;
  return job.lastCompletedBuild;
}

/** Convenience: pull stage list out of a wfapi describe response. */
export function stagesOf(describe: JenkinsRunDescribe | null): JenkinsStage[] | null {
  return describe?.stages ?? null;
}
