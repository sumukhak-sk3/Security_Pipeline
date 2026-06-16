/**
 * Vite Backend Plugin — embedded caching proxy + WebSocket push + SSE console streaming.
 *
 * REVERSIBLE: To remove, delete this file and remove the `backendPlugin()` import
 * from vite.config.ts. No other files are modified.
 *
 * What it does:
 * 1. Polls Jenkins + ReportPortal at intervals (server-side)
 * 2. Caches results in memory with TTL
 * 3. Exposes REST endpoints under /_api/* (served from cache → instant)
 * 4. WebSocket at /_ws — pushes data diffs to connected browsers
 * 5. SSE at /_api/console/:jobId/:buildNumber — streams console output live
 *
 * The frontend can call /_api/* instead of /_jenkins/* and /_rp/* directly.
 * Existing proxy routes still work as fallback.
 */

import type { Plugin, ViteDevServer } from "vite";
import { loadEnv } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, ServerResponse } from "http";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

// ─── Types ──────────────────────────────────────────────────────────────────

interface CacheEntry<T = unknown> {
  data: T;
  fetchedAt: number;
  ttl: number;
}

interface JenkinsArtifact {
  fileName: string;
  relativePath: string;
  /** Full URL to download the artifact (server-side proxied path). */
  downloadUrl: string;
}

interface JenkinsJobCache {
  name: string;
  url: string;
  lastBuild: any;
  lastCompletedBuild: any;
  lastSuccessfulBuild: any;
  builds: any[];
  stages: any;
  buildParams: Record<string, string>;
  /** Artifacts attached to the headline build (running build if any, else last completed). */
  artifacts: JenkinsArtifact[];
  /** Build number that `artifacts` belong to (for cache invalidation). */
  artifactsBuildNumber: number | null;
}

interface SbomSummaryCache {
  buildNumber: number;
  buildUrl: string;
  builtAt?: number;
  project: string | null;
  components: number | null;
  groups: string[];
  buildLabel: string | null;
  dtrackUrl: string | null;
  bomUploaded: boolean;
  bomToken: string | null;
  parsedAt: number;
}

interface ImpactCveSummary {
  runId: string;
  total: number;
  withDecision: number;
  withoutDecision: number;
  bySeverity: Record<string, number>;
  byVerdict: Record<string, number>;
  byStatus: Record<string, number>;
  fetchedAt: number;
}

interface RPLaunchCache {
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
  failedItems?: any[];
}

interface S3CveCache {
  /** Latest matching object key seen in the bucket/prefix. */
  key: string | null;
  /** Last-modified epoch ms (when the object hit S3). */
  lastModifiedMs: number;
  /** ETag of the latest object (for change detection). */
  etag: string | null;
  /** When the poller last successfully listed objects. */
  fetchedAt: number;
  /** Bucket + prefix in use (echo back for debugging). */
  bucket: string;
  prefix: string;
  /** Total number of matching objects in the prefix. */
  totalCount: number;
  /** True when AWS credentials + bucket are configured. */
  configured: boolean;
  /** Last poll error message (null on success). */
  error: string | null;
}

// ─── In-memory LRU cache (bounded, max 200 entries) ─────────────────────────

const MAX_CACHE_SIZE = 200;
const cache = new Map<string, CacheEntry>();

function cacheGet<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > entry.ttl) {
    cache.delete(key);
    return null;
  }
  // LRU: move to end (most recently accessed)
  cache.delete(key);
  cache.set(key, entry);
  return entry.data as T;
}

function cacheSet<T>(key: string, data: T, ttlMs: number): void {
  // Evict oldest entries if at capacity
  if (cache.size >= MAX_CACHE_SIZE && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { data, fetchedAt: Date.now(), ttl: ttlMs });
}

// ─── Circuit Breaker ────────────────────────────────────────────────────────

interface CircuitState {
  failures: number;
  lastFailure: number;
  backoffMs: number;
  open: boolean; // true = skip requests until backoff expires
}

const circuits = new Map<string, CircuitState>();
const BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 60_000; // 1 minute max (was 5 min — too aggressive for flaky networks)
const FAILURE_THRESHOLD = 5;

function getCircuit(key: string): CircuitState {
  if (!circuits.has(key)) {
    circuits.set(key, { failures: 0, lastFailure: 0, backoffMs: BASE_BACKOFF_MS, open: false });
  }
  return circuits.get(key)!;
}

function shouldSkip(key: string): boolean {
  const c = getCircuit(key);
  if (!c.open) return false;
  // Check if backoff period has elapsed
  if (Date.now() - c.lastFailure >= c.backoffMs) {
    c.open = false; // Half-open: allow one attempt
    return false;
  }
  return true;
}

function recordSuccess(key: string): void {
  const c = getCircuit(key);
  c.failures = 0;
  c.backoffMs = BASE_BACKOFF_MS;
  c.open = false;
}

function recordFailure(key: string): void {
  const c = getCircuit(key);
  c.failures++;
  c.lastFailure = Date.now();
  if (c.failures >= FAILURE_THRESHOLD) {
    c.open = true;
    c.backoffMs = Math.min(c.backoffMs * 2, MAX_BACKOFF_MS);
    console.warn(`[backend] Circuit OPEN for "${key}" — backing off ${c.backoffMs / 1000}s`);
  }
}

// ─── Request Deduplication ──────────────────────────────────────────────────

const inflight = new Map<string, Promise<any>>();

function dedup<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ─── HTTP fetch helper (server-side, with timeout) ──────────────────────────

const FETCH_TIMEOUT_MS = 20_000;

async function serverFetch(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function serverFetchText(url: string, headers: Record<string, string> = {}): Promise<{ text: string; headers: Record<string, string> }> {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const text = await res.text();
  const resHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { resHeaders[k.toLowerCase()] = v; });
  return { text, headers: resHeaders };
}

// ─── Config (read from env at plugin init) ──────────────────────────────────

interface PluginConfig {
  jenkinsJobs: { id: string; url: string; proxy: string }[];
  rpProject: string;
  rpBaseUrl: string;
  rpToken: string;
  jenkinsAuth: Record<string, string>; // proxy-name → "user:token"
  impactApiUrl: string;
  pollIntervalMs: number;
  cacheTtlMs: number;
  rpCacheTtlMs: number;
  jiraBaseUrl: string;
  jiraEmail: string;
  jiraToken: string;
  jiraIssueKey: string;
  s3: {
    bucket: string;
    prefix: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    pollIntervalMs: number;
  };
}

function buildConfig(env: Record<string, string>): PluginConfig {
  const jenkinsUser = env.JENKINS_USER ?? "";
  const jenkinsToken = env.JENKINS_API_TOKEN ?? "";
  const utUser = env.UT_JENKINS_USER ?? "";
  const utToken = env.UT_JENKINS_API_TOKEN ?? "";
  const impactUser = env.IMPACT_JENKINS_USER ?? "";
  const impactToken = env.IMPACT_JENKINS_API_TOKEN ?? "";

  return {
    jenkinsJobs: [
      { id: "e-orchestrator", url: env.VITE_JENKINS_JOB_E_ORCHESTRATOR ?? "", proxy: "inca" },
      { id: "e-nios-build", url: env.VITE_JENKINS_JOB_E_NIOS_BUILD ?? "", proxy: "inca" },
      { id: "e-quick-ut", url: env.VITE_JENKINS_JOB_E_QUICK_UT ?? "", proxy: "ut" },
      { id: "e-slow-ut", url: env.VITE_JENKINS_JOB_E_SLOW_UT ?? "", proxy: "ut" },
      { id: "d-impact", url: env.VITE_JENKINS_JOB_D_IMPACT ?? "", proxy: "impact" },
    ].filter((j) => j.url),
    rpProject: "dev_nios_unittest",
    rpBaseUrl: "http://10.34.98.129:8080",
    rpToken: env.RP_BEARER_KEY ?? "",
    jenkinsAuth: {
      inca: jenkinsUser && jenkinsToken ? `${jenkinsUser}:${jenkinsToken}` : "",
      ut: utUser && utToken ? `${utUser}:${utToken}` : "",
      impact: impactUser && impactToken ? `${impactUser}:${impactToken}` : "",
    },
    impactApiUrl: env.VITE_IMPACT_API_URL ?? "http://10.120.23.89:8088",
    pollIntervalMs: Number(env.VITE_POLL_INTERVAL_MS) || 120_000, // 2 min — eases frontend/backend load
    cacheTtlMs: 130_000, // Jenkins cache: ~2 min (slightly longer than poll interval)
    rpCacheTtlMs: 120_000, // RP cache: 2 min
    jiraBaseUrl: env.JIRA_BASE_URL ?? "https://infoblox.atlassian.net",
    jiraEmail: env.JIRA_EMAIL ?? "",
    jiraToken: env.JIRA_API_TOKEN ?? "",
    jiraIssueKey: env.JIRA_ISSUE_KEY ?? "NIOSRFE-8575",
    s3: {
      bucket: env.S3_CVE_BUCKET ?? env.VITE_S3_BUCKET ?? "",
      prefix: env.S3_CVE_PREFIX ?? env.VITE_S3_CVE_PREFIX ?? "",
      region: env.S3_CVE_REGION ?? env.AWS_REGION ?? env.VITE_S3_REGION ?? "us-west-1",
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? "",
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "",
      pollIntervalMs: Number(env.S3_CVE_POLL_INTERVAL_MS) || 20_000,
    },
  };
}

