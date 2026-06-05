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

// ─── Types ──────────────────────────────────────────────────────────────────

interface CacheEntry<T = unknown> {
  data: T;
  fetchedAt: number;
  ttl: number;
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
const MAX_BACKOFF_MS = 300_000; // 5 minutes max
const FAILURE_THRESHOLD = 3;

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

const FETCH_TIMEOUT_MS = 10_000;

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
    pollIntervalMs: Number(env.VITE_POLL_INTERVAL_MS) || 5000,
    cacheTtlMs: 8000,   // Jenkins cache: 8s (slightly longer than poll interval)
    rpCacheTtlMs: 30000, // RP cache: 30s
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

    return {
      name: jobData.name,
      url: jobData.url,
      lastBuild: jobData.lastBuild,
      lastCompletedBuild: jobData.lastCompletedBuild,
      lastSuccessfulBuild: jobData.lastSuccessfulBuild,
      builds: jobData.builds ?? [],
      stages,
      buildParams,
    };
  } catch (err: any) {
    recordFailure(circuitKey);
    console.error(`[backend] Jenkins poll failed for ${job.id}:`, err.message);
    return null;
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
        url: `${cfg.rpBaseUrl}/ui/#${cfg.rpProject}/launches/all/${summary.id}`,
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
        } else {
          // Poll failed — extend the existing cache entry so stale data stays visible
          const prev = cacheGet<JenkinsJobCache>(`jenkins:${job.id}`);
          if (prev) cacheSet(`jenkins:${job.id}`, prev, cfg.cacheTtlMs);
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
    const result: Record<string, any> = { healthy: null, health: null, indexes: null, latestRun: null };
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

    const prev = cacheGet("impact:status");
    cacheSet("impact:status", result, cfg.cacheTtlMs);
    if (JSON.stringify(prev) !== JSON.stringify(result)) {
      broadcast("impact:update", result);
    }
  };

  // Run first poll eagerly — cache is warm by the time browser requests arrive
  const firstPoll = Promise.allSettled([pollJenkins(), pollImpact()]);
  // RP needs branch from Jenkins, so chain after first Jenkins poll
  firstPoll.then(() => pollRP(cfg));

  pollTimer = setInterval(pollJenkins, cfg.pollIntervalMs);
  rpPollTimer = setInterval(() => pollRP(cfg), cfg.rpCacheTtlMs);
  const impactTimer = setInterval(pollImpact, cfg.pollIntervalMs);

  console.log(`[backend] Pollers started — Jenkins every ${cfg.pollIntervalMs}ms, RP every ${cfg.rpCacheTtlMs}ms`);
}

function stopPollers(): void {
  if (pollTimer) clearInterval(pollTimer);
  if (rpPollTimer) clearInterval(rpPollTimer);
  pollTimer = null;
  rpPollTimer = null;
}

// ─── REST routes (served from cache) ────────────────────────────────────────

function handleApiRequest(req: IncomingMessage, res: ServerResponse, cfg: PluginConfig): boolean {
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

  // GET /_api/all — single request returns ALL cached data (fast initial load)
  if (path === "all" || path === "all/") {
    const jobs: Record<string, JenkinsJobCache | null> = {};
    for (const job of cfg.jenkinsJobs) {
      jobs[job.id] = cacheGet<JenkinsJobCache>(`jenkins:${job.id}`);
    }
    const rp = cacheGet("rp:latest");
    const rpBranch = cacheGet<string>("rp:branch-tag-used") ?? "";
    const impact = cacheGet("impact:status");
    res.end(JSON.stringify({
      ok: true,
      ts: Date.now(),
      jenkins: { jobs },
      rp: { branchTag: rpBranch, ...(rp as any) },
      impact: impact ?? null,
    }));
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
        setTimeout(poll, 1000); // Stream at 1s intervals (much faster than 5s polling)
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
        // Send current cached state immediately
        const jobs: Record<string, any> = {};
        for (const job of cfg.jenkinsJobs) {
          jobs[job.id] = cacheGet(`jenkins:${job.id}`);
        }
        ws.send(JSON.stringify({
          type: "init",
          payload: { jenkins: jobs, rp: cacheGet("rp:latest"), branchTag: cacheGet("rp:branch-tag-used") },
          ts: Date.now(),
        }));
        ws.on("close", () => wsClients.delete(ws));
        ws.on("error", () => wsClients.delete(ws));
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
          handleApiRequest(req, res, cfg);
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
    transformIndexHtml() {
      const jobs: Record<string, JenkinsJobCache | null> = {};
      for (const job of cfg.jenkinsJobs) {
        jobs[job.id] = cacheGet<JenkinsJobCache>(`jenkins:${job.id}`);
      }
      const rp = cacheGet("rp:latest");
      const rpBranch = cacheGet<string>("rp:branch-tag-used") ?? "";
      const impact = cacheGet("impact:status");

      const inlineData = {
        ok: true,
        ts: Date.now(),
        jenkins: { jobs },
        rp: { branchTag: rpBranch, ...(rp as any) },
        impact: impact ?? null,
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
