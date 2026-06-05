/**
 * Jenkins REST client.
 *
 * Browsers can't call Jenkins directly (CORS + Basic Auth). In dev we use
 * the Vite proxy declared in `vite.config.ts`:
 *
 *   https://jenkins.inca.infoblox.com/view/NIOS-CVE/...   →  /_jenkins/impact/...
 *   https://jenkins.inca.infoblox.com/...                 →  /_jenkins/inca/...
 *   http://10.197.38.69:8080/...                          →  /_jenkins/ut/...
 *
 * Path matters: the Impact Analyser job uses a different API token than the
 * NIOS build, even though both live on jenkins.inca.infoblox.com.
 */

const PROXY_MAP: Array<{ match: RegExp; replace: string }> = [
  // Impact Analyser — matched FIRST because it shares a host with /inca.
  {
    match: /^https?:\/\/jenkins\.inca\.infoblox\.com\/view\/NIOS-CVE/i,
    replace: "/_jenkins/impact/view/NIOS-CVE",
  },
  {
    match: /^https?:\/\/jenkins\.inca\.infoblox\.com/i,
    replace: "/_jenkins/inca",
  },
  {
    match: /^https?:\/\/10\.197\.38\.69:8080/i,
    replace: "/_jenkins/ut",
  },
];

/** Convert a real Jenkins URL into the dev-server proxy path. */
export function toProxyUrl(jenkinsUrl: string): string {
  const trimmed = jenkinsUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  for (const { match, replace } of PROXY_MAP) {
    if (match.test(trimmed)) return trimmed.replace(match, replace);
  }
  return trimmed;
}

export interface JenkinsBuild {
  number: number;
  url: string;
  result: "SUCCESS" | "FAILURE" | "ABORTED" | "UNSTABLE" | null;
  building: boolean;
  timestamp: number;
  duration: number;
  estimatedDuration?: number;
  displayName?: string;
}

export interface JenkinsJob {
  name: string;
  url: string;
  lastBuild: JenkinsBuild | null;
  lastSuccessfulBuild: JenkinsBuild | null;
  lastCompletedBuild: JenkinsBuild | null;
  builds: JenkinsBuild[];
}

export type JenkinsStageStatus =
  | "SUCCESS"
  | "FAILED"
  | "IN_PROGRESS"
  | "PAUSED_PENDING_INPUT"
  | "ABORTED"
  | "UNSTABLE"
  | "NOT_EXECUTED"
  | "QUEUED";

export interface JenkinsStage {
  id: string;
  name: string;
  status: JenkinsStageStatus;
  startTimeMillis: number;
  durationMillis: number;
}

export interface JenkinsRunDescribe {
  id: string;
  name: string;
  status: JenkinsStageStatus;
  startTimeMillis: number;
  durationMillis: number;
  stages: JenkinsStage[];
}

const JOB_TREE =
  "name,url," +
  "lastBuild[number,url,result,building,timestamp,duration,estimatedDuration,displayName]," +
  "lastSuccessfulBuild[number,url,result,timestamp,duration,displayName]," +
  "lastCompletedBuild[number,url,result,timestamp,duration,displayName]," +
  "builds[number,url,result,building,timestamp,duration,displayName]{0,8}";

/** Fetch summary info for a Jenkins job. */
export async function fetchJob(jobUrl: string): Promise<JenkinsJob> {
  const proxied = toProxyUrl(jobUrl);
  if (!proxied) throw new Error("Job URL not configured");
  const url = `${proxied}/api/json?tree=${encodeURIComponent(JOB_TREE)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Jenkins ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as JenkinsJob;
}

/**
 * Fetch pipeline-stage breakdown for a build.
 * Only works for Pipeline jobs; returns null for freestyle / matrix jobs.
 */
export async function fetchRunStages(
  jobUrl: string,
  buildNumber: number,
): Promise<JenkinsRunDescribe | null> {
  const proxied = toProxyUrl(jobUrl);
  if (!proxied) return null;
  const url = `${proxied}/${buildNumber}/wfapi/describe`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as JenkinsRunDescribe;
  } catch {
    return null;
  }
}

/**
 * Fetch console log starting at byte offset `since` using Jenkins'
 * progressiveText endpoint.
 */
export async function fetchConsoleProgressive(
  jobUrl: string,
  buildNumber: number,
  since = 0,
): Promise<{ text: string; nextOffset: number; more: boolean }> {
  const proxied = toProxyUrl(jobUrl);
  if (!proxied) throw new Error("Job URL not configured");
  const url = `${proxied}/${buildNumber}/logText/progressiveText?start=${since}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Jenkins ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  const more = (res.headers.get("X-More-Data") ?? "").toLowerCase() === "true";
  const sizeHeader = Number(res.headers.get("X-Text-Size") ?? "0");
  const nextOffset = sizeHeader > 0 ? sizeHeader : since + text.length;
  return { text, nextOffset, more };
}

/**
 * Fetch the build parameters of the latest build for a Jenkins job.
 * Returns a key-value map of parameter names to values.
 */
export async function fetchLatestBuildParams(
  jobUrl: string,
): Promise<Record<string, string>> {
  const proxied = toProxyUrl(jobUrl);
  if (!proxied) return {};
  const tree = encodeURIComponent("actions[parameters[name,value]]");
  const url = `${proxied}/lastBuild/api/json?tree=${tree}`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return {};
    const data = await res.json();
    const params: Record<string, string> = {};
    for (const action of data?.actions ?? []) {
      if (action?.parameters) {
        for (const p of action.parameters) {
          if (p?.name) params[p.name] = p.value ?? "";
        }
      }
    }
    return params;
  } catch {
    return {};
  }
}