// ─── Jenkins poller ─────────────────────────────────────────────────────────

function jenkinsHeaders(cfg: PluginConfig, proxyName: string): Record<string, string> {
  const auth = cfg.jenkinsAuth[proxyName];
  if (!auth) return {};
  return { Authorization: `Basic ${Buffer.from(auth).toString("base64")}` };
}

const JOB_TREE =
  "name,url," +
  "lastBuild[number,url,result,building,timestamp,duration,estimatedDuration,displayName]," +
  "lastSuccessfulBuild[number,url,result,timestamp,duration,displayName]," +
  "lastCompletedBuild[number,url,result,timestamp,duration,displayName]," +
  "builds[number,url,result,building,timestamp,duration,displayName]{0,8}";

async function pollJenkinsJob(cfg: PluginConfig, job: { id: string; url: string; proxy: string }): Promise<JenkinsJobCache | null> {
  const circuitKey = `jenkins:${job.id}`;

  // Circuit breaker: skip if circuit is open
  if (shouldSkip(circuitKey)) return null;

  const headers = jenkinsHeaders(cfg, job.proxy);
  try {
    const jobData = await dedup(circuitKey, () =>
      serverFetch(`${job.url}/api/json?tree=${encodeURIComponent(JOB_TREE)}`, headers)
    );
    recordSuccess(circuitKey);

    // Fetch stages for headline build
    const headline = jobData.lastBuild?.building ? jobData.lastBuild : jobData.lastCompletedBuild;
    let stages = null;
    if (headline) {
      try {
        stages = await serverFetch(`${job.url}/${headline.number}/wfapi/describe`, headers);
      } catch { /* freestyle jobs don't have wfapi */ }
    }

    // Fetch build params from latest build
    let buildParams: Record<string, string> = {};
    if (headline) {
      try {
        const paramData = await serverFetch(
          `${job.url}/lastBuild/api/json?tree=${encodeURIComponent("actions[parameters[name,value]]")}`,
          headers,
        );
        for (const action of paramData?.actions ?? []) {
          if (action?.parameters) {
            for (const p of action.parameters) {
              if (p?.name) buildParams[p.name] = p.value ?? "";
            }
          }
        }
      } catch { /* ignore */ }
    }

    // Fetch artifacts list for the headline build (one request, cheap).
    // We narrow the surfaced artifacts to exactly what the dashboard needs:
    //   • e-orchestrator  → a synthetic console-export text file
    //   • e-nios-build    → a synthetic SBOM-summary console slice
    //   • d-impact        → vulnerabilities*.csv + run-*.xlsx report only
    //   • every other job → no artifacts surfaced
    let artifacts: JenkinsArtifact[] = [];
    let artifactsBuildNumber: number | null = null;
    if (headline?.number) {
      if (job.id === "e-orchestrator") {
        artifacts = [{
          fileName: `nios-cve-repo-orchestrator-#${headline.number}.txt`,
          relativePath: `__console__/orchestrator-#${headline.number}.txt`,
          downloadUrl: `/_api/console-export/${job.id}/${headline.number}?mode=full`,
        }];
        artifactsBuildNumber = headline.number;
      } else if (job.id === "e-nios-build") {
        artifacts = [{
          fileName: `nios-build-#${headline.number}-sbom-summary.txt`,
          relativePath: `__console__/nios-build-#${headline.number}-sbom.txt`,
          downloadUrl: `/_api/console-export/${job.id}/${headline.number}?mode=sbom-tail`,
        }];
        artifactsBuildNumber = headline.number;
      } else if (job.id === "d-impact") {
        try {
          const artData = await serverFetch(
            `${job.url}/${headline.number}/api/json?tree=${encodeURIComponent("artifacts[fileName,relativePath]{0,5000}")}`,
            headers,
          );
          const list: Array<{ fileName?: string; relativePath?: string }> = artData?.artifacts ?? [];
          const vulnCsvRe = /vulnerab.*\.csv$/i;
          const xlsxRe = /\.xlsx$/i;
          artifacts = list
            .filter((a) => a.fileName && a.relativePath)
            .filter((a) => vulnCsvRe.test(a.fileName!) || xlsxRe.test(a.fileName!))
            .slice(0, 10)
            .map((a) => ({
              fileName: a.fileName!,
              relativePath: a.relativePath!,
              downloadUrl: `${job.url}/${headline.number}/artifact/${a.relativePath}`,
            }));
          artifactsBuildNumber = headline.number;
        } catch { /* ignore */ }
      }
    }

    return {
      name: jobData.name,
      url: jobData.url,
      lastBuild: jobData.lastBuild,
      lastCompletedBuild: jobData.lastCompletedBuild,
      lastSuccessfulBuild: jobData.lastSuccessfulBuild,
      builds: jobData.builds ?? [],
      stages,
      buildParams,
      artifacts,
      artifactsBuildNumber,
    };
  } catch (err: any) {
    recordFailure(circuitKey);
    console.error(`[backend] Jenkins poll failed for ${job.id}:`, err.message);
    return null;
  }
}

// ─── SBOM console parser (CVE-BUILD job) ────────────────────────────────────
//
// CVE-BUILD console contains a SUMMARY block describing the BOM uploaded to
// Dependency-Track. We tail the last ~30KB of console once per completed build
// and extract the key fields. Cached at `sbom:latest`, keyed by buildNumber so
// we never re-parse the same build.

function parseSbomSummary(text: string): Omit<SbomSummaryCache, "buildNumber" | "buildUrl" | "builtAt" | "parsedAt"> | null {
  // Strip timestamps like "02:53:20 " at line starts to simplify matching
  const cleaned = text.replace(/^\s*\d{2}:\d{2}:\d{2}\s+/gm, "");

  // Upload confirmation lives in the STEP 4 block — search the whole text
  const bomToken = grabIn(cleaned, /BOM uploaded successfully\s*\(token:\s*([^\s)]+)\)/);
  const bomUploaded = /BOM uploaded successfully/.test(cleaned)
    || /BOM submitted to DTrack/.test(cleaned);

  // SUMMARY block fields (only present after upload completes). Return partial
  // entry (bomUploaded only) when SUMMARY hasn't been printed yet so the UI
  // can flip from "waiting" to "running" as soon as the upload step fires.
  const summaryIdx = cleaned.search(/^\s*SUMMARY\s*$/m);
  if (summaryIdx < 0) {
    if (!bomUploaded) return null;
    return {
      project: null, components: null, groups: [],
      buildLabel: null, dtrackUrl: null,
      bomUploaded: true, bomToken,
    };
  }

  const summaryBlock = cleaned.slice(summaryIdx);
  const project = grabIn(summaryBlock, /Project:\s+(.+)$/m);
  const componentsStr = grabIn(summaryBlock, /Components:\s+(\d+)/m);
  const groupsStr = grabIn(summaryBlock, /Groups:\s+(.+)$/m);
  const buildLabel = grabIn(summaryBlock, /Build:\s+(.+)$/m);
  const dtrackUrl = grabIn(summaryBlock, /DTrack:\s+(https?:\/\/\S+)/m);

  return {
    project,
    components: componentsStr ? Number(componentsStr) : null,
    groups: groupsStr ? groupsStr.split(",").map((g) => g.trim()).filter(Boolean) : [],
    buildLabel,
    dtrackUrl,
    bomUploaded,
    bomToken,
  };
}

function grabIn(src: string, re: RegExp): string | null {
  const m = src.match(re);
  return m ? m[1].trim() : null;
}

