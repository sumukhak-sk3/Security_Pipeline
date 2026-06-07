/**
 * Dependency-Track API client.
 *
 * Proxied through /_dtrack to avoid CORS and inject the X-Api-Key header
 * server-side (see vite.config.ts).
 *
 * API docs: https://docs.dependencytrack.org/integrations/rest-api/
 */

const BASE = "/_dtrack/api/v1";

export interface DTrackProject {
  uuid: string;
  name: string;
  version: string;
  lastBomImport: string | null;
  metrics?: DTrackMetrics;
}

export interface DTrackMetrics {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unassigned: number;
  vulnerabilities: number;
  components: number;
  suppressed: number;
  findingsTotal: number;
  findingsAudited: number;
  findingsUnaudited: number;
  inheritedRiskScore: number;
  firstOccurrence: number;
  lastOccurrence: number;
}

export interface DTrackVulnerability {
  uuid: string;
  vulnId: string;
  source: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNASSIGNED";
  title: string;
  description?: string;
  published?: string;
  cwes?: { cweId: number; name: string }[];
}

/**
 * List all projects (paginated — returns first 100).
 */
export async function fetchProjects(): Promise<DTrackProject[]> {
  const res = await fetch(`${BASE}/project?limit=100&offset=0`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`DTrack ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Get current metrics for a project.
 */
export async function fetchProjectMetrics(projectUuid: string): Promise<DTrackMetrics> {
  const res = await fetch(`${BASE}/metrics/project/${projectUuid}/current`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`DTrack metrics ${res.status}`);
  return res.json();
}

/**
 * Get vulnerabilities for a project.
 */
export async function fetchProjectVulnerabilities(
  projectUuid: string,
  limit = 50,
): Promise<DTrackVulnerability[]> {
  const res = await fetch(
    `${BASE}/vulnerability/project/${projectUuid}?limit=${limit}&offset=0`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`DTrack vulns ${res.status}`);
  return res.json();
}

/**
 * Find a project by name (exact match).
 */
export async function findProjectByName(name: string): Promise<DTrackProject | null> {
  const res = await fetch(`${BASE}/project?name=${encodeURIComponent(name)}&limit=1`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const data: DTrackProject[] = await res.json();
  return data[0] ?? null;
}
