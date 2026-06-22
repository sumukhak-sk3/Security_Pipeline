/**
 * ReportPortal API client.
 *
 * Fetches UT launch results (quick + slow) from ReportPortal.
 * All requests go through the Vite dev proxy at `/_rp/` to avoid CORS
 * and keep the bearer token server-side.
 *
 * Launch naming convention in ReportPortal:
 *   bugfix_ubuntu-mirror-2026-06-02_slow #1
 *   bugfix_ubuntu-mirror-2026-06-02_quick #1
 *
 * The search uses `filter.cnt.name` (contains) with:
 *   "{branchTag}_slow" or "{branchTag}_quick"
 */

const RP_BASE = "/_rp/api/v1";
const PROJECT = "dev_nios_unittest";

export interface LaunchSummary {
  id: number;
  name: string;
  number?: number;
  status: string;
  startTime?: string;
  endTime?: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  url: string;
}

export interface FailedItem {
  name: string;
  path?: string;
  issue?: Record<string, unknown>;
  sampleLogs: { time?: string; level?: string; message?: string }[];
}

export interface UTResult {
  type: "quick" | "slow";
  status: "not_found" | "fetched";
  summary?: LaunchSummary;
  failedItems?: FailedItem[];
}

async function rpGet<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const url = new URL(`${RP_BASE}/${PROJECT}${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  }
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`ReportPortal ${res.status}: ${res.statusText}`);
  return res.json();
}

/**
 * Find the latest launch matching a name substring, optionally filtered by suffix.
 */
async function getLatestLaunch(namePattern: string, suffixFilter?: string): Promise<{ id: number; name: string; status?: string; startTime?: string } | null> {
  const data = await rpGet<{ content: Array<{ id: number; name: string; status?: string; startTime?: string }> }>("/launch", {
    "page.size": "20",
    "page.page": "1",
    "page.sort": "startTime,DESC",
    "filter.cnt.name": namePattern,
  });

  const results = data.content ?? [];

  // If a suffix filter is provided, find the first launch whose name ends with that suffix
  if (suffixFilter) {
    return results.find((l) => l.name.endsWith(suffixFilter)) ?? null;
  }

  return results[0] ?? null;
}

/**
 * Get pass/fail/skip counts for a launch.
 */
async function getLaunchSummary(launchId: number): Promise<LaunchSummary> {
  const data = await rpGet<{
    id: number;
    name: string;
    number?: number;
    status?: string;
    startTime?: string;
    endTime?: string;
    statistics?: {
      executions?: { total?: number; passed?: number; failed?: number; skipped?: number };
    };
  }>(`/launch/${launchId}`);

  const exec = data.statistics?.executions ?? {};
  return {
    id: data.id,
    name: data.name,
    number: data.number,
    status: data.status ?? "unknown",
    startTime: data.startTime,
    endTime: data.endTime,
    total: exec.total ?? 0,
    passed: exec.passed ?? 0,
    failed: exec.failed ?? 0,
    skipped: exec.skipped ?? 0,
    url: `http://10.34.98.129:8080/ui/#${PROJECT}/launches/all/${data.id}`,
  };
}

/**
 * Get failed test items for a launch (capped at 10).
 */
async function getFailedItems(launchId: number): Promise<FailedItem[]> {
  const data = await rpGet<{ content: Array<{ id: number; name?: string; pathNames?: string; issue?: Record<string, unknown> }> }>("/item", {
    "filter.eq.launchId": String(launchId),
    "filter.eq.status": "FAILED",
    "page.size": "10",
    "page.page": "1",
  });

  const items = data.content ?? [];
  const results: FailedItem[] = [];

  for (const item of items.slice(0, 10)) {
    let logs: { time?: string; level?: string; message?: string }[] = [];
    try {
      const logData = await rpGet<{ content: Array<{ logTime?: string; level?: string; message?: string }> }>("/log", {
        "filter.eq.itemRef": String(item.id),
        "filter.in.level": "ERROR,FATAL",
        "page.size": "5",
        "page.sort": "logTime,DESC",
      });
      logs = (logData.content ?? []).map((l) => ({
        time: l.logTime,
        level: l.level,
        message: l.message?.slice(0, 500),
      }));
    } catch {
      // log fetch is best-effort
    }

    results.push({
      name: item.name ?? "unknown",
      path: item.pathNames,
      issue: item.issue,
      sampleLogs: logs,
    });
  }

  return results;
}

/**
 * Fetch UT results for a given branch tag.
 * The branch tag maps to launch names like: `{branchTag}_quick` and `{branchTag}_slow`
 */
export async function fetchUTResults(branchTag: string): Promise<{ quick: UTResult; slow: UTResult }> {
  const results: { quick: UTResult; slow: UTResult } = {
    quick: { type: "quick", status: "not_found" },
    slow: { type: "slow", status: "not_found" },
  };

  for (const utType of ["quick", "slow"] as const) {
    const result = await fetchSingleUTResult(branchTag, utType);
    results[utType] = result;
  }

  return results;
}

/**
 * Fetch a single UT result (quick or slow) for a branch tag.
 *
 * If branchTag contains a full date (e.g. "bugfix_ubuntu-mirror-2026-06-02"),
 * searches for the exact pattern "{branchTag}_quick" / "{branchTag}_slow".
 *
 * If branchTag is a broad prefix (e.g. "bugfix_ubuntu-mirror"),
 * searches broadly and filters by the "_quick" / "_slow" suffix client-side.
 */
export async function fetchSingleUTResult(branchTag: string, utType: "quick" | "slow"): Promise<UTResult> {
  // Check if this looks like a specific branch with a date (contains a date pattern)
  const isSpecific = /\d{4}-\d{2}-\d{2}/.test(branchTag);

  let latest;
  if (isSpecific) {
    // Exact search: "bugfix_ubuntu-mirror-2026-06-02_quick"
    const pattern = `${branchTag}_${utType}`;
    latest = await getLatestLaunch(pattern);
  } else {
    // Broad search: find latest launch containing branchTag, ending with "_quick"/"_slow"
    latest = await getLatestLaunch(branchTag, `_${utType}`);
  }

  if (!latest) {
    return { type: utType, status: "not_found" };
  }

  const summary = await getLaunchSummary(latest.id);
  let failedItems: FailedItem[] | undefined;

  if (summary.failed > 0) {
    failedItems = await getFailedItems(latest.id);
  }

  return { type: utType, status: "fetched", summary, failedItems };
}
