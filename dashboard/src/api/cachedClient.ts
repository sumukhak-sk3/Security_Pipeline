/**
 * Cached backend client.
 *
 * All data comes from the Vite backend plugin's in-memory cache (/_api/*).
 * Responses are instant (<5ms) since the plugin polls upstreams server-side.
 *
 * REVERSIBLE: This file is only used if the hooks import it.
 * Delete it and revert hooks to restore direct-polling behavior.
 */

import type { JenkinsJob, JenkinsRunDescribe } from "./jenkinsClient";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CachedJenkinsArtifact {
  fileName: string;
  relativePath: string;
  downloadUrl: string;
}

export interface CachedJenkinsJob {
  name: string;
  url: string;
  lastBuild: any;
  lastCompletedBuild: any;
  lastSuccessfulBuild: any;
  builds: any[];
  stages: JenkinsRunDescribe | null;
  buildParams: Record<string, string>;
  artifacts?: CachedJenkinsArtifact[];
  artifactsBuildNumber?: number | null;
}

export interface CachedRPResult {
  ok: boolean;
  branchTag: string;
  quick: CachedRPLaunch | null;
  slow: CachedRPLaunch | null;
}

export interface CachedRPLaunch {
  id: number;
  name: string;
  status: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  startTime?: string;
  endTime?: string;
  url: string;
  failedItems?: Array<{ name: string; path?: string; sampleLogs: any[] }>;
}

// ─── Fetch helpers ──────────────────────────────────────────────────────────

/**
 * Fetch all Jenkins jobs from cache. Returns instantly.
 */
export async function fetchCachedJenkins(): Promise<Record<string, CachedJenkinsJob | null>> {
  const res = await fetch("/_api/jenkins");
  if (!res.ok) throw new Error(`Backend ${res.status}`);
  const data = await res.json();
  return data.jobs ?? {};
}

/**
 * Fetch a single Jenkins job from cache.
 */
export async function fetchCachedJenkinsJob(jobId: string): Promise<CachedJenkinsJob | null> {
  const res = await fetch(`/_api/jenkins/${jobId}`);
  if (!res.ok) throw new Error(`Backend ${res.status}`);
  const data = await res.json();
  return data.data ?? null;
}

/**
 * Fetch cached RP results (auto-detected branch).
 */
export async function fetchCachedRP(): Promise<CachedRPResult> {
  const res = await fetch("/_api/rp");
  if (!res.ok) throw new Error(`Backend ${res.status}`);
  return res.json();
}

/**
 * Fetch RP results for a specific branch.
 */
export async function fetchCachedRPForBranch(branch: string): Promise<CachedRPResult> {
  const res = await fetch(`/_api/rp/search?branch=${encodeURIComponent(branch)}`, {
    signal: AbortSignal.timeout(5000), // Don't hang if upstream is unreachable
  });
  if (!res.ok) throw new Error(`Backend ${res.status}`);
  return res.json();
}

/**
 * Fetch the previous (second-most-recent) RP launch for a given branch and UT type.
 */
export async function fetchCachedRPPrevious(branch: string, type: "quick" | "slow"): Promise<CachedRPLaunch | null> {
  const res = await fetch(`/_api/rp/previous?branch=${encodeURIComponent(branch)}&type=${type}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Backend ${res.status}`);
  const data = await res.json();
  return data.launch ?? null;
}

export interface PipelineSlowLaunch extends CachedRPLaunch {
  branch: string;
  buildNumber: number;
}

/**
 * Fetch the 2 most recent Slow UT RP launches for builds triggered by our pipeline.
 * Returns [latest, previous] based on actual Jenkins Slow UT successful builds.
 */
export async function fetchPipelineSlowUT(): Promise<[PipelineSlowLaunch | null, PipelineSlowLaunch | null]> {
  const res = await fetch("/_api/rp/pipeline-slow", { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Backend ${res.status}`);
  const data = await res.json();
  const launches: PipelineSlowLaunch[] = data.launches ?? [];
  return [launches[0] ?? null, launches[1] ?? null];
}

/**
 * Fetch the 2 most recent Quick UT RP launches for builds triggered by our pipeline.
 * Returns [latest, previous] based on actual Jenkins Quick UT successful builds.
 */
export async function fetchPipelineQuickUT(): Promise<[PipelineSlowLaunch | null, PipelineSlowLaunch | null]> {
  const res = await fetch("/_api/rp/pipeline-quick", { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Backend ${res.status}`);
  const data = await res.json();
  const launches: PipelineSlowLaunch[] = data.launches ?? [];
  return [launches[0] ?? null, launches[1] ?? null];
}

export interface BaselineResult {
  quick: CachedRPLaunch & { branch: string };
  slow: CachedRPLaunch & { branch: string };
}

/**
 * Fetch the latest develop/9.2 baselines (most recent quick and slow launches).
 */
export async function fetchBaselineUT(): Promise<BaselineResult> {
  const res = await fetch("/_api/rp/baseline", { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Backend ${res.status}`);
  const data = await res.json();
  return { quick: data.quick, slow: data.slow };
}

/**
 * Convert a CachedJenkinsJob to the JenkinsJob type used by the frontend.
 */
export function toJenkinsJob(cached: CachedJenkinsJob): JenkinsJob {
  return {
    name: cached.name,
    url: cached.url,
    lastBuild: cached.lastBuild,
    lastCompletedBuild: cached.lastCompletedBuild,
    lastSuccessfulBuild: cached.lastSuccessfulBuild,
    builds: cached.builds,
  };
}
