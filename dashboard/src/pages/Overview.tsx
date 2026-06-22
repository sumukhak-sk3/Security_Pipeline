import { useEffect, useMemo, useState } from "react";
import { currentRun } from "../mock/data";
import WorkflowFlow from "../components/WorkflowFlow";
import JobCard from "../components/JobCard";
import LiveArtifactsPanel from "../components/LiveArtifactsPanel";
import PRStatusCard from "../components/PRStatusCard";
import StatusPill from "../components/StatusPill";
import ProgressBar from "../components/ProgressBar";
import ConsoleDrawer from "../components/ConsoleDrawer";
import WaitingJobCard from "../components/WaitingJobCard";
import type { Job, Status, Workflow } from "../types";
import { formatTime, relTime } from "../lib/format";
import { useWorkflowLiveSummary } from "../hooks/useWorkflowLiveSummary";
import { useSbomSummary } from "../hooks/useSbomSummary";
import { useS3Cve } from "../hooks/useS3Cve";
import { workflowJobSpecs } from "../workflowJobs";
import { awaitPrefetch } from "../api/prefetch";
import { computeSbomPhase, sbomPhaseToStatus, type SbomPhase } from "../lib/sbomPhase";
import { useLiveSyncing } from "../hooks/useLiveSyncing";

export default function Overview() {
  const run = currentRun;
  const [openJob, setOpenJob] = useState<Job | null>(null);
  const [liveBranch, setLiveBranch] = useState<string | null>(null);
  const [liveTriggeredBy, setLiveTriggeredBy] = useState<string | null>(null);
  const { syncing } = useLiveSyncing();

  const eSpecs = useMemo(() => workflowJobSpecs("E"), []);
  const liveE = useWorkflowLiveSummary(eSpecs);
  const liveD = useWorkflowLiveSummary(useMemo(() => workflowJobSpecs("D"), []));
  const sbom = useSbomSummary();
  const s3Cve = useS3Cve();

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

  /**
   * Is workflow D stale (not yet triggered in the current pipeline run)?
   *
   * Impact Analyser depends on NIOS Build AND the SBOM/CVE workflow
   * having stored its delta CSV to S3. Once both conditions are met,
   * D is unblocked even if Quick/Slow UT are still running.
   *
   * Therefore D is "stale" when:
   *   (a) D itself hasn't started in this run, AND
   *   (b) NIOS Build hasn't completed in this run, OR
   *       S3 hasn't received a new CVE upload since pipeline start.
   *   When S3 polling is not configured, fall back to "NIOS Build done"
   *   only — same behaviour as before this change.
   */
  const dIsStale = (() => {
    if (pipelineStartTs === 0) return false;
    if (liveD.jobs.some((j) => j.headline?.building)) return false;
    const dLatest = Math.max(...liveD.jobs.map((j) => j.headline?.timestamp ?? 0));
    if (dLatest >= pipelineStartTs) return false; // D already ran in this run

    const niosBuild = liveE.jobs.find((j) => j.id === "e-nios-build")?.headline;
    const niosNotStarted = !niosBuild || niosBuild.timestamp < pipelineStartTs;
    const niosStillBuilding = niosBuild?.building === true;
    if (niosNotStarted || niosStillBuilding) return true;

    // NIOS Build is done for this run — now require the S3 upload.
    if (s3Cve.data?.configured) {
      const s3Ts = s3Cve.data.lastModifiedMs ?? 0;
      return s3Ts < pipelineStartTs;
    }
    return false;
  })();

  // CVE-BUILD live state (powers workflow B)
  const niosBuildLive = liveE.jobs.find((j) => j.id === "e-nios-build");
  const dImpactLive = liveD.jobs.find((j) => j.id === "d-impact");

  /** Derived live status for Workflow B from CVE-BUILD result + SBOM parse + S3 upload */
  const sbomPhase = computeSbomPhase(
    niosBuildLive?.headline ?? null,
    sbom.summary ?? null,
    dImpactLive?.headline ?? null,
    s3Cve.data ?? null,
    pipelineStartTs,
  );
  const liveBStatus = sbomPhaseToStatus(
    sbomPhase,
    niosBuildLive?.headline?.building === true,
  );

  /** Is Workflow B stale? Only when pipeline is running AND CVE-BUILD hasn't started yet. */
  const bIsStale = (() => {
    if (!eAnyBuilding || pipelineStartTs === 0) return false;
    if (niosBuildLive?.headline?.building) return false;
    const niosTs = niosBuildLive?.headline?.timestamp ?? 0;
    return niosTs < pipelineStartTs;
  })();

  // Replace E + D with live aggregated state; B uses derived live status from CVE-BUILD.
  // Then apply cross-workflow staleness: if upstream is still running,
  // force downstream to show "pending" with 0% progress.
  const workflows: Workflow[] = run.workflows.map((w) => {
    if (w.id === "E") return mergeLive(w, liveE, pipelineStartTs);
    if (w.id === "D") {
      const merged = mergeLive(w, liveD, pipelineStartTs);
      if (dIsStale) return {
        ...merged,
        status: "pending" as const,
        progress: 0,
        jobs: merged.jobs.map((j) => ({ ...j, status: "pending" as const, progress: 0 })),
      };
      return merged;
    }
    if (w.id === "B") {
      if (bIsStale) {
        return {
          ...w,
          status: "pending" as const,
          progress: 0,
          jobs: w.jobs.map((j) => ({ ...j, status: "pending" as const, progress: 0 })),
        };
      }
      const bJobs = w.jobs.map((j) => {
        const { status, progress } = bJobStatus(j.id, sbomPhase, niosBuildLive?.headline?.building === true);
        // Mock placeholder steps don't have real backing data — fold them
        // under the parent's status so the expanded view doesn't show
        // "Pending" sub-steps when the parent is already Success/Running.
        const steps = j.steps.map((s) => ({
          ...s,
          status,
          progress: status === "success" ? 100 : status === "pending" ? 0 : progress,
        }));
        return { ...j, status, progress, steps };
      });
      const aggregateProgress = bJobs.length > 0
        ? Math.round(bJobs.reduce((a, j) => a + j.progress, 0) / bJobs.length)
        : liveBStatus.progress;
      return {
        ...w,
        status: liveBStatus.status,
        progress: aggregateProgress,
        jobs: bJobs,
      };
    }
    return w;
  });

  // E, B (now live), and D feed the overall bar
  const liveWorkflows = workflows.filter((w) => w.id === "E" || w.id === "B" || w.id === "D");

  const totalProgress = (() => {
    if (liveWorkflows.length === 0) return 0;
    const adjusted = liveWorkflows.map((w) => {
      if (w.id === "D" && dIsStale) return 0;
      if (w.id === "B" && bIsStale) return 0;
      return w.progress;
    });
    return Math.round(adjusted.reduce((a, p) => a + p, 0) / adjusted.length);
  })();

  // Derive overall pipeline status from live workflow statuses only.
  // Running takes priority over failed so the topbar pill doesn't flip to
  // "Failed" the moment one downstream job fails while others are still going.
  let overallStatus: "running" | "failed" | "success" | "pending";
  if (liveWorkflows.some((w) => w.status === "running")) {
    overallStatus = "running";
  } else if (liveWorkflows.some((w) => w.status === "failed")) {
    overallStatus = "failed";
  } else if (liveWorkflows.every((w) => {
    if (w.id === "D") return !dIsStale && w.status === "success";
    if (w.id === "B") return !bIsStale && w.status === "success";
    return w.status === "success";
  })) {
    overallStatus = "success";
  } else {
    overallStatus = "pending";
  }

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
            {syncing && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
                title="Hydrating with the freshest backend data…"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                SYNCING
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
                  .filter((j) => j.status === "running")
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
          <LiveArtifactsPanel
            // Hide artifacts from downstream jobs that are NOT part of the
            // current pipeline run (e.g. a manually-triggered d-impact build
            // from before this orchestrator run started). Workflow B has no
            // Jenkins jobs of its own so it's not represented here.
            excludeJobIds={dIsStale ? ["d-impact"] : []}
          />
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
  pipelineStartTs: number,
): Workflow {
  const hasAny = live.jobs.some((j) => j.job != null);
  const anyRunning = live.jobsRunning > 0;

  // Anchor the current run on the orchestrator's start (pipelineStartTs).
  // Any job whose lastBuild started at-or-after this anchor is part of
  // the current run and keeps its real status. If we have no anchor yet
  // (e.g. orchestrator hasn't reported), fall back to the earliest
  // building job so we don't accidentally downgrade fresh runs.
  let currentRunStart = pipelineStartTs;
  if (currentRunStart <= 0 && anyRunning) {
    currentRunStart = Math.min(
      ...live.jobs
        .filter((j) => j.headline?.building)
        .map((j) => j.headline!.timestamp),
    );
  }

  const mergedJobs = live.jobs.map((j) => {
    // Downgrade a job to "pending" only when:
    //   1) the pipeline is actively running, AND
    //   2) this job is NOT itself running, AND
    //   3) this job's last build started before the current run anchor
    //      (i.e. it's leftover state from a previous run).
    // Jobs that already completed in the current run keep their real
    // status so the overview shows correct "N / M jobs complete".
    const startedInCurrentRun =
      j.headline != null &&
      currentRunStart > 0 &&
      j.headline.timestamp >= currentRunStart;
    const showPending =
      anyRunning && j.status !== "running" && !startedInCurrentRun;
    const status = showPending ? ("pending" as const) : j.status;
    const progress = showPending ? 0 : j.progress;
    return {
      id: j.id,
      workflowId: w.id,
      name: j.title,
      status,
      progress,
      buildNumber: j.headline?.number,
      jenkinsUrl: j.jenkinsUrl,
      startedAt: j.headline ? new Date(j.headline.timestamp).toISOString() : undefined,
      finishedAt:
        j.headline && !j.headline.building
          ? new Date(j.headline.timestamp + j.headline.duration).toISOString()
          : undefined,
      steps: [],
    };
  });

  // Recompute workflow-level progress from the per-job statuses we just
  // built so the bar reflects "N completed in current run" rather than the
  // hook's looser aggregate (which counted prior-run leftovers as 0%).
  const aggregateProgress = mergedJobs.length > 0
    ? Math.round(mergedJobs.reduce((a, j) => a + j.progress, 0) / mergedJobs.length)
    : live.progress;

  return {
    ...w,
    status: live.loading && !hasAny ? "pending" : live.status,
    progress: aggregateProgress,
    jobs: mergedJobs,
  };
}

/** Map a SBOM phase + NIOS-build state to a per-job status for Workflow B. */
function bJobStatus(
  jobId: string,
  phase: SbomPhase,
  niosBuilding: boolean,
): { status: Status; progress: number } {
  // Workflow B has three jobs: b-extract → b-dtrack → b-s3.
  const order: Record<string, number> = { "b-extract": 0, "b-dtrack": 1, "b-s3": 2 };
  const idx = order[jobId] ?? 0;
  if (phase === "noBuild") return { status: "pending", progress: 0 };
  if (phase === "failed") {
    if (idx === 0) return { status: "failed", progress: 100 };
    return { status: "pending", progress: 0 };
  }
  if (phase === "waiting") {
    if (idx === 0) return { status: "running", progress: niosBuilding ? 40 : 80 };
    return { status: "pending", progress: 0 };
  }
  if (phase === "uploaded") {
    if (idx === 0) return { status: "success", progress: 100 };
    if (idx === 1) return { status: "success", progress: 100 };
    return { status: "running", progress: 60 }; // b-s3 waiting for S3 object
  }
  // phase === "s3"
  return { status: "success", progress: 100 };
}
