import { useEffect, useState } from "react";
import { useJenkinsJob } from "../hooks/useJenkinsJob";
import { useReportPortalLaunch, type ReportPortalLaunchState } from "../hooks/useReportPortal";
import { fetchLatestBuildParams } from "../api/jenkinsClient";
import { fetchCachedJenkinsJob } from "../api/cachedClient";
import { awaitPrefetch } from "../api/prefetch";
import type { JenkinsBuild, JenkinsStage } from "../api/jenkinsClient";
import type { LaunchSummary, FailedItem } from "../api/reportPortalClient";
import StatusPill from "./StatusPill";
import ProgressBar from "./ProgressBar";
import JenkinsConsoleDrawer from "./JenkinsConsoleDrawer";
import ArtifactsCard from "./ArtifactsCard";
import { formatDuration } from "../lib/format";
import { cn } from "../lib/cn";
import { buildStatus, computeProgress, stageStatus } from "../lib/jenkinsMap";

/* ------------------------------------------------------------------ */
/* Local helpers                                                       */
/* ------------------------------------------------------------------ */

function relTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

interface JobProps {
  readonly title: string;
  readonly jenkinsUrl: string;
  /** If provided, fetches UT results from ReportPortal for this branch tag + ut type */
  readonly rpBranchTag?: string;
  /** "quick" or "slow" — determines which RP launch to look up */
  readonly rpUtType?: "quick" | "slow";
  /** When provided, replaces the recent-builds history section in the expanded view. */
  readonly historyOverride?: React.ReactNode;
}

