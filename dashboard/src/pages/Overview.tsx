import { useMemo, useState } from "react";
import { currentRun } from "../mock/data";
import WorkflowFlow from "../components/WorkflowFlow";
import JobCard from "../components/JobCard";
import ArtifactsPanel from "../components/ArtifactsPanel";
import PRStatusCard from "../components/PRStatusCard";
import StatusPill from "../components/StatusPill";
import ProgressBar from "../components/ProgressBar";
import ConsoleDrawer from "../components/ConsoleDrawer";
import type { Job, Workflow } from "../types";
import { formatTime, relTime } from "../lib/format";
import { useWorkflowLiveSummary } from "../hooks/useWorkflowLiveSummary";
import { workflowJobSpecs } from "../workflowJobs";

export default function Overview() {
  const run = currentRun;
  const [openJob, setOpenJob] = useState<Job | null>(null);

  const liveE = useWorkflowLiveSummary(useMemo(() => workflowJobSpecs("E"), []));
  const liveD = useWorkflowLiveSummary(useMemo(() => workflowJobSpecs("D"), []));

  // Replace E + D with live aggregated state; B keeps mock data for now.
  const workflows: Workflow[] = run.workflows.map((w) => {
    if (w.id === "E") return mergeLive(w, liveE);
    if (w.id === "D") return mergeLive(w, liveD);
    return w;
  });

  const totalProgress = Math.round(
    workflows.reduce((acc, w) => acc + w.progress, 0) / workflows.length,
  );

  const activeJob = workflows.flatMap((w) => w.jobs).find((j) => j.status === "running");

  const liveActiveJobs = workflows
    .filter((w) => w.id === "E" || w.id === "D")
    .flatMap((w) => w.jobs.filter((j) => j.status === "running" || j.status === "failed"));

  return (
    <div className="space-y-6">
      <section className="flex items-end justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
            Pipeline run
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{run.id}</h1>
          <div className="mt-1 text-sm text-ink-muted">
            {run.branch} · triggered {relTime(run.startedAt)} by {run.triggeredBy}
          </div>
        </div>
        <div className="text-right">
          <StatusPill status={run.status} />
          <div className="mt-2 w-60">
            <ProgressBar value={totalProgress} status={run.status} showLabel />
          </div>
          <div className="mt-1 text-[11px] text-ink-subtle">
            Started {formatTime(run.startedAt)}
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
            {liveActiveJobs.length === 0 && (
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
  return {
    ...w,
    status: live.loading && !hasAny ? "pending" : live.status,
    progress: live.progress,
    jobs: live.jobs.map((j) => ({
      id: j.id,
      workflowId: w.id,
      name: j.title,
      status: j.status,
      progress: j.progress,
      buildNumber: j.headline?.number,
      jenkinsUrl: j.jenkinsUrl,
      startedAt: j.headline ? new Date(j.headline.timestamp).toISOString() : undefined,
      finishedAt:
        j.headline && !j.headline.building
          ? new Date(j.headline.timestamp + j.headline.duration).toISOString()
          : undefined,
      steps: [],
    })),
  };
}
