import { useState } from "react";
import { useParams, Navigate } from "react-router-dom";
import { currentRun } from "../mock/data";
import JobCard from "../components/JobCard";
import StatusPill from "../components/StatusPill";
import ProgressBar from "../components/ProgressBar";
import ConsoleDrawer from "../components/ConsoleDrawer";
import type { Job, WorkflowId } from "../types";
import { workflowShortName } from "../workflows";

export default function WorkflowPage() {
  const { id } = useParams();
  const [openJob, setOpenJob] = useState<Job | null>(null);

  const wfId = (id ?? "").toUpperCase() as WorkflowId;
  const workflow = currentRun.workflows.find((w) => w.id === wfId);
  if (!workflow) return <Navigate to="/" replace />;

  return (
    <div className="space-y-6">
      <section className="flex items-end justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
            Workflow {workflow.id}
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {workflowShortName(workflow.id)}
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-muted">
            {workflow.description}
          </p>
        </div>
        <div className="text-right">
          <StatusPill status={workflow.status} />
          <div className="mt-2 w-60">
            <ProgressBar value={workflow.progress} status={workflow.status} showLabel />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Jobs</h2>
        <div className="space-y-3">
          {workflow.jobs.map((j) => (
            <JobCard key={j.id} job={j} onOpenConsole={setOpenJob} />
          ))}
        </div>
      </section>

      <ConsoleDrawer runId={currentRun.id} job={openJob} onClose={() => setOpenJob(null)} />
    </div>
  );
}
