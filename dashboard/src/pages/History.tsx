import { useEffect, useMemo, useState } from "react";
import { awaitPrefetch } from "../api/prefetch";
import { fetchCachedJenkins, type CachedJenkinsJob } from "../api/cachedClient";
import StatusPill from "../components/StatusPill";
import { formatDuration } from "../lib/format";
import type { Status } from "../types";

/* ─── Types ──────────────────────────────────────────────────────────────── */

interface BuildEntry {
  jobId: string;
  jobName: string;
  number: number;
  result: string | null;
  building: boolean;
  timestamp: number;
  duration: number;
  displayName?: string;
  url?: string;
  branch?: string;
}

/** The 4 pipeline workflow cards matching the Overview */
const PIPELINE_WORKFLOWS = [
  { id: "build-ut", label: "Build & UT" },
  { id: "sbom", label: "SBOM" },
  { id: "impact", label: "Impact" },
  { id: "cicd", label: "CICD" },
] as const;

interface RunGroup {
  key: string;
  branch: string;
  date: string; // YYYY-MM-DD
  startedAt: number;
  builds: BuildEntry[];
  status: Status;
  duration: number;
  /** Status per canonical job */
  jobStatuses: Record<string, Status>;
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function buildToStatus(b: BuildEntry): Status {
  if (b.building) return "running";
  if (b.result === "SUCCESS") return "success";
  if (b.result === "FAILURE" || b.result === "ABORTED") return "failed";
  return "pending";
}

function groupStatus(builds: BuildEntry[]): Status {
  if (builds.some((b) => b.building)) return "running";
  if (builds.some((b) => b.result === "FAILURE" || b.result === "ABORTED")) return "failed";
  if (builds.every((b) => b.result === "SUCCESS")) return "success";
  return "pending";
}

function extractBranch(b: any): string {
  // Try displayName first (often "bugfix/ubuntu-mirror-2026-06-02")
  if (b.displayName && b.displayName.includes("/")) return b.displayName;
  return "";
}

const statusFilters: (Status | "all")[] = ["all", "running", "success", "failed", "pending"];

/* ─── Component ──────────────────────────────────────────────────────────── */

export default function History() {
  const [status, setStatus] = useState<Status | "all">("all");
  const [jobs, setJobs] = useState<Record<string, CachedJenkinsJob | null>>({});
  const [loading, setLoading] = useState(true);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  // Load real build data from backend cache
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pre = await awaitPrefetch();
        if (cancelled) return;
        if (pre?.jenkins?.jobs) {
          setJobs(pre.jenkins.jobs);
        } else {
          const data = await fetchCachedJenkins();
          if (!cancelled) setJobs(data);
        }
      } catch {
        // Fallback: try direct
        try {
          const data = await fetchCachedJenkins();
          if (!cancelled) setJobs(data);
        } catch { /* give up */ }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // Flatten all builds from all jobs into BuildEntry[]
  const allBuilds = useMemo(() => {
    const entries: BuildEntry[] = [];
    for (const [jobId, job] of Object.entries(jobs)) {
      if (!job) continue;
      for (const b of job.builds ?? []) {
        entries.push({
          jobId,
          jobName: job.name,
          number: b.number,
          result: b.result,
          building: b.building ?? false,
          timestamp: b.timestamp,
          duration: b.duration ?? 0,
          displayName: b.displayName,
          url: b.url,
          branch: extractBranch(b),
        });
      }
    }
    return entries.sort((a, b) => b.timestamp - a.timestamp);
  }, [jobs]);

  // Group builds by date (same day = same run)
  const runs = useMemo(() => {
    const groups = new Map<string, BuildEntry[]>();
    for (const build of allBuilds) {
      const date = new Date(build.timestamp).toISOString().slice(0, 10);
      const key = date;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(build);
    }

    const result: RunGroup[] = [];
    for (const [key, builds] of groups) {
      // Determine branch from build displayNames or job params
      const branches = builds.map((b) => b.branch).filter(Boolean);
      const branch = branches[0] || "unknown";
      const earliest = Math.min(...builds.map((b) => b.timestamp));
      const latest = Math.max(...builds.map((b) => b.timestamp + b.duration));

      // Compute per-workflow status for the 4 overview cards
      const jobStatuses: Record<string, Status> = {};

      // Build & UT: combined from nios-build + quick-ut + slow-ut
      const buildUtJobs = builds.filter((b) =>
        b.jobId === "e-nios-build" || b.jobId === "e-quick-ut" || b.jobId === "e-slow-ut"
      );
      if (buildUtJobs.length === 0) {
        jobStatuses["build-ut"] = "pending";
      } else {
        jobStatuses["build-ut"] = groupStatus(buildUtJobs);
      }

      // SBOM: no Jenkins job yet, show pending
      jobStatuses["sbom"] = "pending";

      // Impact: from d-impact job
      const impactBuild = builds.find((b) => b.jobId === "d-impact");
      jobStatuses["impact"] = impactBuild ? buildToStatus(impactBuild) : "pending";

      // CICD: no build data in history yet, show pending
      jobStatuses["cicd"] = "pending";

      result.push({
        key,
        branch,
        date: key,
        startedAt: earliest,
        builds,
        status: groupStatus(builds),
        duration: latest - earliest,
        jobStatuses,
      });
    }
    return result.sort((a, b) => b.startedAt - a.startedAt);
  }, [allBuilds]);

  // Filter by status
  const filteredRuns = useMemo(() => {
    if (status === "all") return runs;
    return runs.filter((r) => r.status === status);
  }, [runs, status]);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
            Pipeline history
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Build History</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Consolidated view of all pipeline runs from Jenkins
          </p>
        </div>
      </div>

      {/* Status filter */}
      <div className="flex items-center gap-1 rounded border border-line bg-surface-1 p-1 w-fit">
        {statusFilters.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={
              "rounded px-2.5 py-1 text-xs capitalize " +
              (status === s ? "bg-surface-2 text-ink font-medium" : "text-ink-muted hover:text-ink")
            }
          >
            {s}
          </button>
        ))}
      </div>

      {(() => {
        if (loading) {
          return (
            <div className="rounded-lg border border-line bg-surface-1 px-4 py-10 text-center text-xs text-ink-subtle">
              Loading build history…
            </div>
          );
        }
        if (filteredRuns.length === 0) {
          return (
            <div className="rounded-lg border border-line bg-surface-1 px-4 py-10 text-center text-xs text-ink-subtle">
              No builds found. Jenkins data will appear when connected to the network.
            </div>
          );
        }
        return (
          <div className="space-y-2">
            {filteredRuns.map((run) => {
              const isOpen = expandedRun === run.key;
              const dateLabel = new Date(run.startedAt).toLocaleDateString(undefined, {
                weekday: "short",
                day: "numeric",
                month: "short",
                year: "numeric",
              });
              const timeLabel = new Date(run.startedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              });
              return (
                <div
                  key={run.key}
                  className="overflow-hidden rounded-lg border border-line bg-surface-1 transition hover:border-line/80"
                >
                  {/* Header row */}
                  <button
                    type="button"
                    onClick={() => setExpandedRun(isOpen ? null : run.key)}
                    className="group flex w-full items-center gap-4 px-4 py-3 text-left"
                  >
                    {/* Status indicator stripe */}
                    <StatusBar status={run.status} />

                    {/* Date + time + branch */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-ink">{dateLabel}</span>
                        <span className="text-[11px] text-ink-subtle">· {timeLabel}</span>
                        <StatusPill status={run.status} />
                      </div>
                      <div className="mt-1 flex items-center gap-3 text-[11px] text-ink-subtle">
                        <span className="truncate font-mono">
                          {run.branch !== "unknown" ? run.branch : "—"}
                        </span>
                        <span>
                          {run.builds.length} build{run.builds.length === 1 ? "" : "s"}
                        </span>
                        {run.duration > 0 && <span>{formatDuration(run.duration)}</span>}
                      </div>
                    </div>

                    {/* Workflow dots */}
                    <div className="hidden items-center gap-4 md:flex">
                      {PIPELINE_WORKFLOWS.map((pw) => (
                        <div key={pw.id} className="flex flex-col items-center gap-1">
                          <StatusDot status={run.jobStatuses[pw.id] ?? "pending"} />
                          <span className="text-[9px] uppercase tracking-wide text-ink-subtle">
                            {pw.label}
                          </span>
                        </div>
                      ))}
                    </div>

                    {/* Chevron */}
                    <span
                      className={
                        "shrink-0 text-ink-subtle transition-transform " +
                        (isOpen ? "rotate-90" : "")
                      }
                    >
                      ▸
                    </span>
                  </button>

                  {/* Expanded details */}
                  {isOpen && (
                    <div className="border-t border-line bg-surface-0/30">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-[10px] font-medium uppercase tracking-wider text-ink-subtle">
                            <th className="px-4 py-2.5 pl-6">Job</th>
                            <th className="px-4 py-2.5">Build</th>
                            <th className="px-4 py-2.5">Status</th>
                            <th className="px-4 py-2.5">Started</th>
                            <th className="px-4 py-2.5">Duration</th>
                            <th className="px-4 py-2.5"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...run.builds]
                            .sort((a, b) => a.timestamp - b.timestamp)
                            .map((b) => (
                              <tr
                                key={`${b.jobId}-${b.number}`}
                                className="border-t border-line/40"
                              >
                                <td className="px-4 py-2.5 pl-6 text-ink">{b.jobName}</td>
                                <td className="px-4 py-2.5 font-mono text-xs text-ink-muted">
                                  #{b.number}
                                </td>
                                <td className="px-4 py-2.5">
                                  <StatusPill status={buildToStatus(b)} />
                                </td>
                                <td className="px-4 py-2.5 text-xs text-ink-muted">
                                  {new Date(b.timestamp).toLocaleTimeString([], {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </td>
                                <td className="px-4 py-2.5 text-xs text-ink-muted">
                                  {b.building ? "Running…" : formatDuration(b.duration)}
                                </td>
                                <td className="px-4 py-2.5 text-right">
                                  {b.url && (
                                    <a
                                      href={b.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-[11px] text-accent hover:underline"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      Jenkins ↗
                                    </a>
                                  )}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}

/* ─── Status bar — left vertical color stripe to scan run statuses ───────── */

function StatusBar({ status }: { readonly status: Status }) {
  const color: Record<Status, string> = {
    success: "bg-status-success",
    failed: "bg-status-failed",
    running: "bg-status-running",
    pending: "bg-surface-3",
    skipped: "bg-surface-3",
  };
  return <span className={`h-10 w-1 shrink-0 rounded-full ${color[status]}`} />;
}

/* ─── Status dot for compact job indicators ──────────────────────────────── */

function StatusDot({ status }: { readonly status: Status }) {
  const color: Record<Status, string> = {
    success: "bg-status-success",
    failed: "bg-status-failed",
    running: "bg-status-running animate-pulse",
    pending: "bg-surface-3",
    skipped: "bg-surface-3",
  };

  return <div className={`h-2.5 w-2.5 rounded-full ${color[status]}`} />;
}