async function fetchConsoleTail(
  cfg: PluginConfig,
  job: { id: string; url: string; proxy: string },
  buildNumber: number,
  tailBytes = 32_768,
): Promise<string | null> {
  const headers = jenkinsHeaders(cfg, job.proxy);
  try {
    // First request: ask for an out-of-range offset to retrieve the total size header cheaply
    const probe = await serverFetchText(
      `${job.url}/${buildNumber}/logText/progressiveText?start=999999999`,
      headers,
    );
    const total = Number(probe.headers["x-text-size"]) || 0;
    if (!total) return null;
    const start = Math.max(0, total - tailBytes);
    const tail = await serverFetchText(
      `${job.url}/${buildNumber}/logText/progressiveText?start=${start}`,
      headers,
    );
    return tail.text;
  } catch (err: any) {
    console.warn(`[backend] Console tail fetch failed for ${job.id}#${buildNumber}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch the entire console log via Jenkins' progressiveText endpoint.
 * Pages through `x-text-size` until the server reports no more data
 * or we hit `maxBytes` (a safety cap so a runaway log can't OOM us).
 */
async function fetchConsoleFull(
  cfg: PluginConfig,
  job: { id: string; url: string; proxy: string },
  buildNumber: number,
  maxBytes = 4 * 1024 * 1024,
): Promise<string | null> {
  const headers = jenkinsHeaders(cfg, job.proxy);
  let offset = 0;
  let out = "";
  try {
    for (let i = 0; i < 64; i++) {
      const r = await serverFetchText(
        `${job.url}/${buildNumber}/logText/progressiveText?start=${offset}`,
        headers,
      );
      if (r.text) out += r.text;
      const nextOffset = Number(r.headers["x-text-size"]);
      if (!Number.isFinite(nextOffset) || nextOffset <= offset) break;
      offset = nextOffset;
      if (out.length >= maxBytes) {
        out = out.slice(0, maxBytes);
        break;
      }
      const more = (r.headers["x-more-data"] ?? "").toLowerCase() === "true";
      if (!more) break;
    }
    return out || null;
  } catch (err: any) {
    console.warn(`[backend] Console full fetch failed for ${job.id}#${buildNumber}: ${err.message}`);
    return out || null;
  }
}

/**
 * Slice the NIOS Build console down to the SBOM "STEP 1 … Finished"
 * summary block the user wants attached to Jira. Falls back to the
 * tail of the log if the marker isn't found.
 */
function sliceSbomSummary(consoleText: string): string {
  const marker = consoleText.search(/STEP\s*1[:\s]/i);
  if (marker >= 0) return consoleText.slice(marker);
  return consoleText.length > 32_768 ? consoleText.slice(-32_768) : consoleText;
}

async function getConsoleExportText(
  cfg: PluginConfig,
  job: { id: string; url: string; proxy: string },
  buildNumber: number,
  mode: "full" | "sbom-tail",
): Promise<string | null> {
  if (mode === "sbom-tail") {
    const tail = await fetchConsoleTail(cfg, job, buildNumber, 256 * 1024);
    if (!tail) return null;
    return sliceSbomSummary(tail);
  }
  return await fetchConsoleFull(cfg, job, buildNumber);
}

async function maybeUpdateSbomCache(
  cfg: PluginConfig,
  job: { id: string; url: string; proxy: string },
  jobCache: JenkinsJobCache,
): Promise<SbomSummaryCache | null> {
  // Prefer the in-flight build so we can flip bomUploaded mid-build.
  // Fall back to lastCompletedBuild when nothing is currently running.
  const target = jobCache.lastBuild?.number ? jobCache.lastBuild : jobCache.lastCompletedBuild;
  if (!target?.number) return null;

  const existing = cacheGet<SbomSummaryCache>("sbom:latest");

  // Skip if existing entry is for this exact build AND is already "complete"
  // (SUMMARY parsed → has a project name). For in-flight builds we always
  // re-poll so a "BOM uploaded" line that just appeared can land in the cache.
  if (existing && existing.buildNumber === target.number && existing.project) {
    return existing;
  }

  const text = await fetchConsoleTail(cfg, job, target.number);
  if (!text) return existing;

  const parsed = parseSbomSummary(text);
  if (!parsed) return existing;

  // Don't downgrade a newer build's complete entry with an older partial.
  if (existing && existing.buildNumber > target.number) return existing;

  const entry: SbomSummaryCache = {
    buildNumber: target.number,
    buildUrl: target.url ?? `${job.url}/${target.number}/`,
    builtAt: typeof target.timestamp === "number" ? target.timestamp : undefined,
    parsedAt: Date.now(),
    ...parsed,
  };
  // Short TTL when we only got the partial (BOM uploaded but no SUMMARY yet)
  // so we keep re-polling until the rest of the SUMMARY block prints.
  const ttl = parsed.project ? cfg.cacheTtlMs * 60 : cfg.cacheTtlMs;
  cacheSet("sbom:latest", entry, ttl);
  return entry;
}

// ─── S3 CVE-output poller ───────────────────────────────────────────────────
//
// Polls the configured S3 bucket/prefix for the most-recently-uploaded
// CVE delta file. The dashboard uses the resulting `lastModifiedMs` to
// detect "the SBOM/CVE workflow for the current pipeline run has reached
// S3" — which is the gate that unblocks the Impact Analyser workflow.

let s3Client: S3Client | null = null;
let s3ClientKey = "";

function getS3Client(cfg: PluginConfig): S3Client | null {
  const { region, accessKeyId, secretAccessKey, bucket } = cfg.s3;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  const key = `${region}|${accessKeyId}`;
  if (s3Client && s3ClientKey === key) return s3Client;
  s3Client = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
  s3ClientKey = key;
  return s3Client;
}

async function pollS3Cve(cfg: PluginConfig): Promise<S3CveCache | null> {
  const circuitKey = "s3:cve";
  if (shouldSkip(circuitKey)) return cacheGet<S3CveCache>("s3:cve-latest");

  const { bucket, prefix } = cfg.s3;
  const baseEntry: S3CveCache = {
    key: null,
    lastModifiedMs: 0,
    etag: null,
    fetchedAt: Date.now(),
    bucket,
    prefix,
    configured: false,
    totalCount: 0,
    error: null,
  };

  const client = getS3Client(cfg);
  if (!client) {
    cacheSet("s3:cve-latest", baseEntry, cfg.s3.pollIntervalMs * 3);
    return baseEntry;
  }

  try {
    let latestKey: string | null = null;
    let latestMs = 0;
    let latestEtag: string | null = null;
    let totalCount = 0;
    let continuationToken: string | undefined;

    // ListObjectsV2 returns up to 1000 keys per call. We paginate but cap
    // total pages at 5 (5000 keys) to bound runtime.
    for (let page = 0; page < 5; page++) {
      const resp = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        ContinuationToken: continuationToken,
      }));
      for (const obj of resp.Contents ?? []) {
        const key = obj.Key ?? "";
        if (!key || key.endsWith("/")) continue;
        const lower = key.toLowerCase();
        if (!lower.endsWith(".csv") && !lower.endsWith(".json")) continue;
        totalCount++;
        const ms = obj.LastModified ? obj.LastModified.getTime() : 0;
        if (ms > latestMs) {
          latestMs = ms;
          latestKey = key;
          latestEtag = (obj.ETag ?? "").replace(/"/g, "") || null;
        }
      }
      if (!resp.IsTruncated || !resp.NextContinuationToken) break;
      continuationToken = resp.NextContinuationToken;
    }

    const entry: S3CveCache = {
      key: latestKey,
      lastModifiedMs: latestMs,
      etag: latestEtag,
      fetchedAt: Date.now(),
      bucket,
      prefix,
      configured: true,
      totalCount,
      error: null,
    };
    cacheSet("s3:cve-latest", entry, cfg.s3.pollIntervalMs * 3);
    recordSuccess(circuitKey);
    return entry;
  } catch (err: any) {
    recordFailure(circuitKey);
    const prev = cacheGet<S3CveCache>("s3:cve-latest");
    const entry: S3CveCache = {
      ...(prev ?? baseEntry),
      configured: true,
      fetchedAt: Date.now(),
      error: err?.message ?? String(err),
    };
    cacheSet("s3:cve-latest", entry, cfg.s3.pollIntervalMs * 3);
    console.warn(`[backend] S3 CVE poll failed: ${entry.error}`);
    return entry;
  }
}

// ─── ReportPortal poller ────────────────────────────────────────────────────

async function pollRPLaunches(cfg: PluginConfig, branchTag: string): Promise<{ quick: RPLaunchCache | null; slow: RPLaunchCache | null }> {
  const circuitKey = "rp:api";

  // Circuit breaker: skip if circuit is open
  if (shouldSkip(circuitKey)) return { quick: null, slow: null };

  const headers: Record<string, string> = {};
  if (cfg.rpToken) headers.Authorization = `Bearer ${cfg.rpToken}`;

  const result: { quick: RPLaunchCache | null; slow: RPLaunchCache | null } = { quick: null, slow: null };

  try {
    const launchesUrl = `${cfg.rpBaseUrl}/api/v1/${cfg.rpProject}/launch?page.size=20&page.page=1&page.sort=startTime,DESC&filter.cnt.name=${encodeURIComponent(branchTag)}`;
    const data = await dedup(`rp:launches:${branchTag}`, () => serverFetch(launchesUrl, headers));
    recordSuccess(circuitKey);
    const launches: any[] = data.content ?? [];

    for (const utType of ["quick", "slow"] as const) {
      const launch = launches.find((l: any) => l.name?.endsWith(`_${utType}`));
      if (!launch) continue;

      // Fetch full summary
      const summary = await serverFetch(`${cfg.rpBaseUrl}/api/v1/${cfg.rpProject}/launch/${launch.id}`, headers);
      const exec = summary.statistics?.executions ?? {};

      const entry: RPLaunchCache = {
        id: summary.id,
        name: summary.name,
        status: summary.status ?? "unknown",
        total: exec.total ?? 0,
        passed: exec.passed ?? 0,
        failed: exec.failed ?? 0,
        skipped: exec.skipped ?? 0,
        startTime: summary.startTime,
        endTime: summary.endTime,
        url: `${cfg.rpBaseUrl}/ui/#/${cfg.rpProject}/launches/all/${summary.id}`,
      };

      // Fetch failed items (parallel)
      if (entry.failed > 0) {
        try {
          const itemsData = await serverFetch(
            `${cfg.rpBaseUrl}/api/v1/${cfg.rpProject}/item?filter.eq.launchId=${launch.id}&filter.eq.status=FAILED&page.size=10&page.page=1`,
            headers,
          );
          const items = itemsData.content ?? [];

          // Fetch logs in PARALLEL (key perf improvement over frontend sequential)
          const failedItems = await Promise.all(
            items.slice(0, 10).map(async (item: any) => {
              let logs: any[] = [];
              try {
                const logData = await serverFetch(
                  `${cfg.rpBaseUrl}/api/v1/${cfg.rpProject}/log?filter.eq.itemRef=${item.id}&filter.in.level=ERROR,FATAL&page.size=5&page.sort=logTime,DESC`,
                  headers,
                );
                logs = (logData.content ?? []).map((l: any) => ({
                  time: l.logTime,
                  level: l.level,
                  message: l.message?.slice(0, 500),
                }));
              } catch { /* best effort */ }
              return { name: item.name ?? "unknown", path: item.pathNames, sampleLogs: logs };
            }),
          );
          entry.failedItems = failedItems;
        } catch { /* ignore */ }
      }

      result[utType] = entry;
    }
  } catch (err: any) {
    recordFailure(circuitKey);
    console.error(`[backend] RP poll failed:`, err.message);
  }

  return result;
}