export default function JenkinsJobCard({ title, jenkinsUrl, rpBranchTag, rpUtType, historyOverride }: JobProps) {
  const { loading, job, stages, artifacts, artifactsBuildNumber, error, refresh } = useJenkinsJob(jenkinsUrl);
  const [autoBranch, setAutoBranch] = useState<string | undefined>();
  const [buildParams, setBuildParams] = useState<Record<string, string>>({});

  // When no explicit rpBranchTag with a date is given, fetch the BUILD param
  // from the cache (instant) or fallback to latest Jenkins build.
  useEffect(() => {
    if (!jenkinsUrl) return;

    // Derive job ID from URL for cache lookup
    const id = jenkinsUrl.includes("Quick_UT") ? "e-quick-ut"
      : jenkinsUrl.includes("Slow_UT") ? "e-slow-ut"
      : jenkinsUrl.includes("CVE-BUILD") ? "e-nios-build"
      : jenkinsUrl.includes("NIOS-CVE-Repo") ? "e-orchestrator"
      : jenkinsUrl.includes("NIOS-CVE-Analyser") ? "d-impact" : null;

    const tryCache = async () => {
      if (id) {
        const pre = await awaitPrefetch();
        const cached = pre?.jenkins?.jobs?.[id];
        if (cached?.buildParams) {
          setBuildParams(cached.buildParams);
          if (rpUtType && cached.buildParams.BUILD) {
            setAutoBranch(cached.buildParams.BUILD.replace(/\//g, "_"));
            return;
          }
          if (!rpUtType) return; // Non-UT: we have params, done
        }
        // Fallback: fetch from cache API if prefetch had no data
        if (!cached?.buildParams) {
          try {
            const res = await fetchCachedJenkinsJob(id);
            if (res?.buildParams) {
              setBuildParams(res.buildParams);
              if (rpUtType && res.buildParams.BUILD) {
                setAutoBranch(res.buildParams.BUILD.replace(/\//g, "_"));
                return;
              }
              if (!rpUtType) return;
            }
          } catch { /* ignore */ }
        }
      }
      if (rpUtType) {
        // Fallback to direct Jenkins API call
        const params = await fetchLatestBuildParams(jenkinsUrl);
        setBuildParams(params);
        const build = params["BUILD"] ?? params["BRANCH"] ?? params["branch"] ?? "";
        if (build) {
          setAutoBranch(build.replace(/\//g, "_"));
        }
      }
    };
    tryCache();
  }, [jenkinsUrl, rpBranchTag, rpUtType]);

  // Use explicit branch if it has a date, otherwise use auto-detected branch.
  // If Jenkins is unreachable and autoBranch is unset, fall back to the generic
  // prefix so the RP hook can still search for the latest matching launch.
  const effectiveBranchTag = (rpBranchTag && /\d{4}-\d{2}-\d{2}/.test(rpBranchTag))
    ? rpBranchTag
    : autoBranch ?? (rpUtType ? "bugfix_ubuntu-mirror" : undefined);

  const rp = useReportPortalLaunch(effectiveBranchTag, rpUtType);
  const [open, setOpen] = useState(false);
  const [consoleFor, setConsoleFor] = useState<number | null>(null);

  if (!jenkinsUrl) {
    return <NoJenkinsCard title={title} reason="No Jenkins URL configured" />;
  }
  if (loading && !job) {
    return <SkeletonCard title={title} rp={rp} />;
  }
  if (!job && !error) {
    // No data yet (server hasn't been reachable) — show skeleton, not error
    return <SkeletonCard title={title} rp={rp} />;
  }
  if (error || !job) {
    return (
      <ErrorCard
        title={title}
        jenkinsUrl={jenkinsUrl}
        error={error ?? "Job not found"}
        onRetry={refresh}
        rp={rp}
      />
    );
  }

  const headline: JenkinsBuild | null =
    job.lastBuild?.building ? job.lastBuild : job.lastCompletedBuild;
  const isRunning = !!headline?.building;
  const status = buildStatus(headline);
  const progress = computeProgress(headline, stages?.stages ?? null);
  const buildUrl = headline ? `${jenkinsUrl}/${headline.number}` : jenkinsUrl;

  const headlineConsoleBuild = headline?.number ?? null;

  const finishedAtLabel = (() => {
    if (!headline) return "—";
    if (isRunning) return relTime(headline.timestamp);
    return relTime(headline.timestamp + headline.duration);
  })();
  const durationMs = (() => {
    if (!headline) return 0;
    return isRunning ? Date.now() - headline.timestamp : headline.duration;
  })();

  return (
    <>
      <div className="rounded border border-line bg-surface-1">
        {/* Header row */}
        <div className="flex items-start gap-4 px-4 py-3">
          <button
            className={cn(
              "mt-0.5 text-ink-subtle transition-transform",
              open && "rotate-90",
            )}
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? "Collapse" : "Expand"}
          >
            ▸
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div className="truncate text-sm font-medium">{title}</div>
              <StatusPill status={status} />
            </div>
            <div className="mt-1 text-[11px] text-ink-subtle">{job.name}</div>
            <div className="mt-3">
              <ProgressBar value={progress} status={status} showLabel />
            </div>
            {/* Summary strip — branch + key params */}
            <BuildSummaryStrip params={buildParams} rpUtType={rpUtType} rp={rp} />
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-ink-muted sm:grid-cols-4">
              <Field label="Build">
                {headline ? `#${headline.number}` : "—"}
              </Field>
              <Field label={isRunning ? "Started" : "Finished"}>
                {finishedAtLabel}
              </Field>
              <Field label="Duration">
                {headline ? formatDuration(durationMs) : "—"}
              </Field>
              <Field label="Last success">
                {job.lastSuccessfulBuild
                  ? `#${job.lastSuccessfulBuild.number} · ${relTime(job.lastSuccessfulBuild.timestamp)}`
                  : "—"}
              </Field>
            </div>
            {!isRunning && rp.summary && <RPBadge summary={rp.summary} />}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <button
              onClick={() => setConsoleFor(headlineConsoleBuild)}
              disabled={headlineConsoleBuild == null}
              className="rounded border border-line px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              Console
            </button>
            <a
              href={buildUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded border border-line px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              Open in Jenkins ↗
            </a>
            <button
              onClick={refresh}
              className="rounded border border-line px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              Refresh
            </button>
          </div>
        </div>

        {open && (
          <div className="border-t border-line">
            {!isRunning && rp.summary && <RPResultsSection summary={rp.summary} failedItems={rp.failedItems} />}
            <StagesSection stages={stages?.stages ?? null} />
            <ArtifactsCard
              artifacts={artifacts}
              buildNumber={artifactsBuildNumber}
              jenkinsUrl={jenkinsUrl}
            />
            {historyOverride ?? (
              <HistorySection
                builds={job.builds}
                onOpenConsole={(n) => setConsoleFor(n)}
                jenkinsUrl={jenkinsUrl}
              />
            )}
          </div>
        )}
      </div>

      <JenkinsConsoleDrawer
        open={consoleFor != null}
        title={title}
        jenkinsUrl={jenkinsUrl}
        buildNumber={consoleFor}
        building={isRunning && consoleFor === headlineConsoleBuild}
        onClose={() => setConsoleFor(null)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-sections                                                        */
/* ------------------------------------------------------------------ */

function StagesSection({ stages }: { readonly stages: JenkinsStage[] | null }) {
  if (!stages || stages.length === 0) {
    return (
      <div className="px-4 py-3 text-[11px] text-ink-subtle">
        No pipeline stages available (freestyle job or build still queuing).
      </div>
    );
  }
  return (
    <div className="px-4 py-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
        Stages
      </div>
      <ol className="space-y-1">
        {stages.map((s) => {
          const st = stageStatus(s.status);
          return (
            <li
              key={s.id}
              className="flex items-center gap-3 rounded px-2 py-1 hover:bg-surface-2"
            >
              <StatusPill status={st} />
              <div className="min-w-0 flex-1 truncate text-xs">{s.name}</div>
              <div className="shrink-0 text-[10px] text-ink-subtle">
                {formatDuration(s.durationMillis)}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function HistorySection({
  builds,
  jenkinsUrl,
  onOpenConsole,
}: {
  readonly builds: JenkinsBuild[];
  readonly jenkinsUrl: string;
  readonly onOpenConsole: (n: number) => void;
}) {
  if (!builds || builds.length === 0) return null;
  return (
    <div className="border-t border-line px-4 py-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
        Recent builds
      </div>
      <ul className="space-y-1">
        {builds.map((b) => {
          const st = buildStatus(b);
          return (
            <li
              key={b.number}
              className="flex items-center gap-3 rounded px-2 py-1 hover:bg-surface-2"
            >
              <span className="w-12 shrink-0 font-mono text-[11px] text-ink-muted">
                #{b.number}
              </span>
              <StatusPill status={st} />
              <div className="min-w-0 flex-1 text-[11px] text-ink-muted">
                {relTime(b.timestamp)} · {formatDuration(b.duration || (b.building ? Date.now() - b.timestamp : 0))}
              </div>
              <button
                onClick={() => onOpenConsole(b.number)}
                className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-muted hover:bg-surface-1 hover:text-ink"
              >
                Console
              </button>
              <a
                href={`${jenkinsUrl}/${b.number}`}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-muted hover:bg-surface-1 hover:text-ink"
              >
                Open ↗
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
        {label}
      </div>
      <div className="truncate text-ink">{children}</div>
    </div>
  );
}

function SkeletonCard({ title, rp }: { readonly title: string; readonly rp?: ReportPortalLaunchState }) {
  return (
    <div className="rounded border border-line bg-surface-1 px-4 py-3">
      <div className="flex items-center gap-2">
        <div className="truncate text-sm font-medium">{title}</div>
        <span className="text-[11px] text-ink-subtle">Loading…</span>
      </div>
      <div className="mt-3 h-2 w-full animate-pulse rounded bg-surface-2" />
      {rp?.summary && <RPBadge summary={rp.summary} />}
    </div>
  );
}

function ErrorCard({
  title,
  jenkinsUrl,
  error,
  onRetry,
  rp,
}: {
  readonly title: string;
  readonly jenkinsUrl: string;
  readonly error: string;
  readonly onRetry: () => void;
  readonly rp?: ReportPortalLaunchState;
}) {
  return (
    <div className="rounded border border-status-failed/40 bg-status-failed/5 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-sm font-medium">{title}</div>
        <div className="flex shrink-0 gap-2">
          <a
            href={jenkinsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-line px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            Open in Jenkins ↗
          </a>
          <button
            onClick={onRetry}
            className="rounded border border-line px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            Retry
          </button>
        </div>
      </div>
      <div className="mt-2 text-[11px] text-status-failed">{error}</div>
      <div className="mt-1 text-[10px] text-ink-subtle">
        Jenkins server unreachable — RP report shown below if available.
      </div>
      {rp?.summary && <RPBadge summary={rp.summary} />}
    </div>
  );
}

function NoJenkinsCard({
  title,
  reason,
}: {
  readonly title: string;
  readonly reason: string;
}) {
  return (
    <div className="rounded border border-dashed border-line bg-surface-1 px-4 py-3">
      <div className="flex items-center gap-2">
        <div className="truncate text-sm font-medium text-ink-muted">{title}</div>
        <span className="text-[11px] text-ink-subtle">{reason}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Build summary strip (branch, params, RP inline)                     */
/* ------------------------------------------------------------------ */

function BuildSummaryStrip({
  params,
  rpUtType,
  rp,
}: {
  readonly params: Record<string, string>;
  readonly rpUtType?: "quick" | "slow";
  readonly rp: { summary: LaunchSummary | null; failedItems?: FailedItem[] };
}) {
  if (!params || Object.keys(params).length === 0) return null;

  // Determine card type from params
  const isUT = !!rpUtType;
  const isImpact = !!params.SEVERITIES || !!params.ANALYSIS_MODE;
  const isBuild = !!params.BUILD_PATH && !isUT && !isImpact;

  const branch = params.BUILD ?? params.BUILD_PATH ?? params.BRANCH ?? "";

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded bg-surface-2/60 px-3 py-1.5 text-[11px]">
      {/* Branch */}
      {branch && (
        <span className="inline-flex items-center gap-1">
          <svg className="h-3 w-3 text-ink-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
          </svg>
          <span className="font-medium text-ink">{branch}</span>
        </span>
      )}

      {/* UT-specific: just branch name */}
      {isUT && null}

      {/* Impact-specific: severities, mode, workers, CVEs */}
      {isImpact && (
        <>
          {params.SEVERITIES && (
            <span className="rounded bg-red-500/10 px-1.5 py-0.5 font-medium text-red-600 dark:text-red-400">
              {params.SEVERITIES}
            </span>
          )}
          {params.ANALYSIS_MODE && (
            <span className="text-ink-muted">
              mode: <span className="font-medium text-ink">{params.ANALYSIS_MODE}</span>
            </span>
          )}
          {params.WORKERS && (
            <span className="text-ink-muted">
              {params.WORKERS} workers
            </span>
          )}
          {params.LIMIT && params.LIMIT !== "0" && (
            <span className="text-ink-muted">
              limit: {params.LIMIT}
            </span>
          )}
          {params.LIMIT === "0" && (
            <span className="text-ink-muted">all CVEs</span>
          )}
        </>
      )}

      {/* Build-specific: just branch + email */}
      {isBuild && params.EMAIL_LIST && (
        <span className="text-ink-muted truncate max-w-[200px]" title={params.EMAIL_LIST}>
          notify: {params.EMAIL_LIST}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ReportPortal inline sections                                        */
/* ------------------------------------------------------------------ */

function RPBadge({ summary }: { readonly summary: LaunchSummary }) {
  const passRate = summary.total > 0 ? Math.round((summary.passed / summary.total) * 100) : 0;
  const hasFails = summary.failed > 0;

  return (
    <div className="mt-2 flex items-center gap-2 whitespace-nowrap rounded bg-surface-2 px-3 py-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
        ReportPortal
      </span>
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-green-600 dark:text-green-400">{summary.passed} passed</span>
        <span className="text-ink-subtle">·</span>
        {hasFails && (
          <>
            <span className="text-red-600 dark:text-red-400">{summary.failed} failed</span>
            <span className="text-ink-subtle">·</span>
          </>
        )}
        <span className="text-ink-muted">{summary.total} total</span>
        <span className="text-ink-subtle">·</span>
        <span className="text-ink-muted">{passRate}%</span>
      </div>
      <a
        href={summary.url}
        target="_blank"
        rel="noopener noreferrer"
        className="ml-auto text-[10px] text-accent hover:underline"
      >
        Open ↗
      </a>
    </div>
  );
}

function RPResultsSection({
  summary,
  failedItems,
}: {
  readonly summary: LaunchSummary;
  readonly failedItems?: FailedItem[];
}) {
  const [showFailed, setShowFailed] = useState(false);

  return (
    <div className="px-4 py-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
        ReportPortal — {summary.name}
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px] text-ink-muted sm:grid-cols-5">
        <div>
          <div className="text-[10px] font-semibold uppercase text-ink-subtle">Status</div>
          <div className={cn(
            "font-medium",
            summary.failed > 0 ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"
          )}>
            {summary.status}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase text-ink-subtle">Total</div>
          <div>{summary.total}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase text-ink-subtle">Passed</div>
          <div className="text-green-600 dark:text-green-400">{summary.passed}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase text-ink-subtle">Failed</div>
          <div className={summary.failed > 0 ? "text-red-600 dark:text-red-400" : ""}>
            {summary.failed}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase text-ink-subtle">Skipped</div>
          <div>{summary.skipped}</div>
        </div>
      </div>

      {failedItems && failedItems.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setShowFailed(!showFailed)}
            className="flex items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-ink"
          >
            <svg
              className={cn("h-3 w-3 transition-transform", showFailed && "rotate-90")}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            {failedItems.length} failed test{failedItems.length > 1 ? "s" : ""}
          </button>

          {showFailed && (
            <div className="mt-2 max-h-60 space-y-2 overflow-y-auto">
              {failedItems.map((item, i) => (
                <RPFailedItemRow key={i} item={item} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RPFailedItemRow({ item }: { readonly item: FailedItem }) {
  const [showLogs, setShowLogs] = useState(false);

  return (
    <div className="rounded bg-surface-2 px-2 py-1.5 text-[11px]">
      <div className="font-medium text-red-600 dark:text-red-400">{item.name}</div>
      {item.path && <div className="text-ink-subtle">{item.path}</div>}
      {item.sampleLogs.length > 0 && (
        <>
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="mt-1 text-[10px] text-accent hover:underline"
          >
            {showLogs ? "Hide logs" : "Show logs"}
          </button>
          {showLogs && (
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-surface-0 p-1.5 font-mono text-[10px] text-ink-muted">
              {item.sampleLogs.map((l) => `[${l.level}] ${l.message}`).join("\n")}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
