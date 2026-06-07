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

      {loading ? (
        <div className="rounded border border-line bg-surface-1 px-4 py-10 text-center text-xs text-ink-subtle">
          Loading build history…
        </div>
      ) : filteredRuns.length === 0 ? (
        <div className="rounded border border-line bg-surface-1 px-4 py-10 text-center text-xs text-ink-subtle">
          No builds found. Jenkins data will appear when connected to the network.
        </div>
      ) : (
        <div className="space-y-3">
          {filteredRuns.map((run) => (
            <div key={run.key} className="rounded border border-line bg-surface-1 overflow-hidden">
              {/* Run header — always visible */}
              <div className="flex items-center gap-4 px-4 py-3">
                {/* Left: date + branch + overall status */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{run.date}</span>
                    <StatusPill status={run.status} />
                    <span className="text-[11px] text-ink-muted">
                      {run.duration > 0 ? formatDuration(run.duration) : ""}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-ink-subtle">
                    {run.branch !== "unknown" ? run.branch : "—"}
                  </div>
                </div>

                {/* Middle: 4 workflow status indicators */}
                <div className="hidden sm:flex items-center gap-3">
                  {PIPELINE_WORKFLOWS.map((pw) => (
                    <div key={pw.id} className="flex flex-col items-center gap-0.5">
                      <StatusDot status={run.jobStatuses[pw.id] ?? "pending"} />
                      <span className="text-[9px] text-ink-subtle">{pw.label}</span>
                    </div>
                  ))}
                </div>

                {/* Right: View button */}
                <button
                  onClick={() => setExpandedRun(expandedRun === run.key ? null : run.key)}
                  className="shrink-0 rounded border border-line px-3 py-1.5 text-xs text-ink-muted hover:bg-surface-2 hover:text-ink transition"
                >
                  {expandedRun === run.key ? "Close" : "View"}
                </button>
              </div>

              {/* Expanded: consolidated table of all builds */}
              {expandedRun === run.key && (
                <div className="border-t border-line">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line/60 text-left text-[10px] font-medium uppercase tracking-wider text-ink-subtle">
                        <th className="px-4 py-2">Job</th>
                        <th className="px-4 py-2">Build #</th>
                        <th className="px-4 py-2">Status</th>
                        <th className="px-4 py-2">Started</th>
                        <th className="px-4 py-2">Duration</th>
                        <th className="px-4 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.builds
                        .sort((a, b) => a.timestamp - b.timestamp)
                        .map((b) => (
                          <tr key={`${b.jobId}-${b.number}`} className="border-b border-line/40 last:border-b-0">
                            <td className="px-4 py-2 text-ink-muted">{b.jobName}</td>
                            <td className="px-4 py-2 font-mono text-xs">#{b.number}</td>
                            <td className="px-4 py-2">
                              <StatusPill status={buildToStatus(b)} />
                            </td>
                            <td className="px-4 py-2 text-ink-muted text-xs">
                              {new Date(b.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            </td>
                            <td className="px-4 py-2 text-ink-muted text-xs">
                              {b.building ? "Running…" : formatDuration(b.duration)}
                            </td>
                            <td className="px-4 py-2 text-right">
                              {b.url && (
                                <a
                                  href={b.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[11px] text-accent hover:underline"
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
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Status dot for compact job indicators ──────────────────────────────── */

function StatusDot({ status }: { status: Status }) {
  const color = {
    success: "bg-status-success",
    failed: "bg-status-failed",
    running: "bg-status-running animate-pulse",
    pending: "bg-surface-3",
  }[status];

  return <div className={`h-2.5 w-2.5 rounded-full ${color}`} />;
}
