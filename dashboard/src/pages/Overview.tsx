import { useEffect, useMemo, useState } from "react";
import { currentRun } from "../mock/data";
import WorkflowFlow from "../components/WorkflowFlow";
import JobCard from "../components/JobCard";
import ArtifactsPanel from "../components/ArtifactsPanel";
import PRStatusCard from "../components/PRStatusCard";
import StatusPill from "../components/StatusPill";
import ProgressBar from "../components/ProgressBar";
import ConsoleDrawer from "../components/ConsoleDrawer";
import WaitingJobCard from "../components/WaitingJobCard";
import type { Job, Workflow } from "../types";
import { formatTime, relTime } from "../lib/format";
import { useWorkflowLiveSummary } from "../hooks/useWorkflowLiveSummary";
import { workflowJobSpecs } from "../workflowJobs";
import { awaitPrefetch } from "../api/prefetch";

export default function Overview() {
  const run = currentRun;
  const [openJob, setOpenJob] = useState<Job | null>(null);
  const [liveBranch, setLiveBranch] = useState<string | null>(null);
  const [liveTriggeredBy, setLiveTriggeredBy] = useState<string | null>(null);

  const eSpecs = useMemo(() => workflowJobSpecs("E"), []);
  const liveE = useWorkflowLiveSummary(eSpecs);
  const liveD = useWorkflowLiveSummary(useMemo(() => workflowJobSpecs("D"), []));

  // Fetch branch + trigger info from cached build params (re-runs when live data updates)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pre = await awaitPrefetch();
        if (cancelled) return;
        const niosBuild = pre?.jenkins?.jobs?.["e-nios-build"];
        if (niosBuild?.buildParams?.BUILD_PATH) {
          setLiveBranch(niosBuild.buildParams.BUILD_PATH.replace(/^origin\//, ""));
        }
        if (niosBuild?.buildParams?.EMAIL_LIST) {
          const email = niosBuild.buildParams.EMAIL_LIST;
          setLiveTriggeredBy(email.split("@")[0]);
        }
      } catch { /* fallback to mock */ }
    })();
    return () => { cancelled = true; };
  }, [liveE.status]);

  // ----------------------------------------------------------------
  // Cross-workflow pipeline awareness
  // Pipeline chain: E → B → D
  // When E is running, B and D haven't been triggered yet in this run.
  // When B is running (future), D hasn't been triggered yet.
  // We detect staleness so downstream workflows show "pending" instead
  // of misleading historical "success" data.
  // ----------------------------------------------------------------
  const eAnyBuilding = liveE.jobs.some((j) => j.headline?.building === true);
  const pipelineStartTs =
    liveE.jobs.find((j) => j.id === "e-orchestrator")?.headline?.timestamp ?? 0;

  /** Is workflow D stale (not yet triggered in the current pipeline run)? */
  const dIsStale = (() => {
    if (!eAnyBuilding || pipelineStartTs === 0) return false;
    if (liveD.jobs.some((j) => j.headline?.building)) return false;
    const dLatest = Math.max(...liveD.jobs.map((j) => j.headline?.timestamp ?? 0));
    return dLatest < pipelineStartTs;
  })();

  /** Is workflow B stale? B doesn't have live data yet — if E is running, B
   *  definitely hasn't been triggered in this run. */
  const bIsStale = eAnyBuilding && pipelineStartTs > 0;

  // Replace E + D with live aggregated state; B keeps mock data for now.
  // Then apply cross-workflow staleness: if upstream is still running,
  // force downstream to show "pending" with 0% progress.
  const workflows: Workflow[] = run.workflows.map((w) => {
    if (w.id === "E") return mergeLive(w, liveE);
    if (w.id === "D") {
      const merged = mergeLive(w, liveD);
      if (dIsStale) return {
        ...merged,
        status: "pending" as const,
        progress: 0,
        jobs: merged.jobs.map((j) => ({ ...j, status: "pending" as const, progress: 0 })),
      };
      return merged;
    }
    if (w.id === "B" && bIsStale) {
      return {
        ...w,
        status: "pending" as const,
        progress: 0,
        jobs: w.jobs.map((j) => ({ ...j, status: "pending" as const, progress: 0 })),
      };
    }
    return w;
  });

  // Only use live workflows (E + D) for the overall bar — B is still mock data
  const liveWorkflows = workflows.filter((w) => w.id === "E" || w.id === "D");

  const totalProgress = (() => {
    if (liveWorkflows.length === 0) return 0;
    const adjusted = liveWorkflows.map((w) => {
      if (w.id === "D" && dIsStale) return 0;
      return w.progress;
    });
    return Math.round(adjusted.reduce((a, p) => a + p, 0) / adjusted.length);
  })();

  // Derive overall pipeline status from live workflow statuses only
  const overallStatus = liveWorkflows.some((w) => w.status === "failed")
    ? "failed"
    : liveWorkflows.some((w) => w.status === "running")
      ? "running"
      : liveWorkflows.every((w) => w.id === "D" ? !dIsStale && w.status === "success" : w.status === "success")
        ? "success"
        : "pending";

  const activeJob = workflows.flatMap((w) => w.jobs).find((j) => j.status === "running");

  const liveActiveJobs = workflows
    .filter((w) => w.id === "E" || w.id === "D")
    .flatMap((w) => w.jobs.filter((j) => j.status === "running" || j.status === "failed"));
  const eJobById = useMemo(
    () => Object.fromEntries(liveE.jobs.map((j) => [j.id, j])),
    [liveE.jobs],
  );
  const eSpecById = useMemo(
    () => Object.fromEntries(eSpecs.map((s) => [s.id, s])),
    [eSpecs],
  );
  const waitingEJobs = useMemo(() => {
    if (!eAnyBuilding) return [];
    return eSpecs.filter((spec) => {
      if (!spec.dependsOn) return false;
      const thisJob = eJobById[spec.id];
      const upstream = eJobById[spec.dependsOn];
      if (thisJob?.headline?.building) return false;
      if (upstream?.headline?.building) return true;
      if (upstream?.headline && thisJob?.headline) {
        if (thisJob.headline.timestamp < upstream.headline.timestamp && !thisJob.headline.building)
          return true;
      }
      if (!thisJob?.headline && upstream?.headline?.building) return true;
      return false;
    });
  }, [eAnyBuilding, eSpecs, eJobById]);

  // Derive live metadata from the orchestrator/CVE-BUILD headline build
  const orchestratorJob = liveE.jobs.find((j) => j.id === "e-orchestrator");
  const niosBuildJob = liveE.jobs.find((j) => j.id === "e-nios-build");

  // Use latest orchestrator build start time as the pipeline start
  const liveStartedAt = orchestratorJob?.headline
    ? new Date(orchestratorJob.headline.timestamp).toISOString()
    : run.startedAt;

  // Build number as the run ID
  const liveRunId = orchestratorJob?.headline
    ? `NIOS-CVE-Repo #${orchestratorJob.headline.number}`
    : run.id;

  return (
    <div className="space-y-6">
      <section className="flex items-end justify-between">
        <div>
          <div className="flex items-center gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
              Pipeline run
            </div>
            {overallStatus === "running" && (
              <span className="inline-flex items-center gap-1 rounded-full bg-status-running/10 px-2 py-0.5 text-[10px] font-semibold text-status-running">
                <span className="h-1.5 w-1.5 rounded-full bg-status-running animate-pulse" />
                LIVE
              </span>
            )}
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{liveRunId}</h1>
          <div className="mt-1 text-sm text-ink-muted">
            {liveBranch && (
              <span className="font-mono text-xs">{liveBranch}</span>
            )}
            {liveBranch && " · "}
            {liveTriggeredBy
              ? <>triggered by {liveTriggeredBy}</>
              : <>started {relTime(liveStartedAt)}</>
            }
          </div>
          {overallStatus === "running" && activeJob && (
            <div className="mt-1 text-[11px] text-status-running">
              Currently running: <span className="font-medium">{activeJob.name}</span>
            </div>
          )}
        </div>
        <div className="text-right">
          <StatusPill status={overallStatus} />
          <div className="mt-2 w-60">
            <ProgressBar value={totalProgress} status={overallStatus} showLabel />
          </div>
          <div className="mt-1 text-[11px] text-ink-subtle">
            Started {formatTime(liveStartedAt)}
          </div>
        </div>
      </section>

      <WorkflowFlow workflows={workflows} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section className="space-y-3 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Active jobs</h2>
            <div className="text-xs text-ink-subtle">
              {activeJob ? `Running: ${activeJob.name}` : "No active jobs"}
            </div>
          </div>
          <div className="space-y-3">
            {liveActiveJobs.map((j) => (
              <JobCard key={`live-${j.workflowId}-${j.id}`} job={j} onOpenConsole={setOpenJob} />
            ))}
            {waitingEJobs.map((spec) => (
              <WaitingJobCard
                key={`wait-${spec.id}`}
                title={spec.title}
                waitingFor={eSpecById[spec.dependsOn!]?.title ?? spec.dependsOn!}
                description={spec.waitDescription}
                step={eSpecs.indexOf(spec) + 1}
                totalSteps={eSpecs.length}
              />
            ))}
            {workflows
              .filter((w) => w.id === "B")
              .flatMap((w) =>
                w.jobs
                  .filter((j) => j.status === "running" || j.status === "success")
                  .slice(0, 3)
                  .map((j) => (
                    <JobCard key={`${w.id}-${j.id}`} job={j} onOpenConsole={setOpenJob} />
                  )),
              )}
            {liveActiveJobs.length === 0 && waitingEJobs.length === 0 && (
              <div className="rounded border border-dashed border-line bg-surface-1 px-4 py-6 text-center text-xs text-ink-subtle">
                No live jobs running for Build &amp; Unit Tests or Impact Analysis.
                Open a workflow page to see its latest build details.
              </div>
            )}
          </div>
        </section>

        <section className="space-y-4">
          <ArtifactsPanel artifacts={run.artifacts} />
          <PRStatusCard pr={run.pr} />
        </section>
      </div>

      <ConsoleDrawer runId={run.id} job={openJob} onClose={() => setOpenJob(null)} />
    </div>
  );
}

/** Merge live Jenkins state into a mock Workflow shell. */
function mergeLive(
  w: Workflow,
  live: ReturnType<typeof useWorkflowLiveSummary>,
): Workflow {
  const hasAny = live.jobs.some((j) => j.job != null);
  const anyRunning = live.jobsRunning > 0;

  return {
    ...w,
    status: live.loading && !hasAny ? "pending" : live.status,
    progress: live.progress,
    jobs: live.jobs.map((j) => {
      // If any job in this workflow is building, non-running jobs show pending
      // (no historical data during an active run).
      const showPending = anyRunning && j.status !== "running";
      return {
        id: j.id,
        workflowId: w.id,
        name: j.title,
        status: showPending ? "pending" as const : j.status,
        progress: showPending ? 0 : j.progress,
        buildNumber: j.headline?.number,
        jenkinsUrl: j.jenkinsUrl,
        startedAt: j.headline ? new Date(j.headline.timestamp).toISOString() : undefined,
        finishedAt:
          j.headline && !j.headline.building
            ? new Date(j.headline.timestamp + j.headline.duration).toISOString()
            : undefined,
        steps: [],
      };
    }),
  };
}