// ─── WebSocket broadcast ────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;
const wsClients = new Set<WebSocket>();

function broadcast(type: string, payload: unknown): void {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// ─── Poller orchestrator ────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;
let rpPollTimer: ReturnType<typeof setInterval> | null = null;
let firstPollReady: Promise<void> = Promise.resolve();

// On-demand handles exposed by startPollers() so HTML serves and WS
// connects can force a fresh poll instead of returning stale cache.
let runPollJenkinsOnce: (() => Promise<void>) | null = null;
let lastJenkinsPollAt = 0;
let inflightJenkinsPoll: Promise<void> | null = null;

/**
 * Force a fresh Jenkins poll, deduped to one in-flight call at a time.
 * Capped wait so HTML serve / WS connect never blocks for more than maxWaitMs.
 */
async function ensureFreshJenkins(maxWaitMs: number, maxAgeMs: number): Promise<void> {
  if (!runPollJenkinsOnce) return;
  if (Date.now() - lastJenkinsPollAt < maxAgeMs) return;
  const poll = inflightJenkinsPoll ?? (inflightJenkinsPoll = runPollJenkinsOnce().finally(() => {
    inflightJenkinsPoll = null;
    lastJenkinsPollAt = Date.now();
  }));
  await Promise.race([poll, new Promise<void>((r) => setTimeout(r, maxWaitMs))]);
}

function startPollers(cfg: PluginConfig): void {
  // Jenkins poller — every pollIntervalMs
  const pollJenkins = async () => {
    const results = await Promise.all(
      cfg.jenkinsJobs.map(async (job) => {
        const data = await pollJenkinsJob(cfg, job);
        if (data) {
          const prev = cacheGet<JenkinsJobCache>(`jenkins:${job.id}`);
          cacheSet(`jenkins:${job.id}`, data, cfg.cacheTtlMs);

          // Push update if status changed
          if (prev && (prev.lastBuild?.number !== data.lastBuild?.number ||
              prev.lastBuild?.building !== data.lastBuild?.building ||
              prev.lastBuild?.result !== data.lastBuild?.result)) {
            broadcast("jenkins:update", { jobId: job.id, ...data });
          }

          // Side-effect: parse SBOM SUMMARY from CVE-BUILD console (job id e-nios-build)
          if (job.id === "e-nios-build") {
            const prevSbom = cacheGet<SbomSummaryCache>("sbom:latest");
            const updated = await maybeUpdateSbomCache(cfg, job, data);
            if (updated && (
              !prevSbom ||
              prevSbom.buildNumber !== updated.buildNumber ||
              prevSbom.bomUploaded !== updated.bomUploaded ||
              (!prevSbom.project && updated.project)
            )) {
              broadcast("sbom:update", updated);
            }
          }
        } else {
          // Poll failed — keep stale data alive much longer so the UI never loses it
          const prev = cacheGet<JenkinsJobCache>(`jenkins:${job.id}`);
          if (prev) cacheSet(`jenkins:${job.id}`, prev, cfg.cacheTtlMs * 30); // ~4 min stale window
        }
        return { id: job.id, data: data ?? cacheGet<JenkinsJobCache>(`jenkins:${job.id}`) };
      }),
    );

    // Determine RP branch from each UT job's build params independently
    const quickJob = results.find((r) => r.id === "e-quick-ut");
    const slowJob = results.find((r) => r.id === "e-slow-ut");
    const quickBranch = quickJob?.data?.buildParams?.BUILD?.replace(/\//g, "_") ?? "";
    const slowBranch = slowJob?.data?.buildParams?.BUILD?.replace(/\//g, "_") ?? "";
    const effectiveBranch = quickBranch || slowBranch || "bugfix_ubuntu-mirror";

    cacheSet("rp:branch-tag", effectiveBranch, cfg.rpCacheTtlMs * 2);
    cacheSet("rp:branch-tag-quick", quickBranch || effectiveBranch, cfg.rpCacheTtlMs * 2);
    cacheSet("rp:branch-tag-slow", slowBranch || effectiveBranch, cfg.rpCacheTtlMs * 2);

    // If branches differ between quick and slow, poll RP separately for each
    const prevTag = cacheGet<string>("rp:branch-tag");
    if (prevTag !== effectiveBranch || quickBranch !== slowBranch) {
      pollRP(cfg, effectiveBranch, quickBranch, slowBranch);
    }
  };

  // RP poller — every rpCacheTtlMs
  const pollRP = async (c: PluginConfig, tag?: string, quickTag?: string, slowTag?: string) => {
    const defaultTag = tag ?? cacheGet<string>("rp:branch-tag") ?? "bugfix_ubuntu-mirror";
    const effectiveQuickTag = quickTag || cacheGet<string>("rp:branch-tag-quick") || defaultTag;
    const effectiveSlowTag = slowTag || cacheGet<string>("rp:branch-tag-slow") || defaultTag;

    let data: { quick: RPLaunchCache | null; slow: RPLaunchCache | null };

    if (effectiveQuickTag === effectiveSlowTag) {
      // Same branch for both — single RP query
      data = await pollRPLaunches(c, effectiveQuickTag);
    } else {
      // Different branches — poll separately for each UT type
      const [quickData, slowData] = await Promise.all([
        pollRPLaunches(c, effectiveQuickTag),
        pollRPLaunches(c, effectiveSlowTag),
      ]);
      data = { quick: quickData.quick, slow: slowData.slow };
    }

    const prev = cacheGet<typeof data>("rp:latest");
    cacheSet("rp:latest", data, c.rpCacheTtlMs);
    cacheSet("rp:branch-tag-used", defaultTag, c.rpCacheTtlMs * 2);

    // Push if results changed
    if (JSON.stringify(prev) !== JSON.stringify(data)) {
      broadcast("rp:update", { branchTag: defaultTag, quickBranch: effectiveQuickTag, slowBranch: effectiveSlowTag, ...data });
    }
  };

  // Impact API poller
  const pollImpact = async () => {
    if (!cfg.impactApiUrl) return;
    const circuitKey = "impact:api";
    if (shouldSkip(circuitKey)) return;

    const base = cfg.impactApiUrl.replace(/\/+$/, "");
    const result: Record<string, any> = { healthy: null, health: null, indexes: null, latestRun: null, cveSummary: null };
    try {
      result.health = await serverFetch(`${base}/health`);
      result.healthy = true;
      recordSuccess(circuitKey);
    } catch {
      result.healthy = false;
      recordFailure(circuitKey);
    }
    try {
      const data = await serverFetch(`${base}/indexes`);
      result.indexes = Array.isArray(data) ? data : data?.indexes ?? [];
    } catch { /* ignore */ }
    try {
      result.latestRun = await serverFetch(`${base}/runs/latest`);
    } catch { /* ignore */ }

    // CVE aggregate summary for the latest run
    const runId = result.latestRun?.run_id ?? result.latestRun?.id;
    if (runId) {
      const prevSummary = cacheGet<ImpactCveSummary>(`impact:cves:${runId}`);
      // Reuse cached summary for a short window — CVE list rarely changes mid-run
      if (prevSummary && Date.now() - prevSummary.fetchedAt < cfg.cacheTtlMs * 4) {
        result.cveSummary = prevSummary;
      } else {
        try {
          const cvesData = await serverFetch(`${base}/runs/${runId}/cves`);
          const list: any[] = Array.isArray(cvesData) ? cvesData : (cvesData?.cves ?? cvesData?.items ?? []);
          const summary: ImpactCveSummary = {
            runId,
            total: list.length,
            withDecision: 0,
            withoutDecision: 0,
            bySeverity: {},
            byVerdict: {},
            byStatus: {},
            fetchedAt: Date.now(),
          };
          for (const c of list) {
            const sev = String(c?.severity ?? c?.cvss_severity ?? "UNKNOWN").toUpperCase();
            summary.bySeverity[sev] = (summary.bySeverity[sev] ?? 0) + 1;

            const decision = c?.decision ?? c?.final_decision ?? c?.verdict ?? null;
            const verdict = c?.verdict ?? decision?.verdict ?? (typeof decision === "string" ? decision : null);
            if (verdict) {
              const v = String(verdict).toUpperCase();
              summary.byVerdict[v] = (summary.byVerdict[v] ?? 0) + 1;
              summary.withDecision++;
            } else {
              summary.withoutDecision++;
            }

            const status = String(c?.status ?? c?.state ?? "").toUpperCase();
            if (status) summary.byStatus[status] = (summary.byStatus[status] ?? 0) + 1;
          }
          cacheSet(`impact:cves:${runId}`, summary, cfg.cacheTtlMs * 4);
          result.cveSummary = summary;
        } catch (err: any) {
          console.warn(`[backend] Impact CVE summary fetch failed for ${runId}: ${err.message}`);
        }
      }
    }

    const prev = cacheGet("impact:status");
    cacheSet("impact:status", result, cfg.cacheTtlMs);
    if (JSON.stringify(prev) !== JSON.stringify(result)) {
      broadcast("impact:update", result);
    }
  };

  // S3 CVE poller — runs at its own (slower) cadence. Broadcasts when the
  // latest object's key/lastModified changes.
  const pollS3 = async () => {
    const prev = cacheGet<S3CveCache>("s3:cve-latest");
    const data = await pollS3Cve(cfg);
    if (!data) return;
    if (
      !prev
      || prev.key !== data.key
      || prev.lastModifiedMs !== data.lastModifiedMs
      || prev.configured !== data.configured
    ) {
      broadcast("s3:update", data);
    }
  };

  // Run first poll eagerly — cache is warm by the time browser requests arrive
  firstPollReady = Promise.allSettled([pollJenkins(), pollImpact(), pollS3()]).then(() => {
    lastJenkinsPollAt = Date.now();
    pollRP(cfg);
  });

  // Expose for on-demand refresh from HTML serve / WS connect handlers
  runPollJenkinsOnce = async () => { await pollJenkins(); };

  pollTimer = setInterval(() => {
    pollJenkins().finally(() => { lastJenkinsPollAt = Date.now(); });
  }, cfg.pollIntervalMs);
  rpPollTimer = setInterval(() => pollRP(cfg), cfg.rpCacheTtlMs);
  const impactTimer = setInterval(pollImpact, cfg.pollIntervalMs);
  const s3Timer = setInterval(pollS3, cfg.s3.pollIntervalMs);

  console.log(
    `[backend] Pollers started — Jenkins ${cfg.pollIntervalMs}ms, RP ${cfg.rpCacheTtlMs}ms, S3 ${cfg.s3.pollIntervalMs}ms${cfg.s3.bucket ? ` (bucket=${cfg.s3.bucket})` : " (S3 not configured)"}`,
  );
}

function stopPollers(): void {
  if (pollTimer) clearInterval(pollTimer);
  if (rpPollTimer) clearInterval(rpPollTimer);
  pollTimer = null;
  rpPollTimer = null;
}

// ─── Jira: upload current-run artifacts ─────────────────────────────────────
//
// Hard caps prevent accidental bulk uploads. The impact-analyser job
// alone can emit ~100k tiny script files; without these limits, hitting
// the upload button would DoS Jira and burn through attachment quota.

const JIRA_MAX_FILES = 25;
const JIRA_MAX_FILE_BYTES = 10 * 1024 * 1024;        // 10 MB per file
const JIRA_MAX_TOTAL_BYTES = 50 * 1024 * 1024;       // 50 MB total per upload
const JIRA_FETCH_TIMEOUT_MS = 30_000;

interface JiraUploadResult {
  uploaded: { fileName: string; size: number; jobId: string }[];
  skipped: { fileName: string; reason: string; jobId: string }[];
  totalBytes: number;
  durationMs: number;
}

async function handleJiraUpload(req: IncomingMessage, res: ServerResponse, cfg: PluginConfig): Promise<void> {
  const started = Date.now();
  res.setHeader("Content-Type", "application/json");

  if (!cfg.jiraEmail || !cfg.jiraToken) {
    res.statusCode = 400;
    res.end(JSON.stringify({
      ok: false,
      error: "Jira not configured. Set JIRA_EMAIL and JIRA_API_TOKEN in .env.local.",
    }));
    return;
  }

  const urlObj = new URL(req.url ?? "", "http://localhost");
  const issueKey = urlObj.searchParams.get("issue") || cfg.jiraIssueKey;
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(issueKey)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: `Invalid Jira issue key: ${issueKey}` }));
    return;
  }

  // Pull current-pipeline artifacts using the same anchor logic the
  // frontend uses, so what we upload matches what the user sees.
  const jobs: Record<string, JenkinsJobCache | null> = {};
  for (const job of cfg.jenkinsJobs) {
    jobs[job.id] = cacheGet<JenkinsJobCache>(`jenkins:${job.id}`);
  }

  const orchestratorTs: number = jobs["e-orchestrator"]?.lastBuild?.timestamp ?? 0;
  const runningTimestamps: number[] = Object.values(jobs)
    .filter((j): j is JenkinsJobCache => j?.lastBuild?.building === true)
    .map((j) => j.lastBuild?.timestamp as number)
    .filter((t) => typeof t === "number" && t > 0);
  const anchorCandidates: number[] = [];
  if (orchestratorTs > 0) anchorCandidates.push(orchestratorTs);
  if (runningTimestamps.length) anchorCandidates.push(Math.min(...runningTimestamps));
  const pipelineStartTs = anchorCandidates.length ? Math.min(...anchorCandidates) : 0;

  // Build a flat candidate list with job ID + auth proxy so we can fetch.
  // Synthetic console-export entries (orchestrator full log, nios-build
  // SBOM-summary slice) carry a `__console__/` relativePath and are handled
  // inline via getConsoleExportText() instead of an HTTP round-trip.
  type Candidate = {
    jobId: string;
    proxy: string;
    fileName: string;
    relativePath: string;
    downloadUrl: string;
    buildNumber: number | null;
  };
  const candidates: Candidate[] = [];
  for (const job of cfg.jenkinsJobs) {
    const cached = jobs[job.id];
    if (!cached?.artifacts?.length) continue;
    const buildTs: number = cached.lastBuild?.timestamp ?? 0;
    if (job.id !== "e-orchestrator" && pipelineStartTs > 0 && buildTs < pipelineStartTs) {
      continue;
    }
    for (const a of cached.artifacts) {
      candidates.push({
        jobId: job.id,
        proxy: job.proxy,
        fileName: a.fileName,
        relativePath: a.relativePath,
        downloadUrl: a.downloadUrl,
        buildNumber: cached.artifactsBuildNumber ?? cached.lastBuild?.number ?? null,
      });
    }
  }

  if (candidates.length === 0) {
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: true,
      issueKey,
      result: { uploaded: [], skipped: [], totalBytes: 0, durationMs: Date.now() - started },
      note: "No artifacts found for the current pipeline run.",
    }));
    return;
  }

  // Refuse outright if the current run produced a runaway artifact count.
  // The cap is enforced PER UPLOAD anyway, but a 100k-file run is almost
  // certainly impact-analyser leftovers we should never upload.
  const HARD_CANDIDATE_LIMIT = 500;
  if (candidates.length > HARD_CANDIDATE_LIMIT) {
    res.statusCode = 400;
    res.end(JSON.stringify({
      ok: false,
      error: `Refusing to upload: ${candidates.length} candidate artifacts exceeds safety limit of ${HARD_CANDIDATE_LIMIT}. ` +
             `This usually means impact-analyser output is included \u2014 narrow the run filter first.`,
    }));
    return;
  }

  const result: JiraUploadResult = { uploaded: [], skipped: [], totalBytes: 0, durationMs: 0 };
  const jiraAttachUrl = `${cfg.jiraBaseUrl.replace(/\/+$/, "")}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`;
  const jiraAuth = "Basic " + Buffer.from(`${cfg.jiraEmail}:${cfg.jiraToken}`).toString("base64");

  for (const c of candidates) {
    if (result.uploaded.length >= JIRA_MAX_FILES) {
      result.skipped.push({ fileName: c.fileName, reason: `max ${JIRA_MAX_FILES} files reached`, jobId: c.jobId });
      continue;
    }
    if (result.totalBytes >= JIRA_MAX_TOTAL_BYTES) {
      result.skipped.push({ fileName: c.fileName, reason: `total ${(JIRA_MAX_TOTAL_BYTES/1024/1024)|0} MB cap reached`, jobId: c.jobId });
      continue;
    }

    const jenkinsHdrs = jenkinsHeaders(cfg, c.proxy);

    // Synthetic console-export candidate: render the text inline instead
    // of round-tripping through our own HTTP endpoint.
    let bytes: ArrayBuffer | null = null;
    if (c.relativePath.startsWith("__console__/")) {
      if (c.buildNumber == null) {
        result.skipped.push({ fileName: c.fileName, reason: "no build number for console export", jobId: c.jobId });
        continue;
      }
      const job = cfg.jenkinsJobs.find((j) => j.id === c.jobId);
      if (!job) {
        result.skipped.push({ fileName: c.fileName, reason: "job not found", jobId: c.jobId });
        continue;
      }
      const mode: "full" | "sbom-tail" = c.relativePath.includes("sbom") ? "sbom-tail" : "full";
      const text = await getConsoleExportText(cfg, job, c.buildNumber, mode);
      if (text == null) {
        result.skipped.push({ fileName: c.fileName, reason: "console fetch failed", jobId: c.jobId });
        continue;
      }
      bytes = new TextEncoder().encode(text).buffer;
    } else {
      // Step 1: HEAD to learn size cheaply. Skip oversized files without
      // downloading them (this is the whole point of the cap).
      let size = -1;
      try {
        const head = await fetch(c.downloadUrl, { method: "HEAD", headers: jenkinsHdrs, signal: AbortSignal.timeout(JIRA_FETCH_TIMEOUT_MS) });
        if (head.ok) {
          const len = head.headers.get("content-length");
          if (len) size = Number(len);
        }
      } catch { /* fall through; we'll check size after GET */ }

      if (size > JIRA_MAX_FILE_BYTES) {
        result.skipped.push({ fileName: c.fileName, reason: `file ${(size/1024/1024).toFixed(1)} MB exceeds per-file cap`, jobId: c.jobId });
        continue;
      }

      // Step 2: download
      try {
        const dl = await fetch(c.downloadUrl, { headers: jenkinsHdrs, signal: AbortSignal.timeout(JIRA_FETCH_TIMEOUT_MS) });
        if (!dl.ok) {
          result.skipped.push({ fileName: c.fileName, reason: `download failed: ${dl.status} ${dl.statusText}`, jobId: c.jobId });
          continue;
        }
        bytes = await dl.arrayBuffer();
      } catch (err: any) {
        result.skipped.push({ fileName: c.fileName, reason: `download error: ${err?.message ?? err}`, jobId: c.jobId });
        continue;
      }
    }

    if (!bytes) {
      result.skipped.push({ fileName: c.fileName, reason: "no bytes after fetch", jobId: c.jobId });
      continue;
    }

    // Enforce caps post-download in case HEAD lied / was unavailable
    if (bytes.byteLength > JIRA_MAX_FILE_BYTES) {
      result.skipped.push({ fileName: c.fileName, reason: `file ${(bytes.byteLength/1024/1024).toFixed(1)} MB exceeds per-file cap`, jobId: c.jobId });
      continue;
    }
    if (result.totalBytes + bytes.byteLength > JIRA_MAX_TOTAL_BYTES) {
      result.skipped.push({ fileName: c.fileName, reason: `would exceed total ${(JIRA_MAX_TOTAL_BYTES/1024/1024)|0} MB cap`, jobId: c.jobId });
      continue;
    }

    // Step 3: upload to Jira via multipart form
    try {
      const form = new FormData();
      const blobType = c.relativePath.startsWith("__console__/") ? "text/plain;charset=utf-8" : "application/octet-stream";
      form.append("file", new Blob([bytes], { type: blobType }), c.fileName);
      const up = await fetch(jiraAttachUrl, {
        method: "POST",
        headers: {
          Authorization: jiraAuth,
          "X-Atlassian-Token": "no-check",
          Accept: "application/json",
        },
        body: form,
        signal: AbortSignal.timeout(JIRA_FETCH_TIMEOUT_MS),
      });
      if (!up.ok) {
        const errBody = await up.text().catch(() => "");
        result.skipped.push({ fileName: c.fileName, reason: `Jira ${up.status}: ${errBody.slice(0, 120)}`, jobId: c.jobId });
        continue;
      }
      result.uploaded.push({ fileName: c.fileName, size: bytes.byteLength, jobId: c.jobId });
      result.totalBytes += bytes.byteLength;
    } catch (err: any) {
      result.skipped.push({ fileName: c.fileName, reason: `upload error: ${err?.message ?? err}`, jobId: c.jobId });
    }
  }

  result.durationMs = Date.now() - started;
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, issueKey, jiraBaseUrl: cfg.jiraBaseUrl, result }));
}

