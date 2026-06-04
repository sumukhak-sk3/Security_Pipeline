import { useState } from "react";
import { currentRun } from "../mock/data";
import WorkflowFlow from "../components/WorkflowFlow";
import JobCard from "../components/JobCard";
import ArtifactsPanel from "../components/ArtifactsPanel";
import PRStatusCard from "../components/PRStatusCard";
import StatusPill from "../components/StatusPill";
import ProgressBar from "../components/ProgressBar";
import ConsoleDrawer from "../components/ConsoleDrawer";
import type { Job } from "../types";
import { formatTime, relTime } from "../lib/format";

export default function Overview() {
  const run = currentRun;
  const [openJob, setOpenJob] = useState<Job | null>(null);

  const totalProgress = Math.round(
    run.workflows.reduce((acc, w) => acc + w.progress, 0) / run.workflows.length
  );

  // currently running job across all workflows
  const activeJob = run.workflows
    .flatMap((w) => w.jobs)
    .find((j) => j.status === "running");

  return (
    <div className="space-y-6">
      <section className="flex items-end justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
            Pipeline run
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {run.id}
          </h1>
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

      <WorkflowFlow workflows={run.workflows} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section className="space-y-3 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Active jobs</h2>
            <div className="text-xs text-ink-subtle">
              {activeJob ? `Running: ${activeJob.name}` : "No active jobs"}
            </div>
          </div>
          <div className="space-y-3">
            {run.workflows.flatMap((w) =>
              w.jobs
                .filter((j) => j.status === "running" || j.status === "success")
                .slice(0, 5)
                .map((j) => (
                  <JobCard key={`${w.id}-${j.id}`} job={j} onOpenConsole={setOpenJob} />
                ))
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
