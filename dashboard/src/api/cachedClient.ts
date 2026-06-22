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