// ─── REST routes (served from cache) ────────────────────────────────────────

async function handleApiRequest(req: IncomingMessage, res: ServerResponse, cfg: PluginConfig): Promise<boolean> {
  const url = req.url ?? "";

  if (!url.startsWith("/_api/")) return false;

  const path = url.replace("/_api/", "");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // GET /_api/jenkins — all cached Jenkins jobs
  if (path === "jenkins" || path === "jenkins/") {
    const jobs: Record<string, JenkinsJobCache | null> = {};
    for (const job of cfg.jenkinsJobs) {
      jobs[job.id] = cacheGet<JenkinsJobCache>(`jenkins:${job.id}`);
    }
    res.end(JSON.stringify({ ok: true, jobs, cachedAt: Date.now() }));
    return true;
  }

  // GET /_api/jenkins/:jobId
  const jenkinsMatch = path.match(/^jenkins\/([^/]+)$/);
  if (jenkinsMatch) {
    const data = cacheGet<JenkinsJobCache>(`jenkins:${jenkinsMatch[1]}`);
    res.end(JSON.stringify({ ok: !!data, data }));
    return true;
  }

  // GET /_api/rp — cached RP results
  if (path === "rp" || path === "rp/") {
    const data = cacheGet("rp:latest");
    const branchTag = cacheGet<string>("rp:branch-tag-used") ?? "";
    res.end(JSON.stringify({ ok: !!data, branchTag, ...data as any }));
    return true;
  }

  // GET /_api/rp/search?branch=... — fetch RP for a specific branch (uses cache if available)
  if (path.startsWith("rp/search")) {
    const urlObj = new URL(url, "http://localhost");
    const branch = urlObj.searchParams.get("branch") ?? "";
    if (!branch) {
      res.end(JSON.stringify({ ok: false, error: "branch param required" }));
      return true;
    }
    const tag = branch.replace(/\//g, "_");
    // Check cache first
    const cacheKey = `rp:search:${tag}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.end(JSON.stringify({ ok: true, branchTag: tag, ...(cached as any), fromCache: true }));
      return true;
    }
    // Fetch live
    pollRPLaunches(cfg, tag).then((data) => {
      cacheSet(cacheKey, data, cfg.rpCacheTtlMs);
      res.end(JSON.stringify({ ok: true, branchTag: tag, ...data }));
    }).catch((err) => {
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return true;
  }

  // GET /_api/rp/pipeline-slow — compare 2 most recent successful Slow UT runs triggered by the pipeline
  if (path.startsWith("rp/pipeline-slow")) {
    const cacheKey = "rp:pipeline-slow";
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.end(JSON.stringify({ ok: true, ...cached, fromCache: true }));
      return true;
    }

    const headers: Record<string, string> = {};
    if (cfg.rpToken) headers.Authorization = `Bearer ${cfg.rpToken}`;

    // Get cached Slow UT Jenkins job builds
    const slowJobCache = cacheGet<JenkinsJobCache>("jenkins:e-slow-ut");
    const slowBuilds = (slowJobCache?.builds ?? [])
      .filter((b: any) => b.result === "SUCCESS")
      .sort((a: any, b: any) => b.timestamp - a.timestamp)
      .slice(0, 2);

    if (slowBuilds.length === 0) {
      res.end(JSON.stringify({ ok: true, launches: [], message: "No successful Slow UT builds found" }));
      return true;
    }

    // Get build params for each build to find branch names
    const slowJobUrl = cfg.jenkinsJobs.find((j) => j.id === "e-slow-ut")?.url ?? "";
    const jenkinsProxy = cfg.jenkinsJobs.find((j) => j.id === "e-slow-ut")?.proxy ?? "ut";
    const jenkinsAuth = jenkinsHeaders(cfg, jenkinsProxy);

    Promise.all(
      slowBuilds.map(async (build: any) => {
        try {
          const paramData = await serverFetch(
            `${slowJobUrl}/${build.number}/api/json?tree=${encodeURIComponent("actions[parameters[name,value]]")}`,
            jenkinsAuth,
          );
          let branch = "";
          for (const action of paramData?.actions ?? []) {
            if (action?.parameters) {
              for (const p of action.parameters) {
                if (p?.name === "BUILD") branch = p.value ?? "";
              }
            }
          }
          return { buildNumber: build.number, branch, timestamp: build.timestamp };
        } catch {
          return { buildNumber: build.number, branch: "", timestamp: build.timestamp };
        }
      }),
    ).then(async (buildInfos) => {
      // Fetch RP launches for each branch
      const launches: (RPLaunchCache & { branch: string; buildNumber: number })[] = [];

      for (const info of buildInfos) {
        if (!info.branch) continue;
        const tag = info.branch.replace(/\//g, "_");
        const launchesUrl = `${cfg.rpBaseUrl}/api/v1/${cfg.rpProject}/launch?page.size=5&page.page=1&page.sort=startTime,DESC&filter.cnt.name=${encodeURIComponent(tag + "_slow")}`;
        try {
          const data = await serverFetch(launchesUrl, headers);
          const launch = (data.content ?? []).find((l: any) => l.name?.endsWith("_slow"));
          if (!launch) continue;
          const summary = await serverFetch(`${cfg.rpBaseUrl}/api/v1/${cfg.rpProject}/launch/${launch.id}`, headers);
          const exec = summary.statistics?.executions ?? {};
          launches.push({
            id: summary.id,
            name: summary.name,
            status: summary.status ?? "unknown",
            total: exec.total ?? 0,
            passed: exec.passed ?? 0,
            failed: exec.failed ?? 0,
            skipped: exec.skipped ?? 0,
            startTime: summary.startTime,
            endTime: summary.endTime,
            url: `${cfg.rpBaseUrl}/ui/#/${cfg.rpProject}/launches/all/${summary.id}`,
            branch: info.branch,
            buildNumber: info.buildNumber,
          });
        } catch { /* skip this one */ }
      }

      const result = { launches };
      cacheSet(cacheKey, result, cfg.rpCacheTtlMs);
      res.end(JSON.stringify({ ok: true, ...result }));
    }).catch((err) => {
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return true;
  }

  // GET /_api/rp/pipeline-quick — compare 2 most recent successful Quick UT runs triggered by the pipeline
  if (path.startsWith("rp/pipeline-quick")) {
    const cacheKey = "rp:pipeline-quick";
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.end(JSON.stringify({ ok: true, ...cached, fromCache: true }));
      return true;
    }

    const headers: Record<string, string> = {};
    if (cfg.rpToken) headers.Authorization = `Bearer ${cfg.rpToken}`;

    // Get cached Quick UT Jenkins job builds
    const quickJobCache = cacheGet<JenkinsJobCache>("jenkins:e-quick-ut");
    const quickBuilds = (quickJobCache?.builds ?? [])
      .filter((b: any) => b.result === "SUCCESS")
      .sort((a: any, b: any) => b.timestamp - a.timestamp)
      .slice(0, 2);

    if (quickBuilds.length === 0) {
      res.end(JSON.stringify({ ok: true, launches: [], message: "No successful Quick UT builds found" }));
      return true;
    }

    const quickJobUrl = cfg.jenkinsJobs.find((j) => j.id === "e-quick-ut")?.url ?? "";
    const jenkinsProxy = cfg.jenkinsJobs.find((j) => j.id === "e-quick-ut")?.proxy ?? "ut";
    const jenkinsAuth = jenkinsHeaders(cfg, jenkinsProxy);

    Promise.all(
      quickBuilds.map(async (build: any) => {
        try {
          const paramData = await serverFetch(
            `${quickJobUrl}/${build.number}/api/json?tree=${encodeURIComponent("actions[parameters[name,value]]")}`,
            jenkinsAuth,
          );
          let branch = "";
          for (const action of paramData?.actions ?? []) {
            if (action?.parameters) {
              for (const p of action.parameters) {
                if (p?.name === "BUILD") branch = p.value ?? "";
              }
            }
          }
          return { buildNumber: build.number, branch, timestamp: build.timestamp };
        } catch {
          return { buildNumber: build.number, branch: "", timestamp: build.timestamp };
        }
      }),
    ).then(async (buildInfos) => {
      const launches: (RPLaunchCache & { branch: string; buildNumber: number })[] = [];

      for (const info of buildInfos) {
        if (!info.branch) continue;
        const tag = info.branch.replace(/\//g, "_");
        const launchesUrl = `${cfg.rpBaseUrl}/api/v1/${cfg.rpProject}/launch?page.size=5&page.page=1&page.sort=startTime,DESC&filter.cnt.name=${encodeURIComponent(tag + "_quick")}`;
        try {
          const data = await serverFetch(launchesUrl, headers);
          const launch = (data.content ?? []).find((l: any) => l.name?.endsWith("_quick"));
          if (!launch) continue;
          const summary = await serverFetch(`${cfg.rpBaseUrl}/api/v1/${cfg.rpProject}/launch/${launch.id}`, headers);
          const exec = summary.statistics?.executions ?? {};
          launches.push({
            id: summary.id,
            name: summary.name,
            status: summary.status ?? "unknown",
            total: exec.total ?? 0,
            passed: exec.passed ?? 0,
            failed: exec.failed ?? 0,
            skipped: exec.skipped ?? 0,
            startTime: summary.startTime,
            endTime: summary.endTime,
            url: `${cfg.rpBaseUrl}/ui/#/${cfg.rpProject}/launches/all/${summary.id}`,
            branch: info.branch,
            buildNumber: info.buildNumber,
          });
        } catch { /* skip this one */ }
      }

      const result = { launches };
      cacheSet(cacheKey, result, cfg.rpCacheTtlMs);
      res.end(JSON.stringify({ ok: true, ...result }));
    }).catch((err) => {
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return true;
  }

  // GET /_api/rp/previous?branch=...&type=slow|quick — fetch the second-most-recent launch for a type
  if (path.startsWith("rp/previous")) {
    const urlObj = new URL(url, "http://localhost");
    const branch = urlObj.searchParams.get("branch") ?? "";
    const utType = urlObj.searchParams.get("type") as "quick" | "slow" | null;
    if (!branch || !utType) {
      res.end(JSON.stringify({ ok: false, error: "branch and type params required" }));
      return true;
    }
    const tag = branch.replace(/\//g, "_");
    const cacheKey = `rp:previous:${tag}:${utType}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.end(JSON.stringify({ ok: true, branchTag: tag, launch: cached, fromCache: true }));
      return true;
    }

    const headers: Record<string, string> = {};
    if (cfg.rpToken) headers.Authorization = `Bearer ${cfg.rpToken}`;
    const launchesUrl = `${cfg.rpBaseUrl}/api/v1/${cfg.rpProject}/launch?page.size=20&page.page=1&page.sort=startTime,DESC&filter.cnt.name=${encodeURIComponent(tag)}`;

    serverFetch(launchesUrl, headers).then(async (data) => {
      const launches: any[] = data.content ?? [];
      const matches = launches.filter((l: any) => l.name?.endsWith(`_${utType}`));
      const prev = matches[1]; // second match = previous run
      if (!prev) {
        res.end(JSON.stringify({ ok: true, branchTag: tag, launch: null }));
        return;
      }
      const summary = await serverFetch(`${cfg.rpBaseUrl}/api/v1/${cfg.rpProject}/launch/${prev.id}`, headers);
      const exec = summary.statistics?.executions ?? {};
      const entry: RPLaunchCache = {
        id: summary.id,
        name: summary.name,
        status: summary.status ?? "unknown",
        total: exec.total ?? 0,
        passed: exec.passed ?? 0,
        failed: exec.failed ?? 0,
        skipped: exec.skipped ?? 0,
        startTime: summary.startTime,
        endTime: summary.endTime,
        url: `${cfg.rpBaseUrl}/ui/#/${cfg.rpProject}/launches/all/${summary.id}`,
      };
      cacheSet(cacheKey, entry, cfg.rpCacheTtlMs);
      res.end(JSON.stringify({ ok: true, branchTag: tag, launch: entry }));
    }).catch((err) => {
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return true;
  }

  // GET /_api/status — health check
  if (path === "status") {
    res.end(JSON.stringify({
      ok: true,
      cacheSize: cache.size,
      wsClients: wsClients.size,
      uptime: process.uptime(),
    }));
    return true;
  }

  // GET /_api/impact — cached Impact Analyser status
  if (path === "impact" || path === "impact/") {
    const data = cacheGet("impact:status");
    res.end(JSON.stringify({ ok: !!data, ...(data as any ?? {}) }));
    return true;
  }

  // GET /_api/sbom — cached SBOM upload summary (from CVE-BUILD console)
  if (path === "sbom" || path === "sbom/") {
    const data = cacheGet<SbomSummaryCache>("sbom:latest");
    res.end(JSON.stringify({ ok: !!data, data }));
    return true;
  }

  // GET /_api/s3-cve — cached S3 CVE-output poller state. Returns the
  // newest matching object's key + lastModified so the frontend can decide
  // whether the SBOM/CVE workflow for the current pipeline run has reached S3.
  if (path === "s3-cve" || path === "s3-cve/") {
    const data = cacheGet<S3CveCache>("s3:cve-latest");
    res.end(JSON.stringify({ ok: !!data, data }));
    return true;
  }

  // GET /_api/all — single request returns ALL cached data (fast initial load)
  if (path === "all" || path === "all/") {
    // Wait for first poll to complete (with a short timeout) so the first
    // request after server start doesn't return all nulls
    await Promise.race([firstPollReady, new Promise((r) => setTimeout(r, 8000))]);

    const jobs: Record<string, JenkinsJobCache | null> = {};
    for (const job of cfg.jenkinsJobs) {
      jobs[job.id] = cacheGet<JenkinsJobCache>(`jenkins:${job.id}`);
    }
    const rp = cacheGet("rp:latest");
    const rpBranch = cacheGet<string>("rp:branch-tag-used") ?? "";
    const impact = cacheGet("impact:status");
    const sbom = cacheGet<SbomSummaryCache>("sbom:latest");
    const s3 = cacheGet<S3CveCache>("s3:cve-latest");
    res.end(JSON.stringify({
      ok: true,
      ts: Date.now(),
      jenkins: { jobs },
      rp: { branchTag: rpBranch, ...(rp as any) },
      impact: impact ?? null,
      sbom: sbom ?? null,
      s3Cve: s3 ?? null,
    }));
    return true;
  }

  // POST /_api/jira/upload-current-run — uploads current-pipeline-run
  // artifacts to the configured Jira issue. Hard-capped to prevent
  // accidental bulk uploads (e.g. impact-analyser's ~100k file dumps).
  if (path === "jira/upload-current-run" && req.method === "POST") {
    await handleJiraUpload(req, res, cfg);
    return true;
  }

  // GET /_api/console-export/:jobId/:buildNumber?mode=full|sbom-tail
  // Returns the console log as a downloadable text/plain attachment.
  // Used by the synthetic console artifacts surfaced for e-orchestrator
  // (full log) and e-nios-build (SBOM "STEP 1 … Finished" slice).
  const consoleExportMatch = /^console-export\/([^/?]+)\/(\d+)(?:\?|$)/.exec(path);
  if (consoleExportMatch) {
    const [, jobId, buildStr] = consoleExportMatch;
    const buildNumber = parseInt(buildStr, 10);
    const job = cfg.jenkinsJobs.find((j) => j.id === jobId);
    if (!job) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Job not found" }));
      return true;
    }
    const modeParam = new URL(req.url ?? "", "http://localhost").searchParams.get("mode");
    const mode: "full" | "sbom-tail" = modeParam === "sbom-tail" ? "sbom-tail" : "full";
    const text = await getConsoleExportText(cfg, job, buildNumber, mode);
    if (text == null) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Console fetch failed" }));
      return true;
    }
    const fileName = mode === "sbom-tail"
      ? `${jobId}-#${buildNumber}-sbom-summary.txt`
      : `${jobId}-#${buildNumber}-console.txt`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.end(text);
    return true;
  }

  // SSE: GET /_api/console/:jobId/:buildNumber
  const consoleMatch = path.match(/^console\/([^/]+)\/(\d+)$/);
  if (consoleMatch) {
    const [, jobId, buildStr] = consoleMatch;
    const buildNumber = parseInt(buildStr, 10);
    const job = cfg.jenkinsJobs.find((j) => j.id === jobId);
    if (!job) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Job not found" }));
      return true;
    }
    streamConsole(req, res, cfg, job, buildNumber);
    return true;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "Not found" }));
  return true;
}

// ─── SSE Console Streaming ──────────────────────────────────────────────────

function streamConsole(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: PluginConfig,
  job: { id: string; url: string; proxy: string },
  buildNumber: number,
): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const headers = jenkinsHeaders(cfg, job.proxy);
  let offset = 0;
  let closed = false;

  req.on("close", () => { closed = true; });

  const poll = async () => {
    if (closed) return;
    try {
      const result = await serverFetchText(
        `${job.url}/${buildNumber}/logText/progressiveText?start=${offset}`,
        headers,
      );
      const text = result.text;
      const more = (result.headers["x-more-data"] ?? "").toLowerCase() === "true";
      const newOffset = Number(result.headers["x-text-size"]) || offset + text.length;

      if (text.length > 0) {
        res.write(`data: ${JSON.stringify({ text, offset: newOffset, more })}\n\n`);
        offset = newOffset;
      }

      if (more && !closed) {
        setTimeout(poll, 10_000); // Stream console at 10s intervals
      } else {
        res.write(`data: ${JSON.stringify({ done: true, offset })}\n\n`);
        res.end();
      }
    } catch (err: any) {
      if (!closed) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      }
    }
  };

  poll();
}

// ─── Plugin export ──────────────────────────────────────────────────────────

export function backendPlugin(): Plugin {
  let cfg: PluginConfig;

  return {
    name: "dashboard-backend",
    configureServer(server: ViteDevServer) {
      // Load ALL env vars from .env.local (empty prefix = load everything, not just VITE_*)
      const env = loadEnv("development", process.cwd(), "");
      cfg = buildConfig(env);

      // WebSocket server — noServer mode, manually handle upgrades only for /_ws
      wss = new WebSocketServer({ noServer: true });
      wss.on("connection", (ws) => {
        wsClients.add(ws);
        // Send current cached state immediately — zero-latency hydration
        const jobs: Record<string, any> = {};
        for (const job of cfg.jenkinsJobs) {
          jobs[job.id] = cacheGet(`jenkins:${job.id}`);
        }
        ws.send(JSON.stringify({
          type: "init",
          payload: {
            jenkins: jobs,
            rp: cacheGet("rp:latest"),
            branchTag: cacheGet("rp:branch-tag-used"),
            impact: cacheGet("impact:status"),
            sbom: cacheGet("sbom:latest"),
            s3Cve: cacheGet("s3:cve-latest"),
          },
          ts: Date.now(),
        }));
        ws.on("close", () => wsClients.delete(ws));
        ws.on("error", () => wsClients.delete(ws));

        // Kick a fresh poll in the background — if the cache was stale or a
        // pipeline is running, the subsequent broadcast() lands on this
        // client within ~1s, eliminating the stale-flash on page refresh.
        const anyRunning = Object.values(jobs).some(
          (j: any) => j?.lastBuild?.building === true,
        );
        const cacheAge = Date.now() - lastJenkinsPollAt;
        if (anyRunning || cacheAge > cfg.pollIntervalMs) {
          ensureFreshJenkins(2500, anyRunning ? 0 : cfg.pollIntervalMs)
            .catch(() => { /* best-effort */ });
        }
      });

      // Intercept upgrade BEFORE Vite's HMR WebSocket gets it
      server.httpServer?.on("upgrade", (req, socket, head) => {
        if (req.url === "/_ws" || req.url?.startsWith("/_ws?")) {
          wss!.handleUpgrade(req, socket, head, (ws) => {
            wss!.emit("connection", ws, req);
          });
        }
      });
      console.log("[backend] WebSocket server ready at /_ws");

      // REST middleware — runs before Vite's proxy
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/_api/")) {
          handleApiRequest(req, res, cfg).catch(() => {
            if (!res.writableEnded) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: "Internal error" }));
            }
          });
        } else {
          next();
        }
      });

      // Start pollers
      startPollers(cfg);

      // Cleanup on server close
      server.httpServer?.on("close", () => {
        stopPollers();
        wss?.close();
        wsClients.clear();
        console.log("[backend] Pollers and WebSocket stopped");
      });
    },

    // Inject cached data directly into HTML — zero-latency initial render
    // Wait for first poll to complete so the inline data is fresh (not all nulls)
    async transformIndexHtml() {
      await Promise.race([firstPollReady, new Promise((r) => setTimeout(r, 8000))]);

      // Always force a fresh Jenkins poll before serving HTML so the inline
      // __PREFETCH_DATA__ (if any) matches reality. Capped at 2.5s.
      await ensureFreshJenkins(2500, 0);

      const jobs: Record<string, JenkinsJobCache | null> = {};
      for (const job of cfg.jenkinsJobs) {
        jobs[job.id] = cacheGet<JenkinsJobCache>(`jenkins:${job.id}`);
      }
      const anyRunning = Object.values(jobs).some(
        (j) => j?.lastBuild?.building === true,
      );

      // When a pipeline run is currently in progress, do NOT inject inline
      // prefetch data. The frontend will fall back to fetching /_api/all on
      // mount, guaranteeing the first paint shows live state instead of
      // anything potentially cached in the HTML.
      if (anyRunning) {
        return [];
      }

      const rp = cacheGet("rp:latest");
      const rpBranch = cacheGet<string>("rp:branch-tag-used") ?? "";
      const impact = cacheGet("impact:status");
      const sbom = cacheGet<SbomSummaryCache>("sbom:latest");
      const s3Cve = cacheGet<S3CveCache>("s3:cve-latest");

      const cacheAgeMs = lastJenkinsPollAt > 0 ? Date.now() - lastJenkinsPollAt : -1;
      const inlineData = {
        ok: true,
        ts: Date.now(),
        cacheAgeMs,
        anyRunning: false,
        jenkins: { jobs },
        rp: { branchTag: rpBranch, ...(rp as any) },
        impact: impact ?? null,
        sbom: sbom ?? null,
        s3Cve: s3Cve ?? null,
      };

      // Escape </script> in JSON to prevent XSS
      const json = JSON.stringify(inlineData).replace(/<\//g, "<\\/");

      return [
        {
          tag: "script",
          children: `window.__PREFETCH_DATA__=${json};`,
          injectTo: "head" as const,
        },
      ];
    },
  };
}
