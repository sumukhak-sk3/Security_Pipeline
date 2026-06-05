import { useMemo, useState } from "react";
import { useParams, Navigate } from "react-router-dom";
import { currentRun } from "../mock/data";
import JobCard from "../components/JobCard";
import StatusPill from "../components/StatusPill";
import ProgressBar from "../components/ProgressBar";
import ConsoleDrawer from "../components/ConsoleDrawer";
import ImpactLivePanel from "../components/ImpactLivePanel";
import JenkinsJobCard from "../components/JenkinsJobCard";
import type { Job, WorkflowId } from "../types";
import { workflowShortName } from "../workflows";
import { config } from "../config";
import { workflowJobSpecs } from "../workflowJobs";
import { useWorkflowLiveSummary } from "../hooks/useWorkflowLiveSummary";

export default function WorkflowPage() {
  const { id } = useParams();
  const [openJob, setOpenJob] = useState<Job | null>(null);

  const wfId = (id ?? "").toUpperCase() as WorkflowId;
  const workflow = currentRun.workflows.find((w) => w.id === wfId);

  const isImpact = wfId === "D";
  const isBuild = wfId === "E";
  const isLive = isImpact || isBuild;

  // Hooks MUST be unconditional — compute spec list before any early return.
  const liveSpecs = useMemo(
    () => (isLive && (wfId === "E" || wfId === "D") ? workflowJobSpecs(wfId) : []),
    [isLive, wfId],
  );
  const live = useWorkflowLiveSummary(liveSpecs);

  if (!workflow) return <Navigate to="/" replace />;

  const redirectUrl = config.impactAnalyser.redirectUrl;
  const redirectLabel = config.impactAnalyser.redirectLabel;

  const headerStatus = isLive ? live.status : workflow.status;
  const headerProgress = isLive ? live.progress : workflow.progress;

  return (
    <div className="space-y-6">
      <section className="flex items-end justify-between gap-4">
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
        <div className="flex flex-col items-end gap-3">
          {isImpact && (
            <a
              href={redirectUrl || "#"}
              target={redirectUrl ? "_blank" : undefined}
              rel={redirectUrl ? "noopener noreferrer" : undefined}
              aria-disabled={!redirectUrl}
              title={
                redirectUrl
                  ? redirectLabel
                  : "Set VITE_IMPACT_REDIRECT_URL to enable"
              }
              onClick={(e) => {
                if (!redirectUrl) e.preventDefault();
              }}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold transition ${
                redirectUrl
                  ? "bg-accent text-white hover:opacity-90"
                  : "cursor-not-allowed bg-surface-2 text-ink-subtle"
              }`}
            >
              {redirectLabel}
              <span aria-hidden>↗</span>
            </a>
          )}
          <div className="text-right">
            <StatusPill status={headerStatus} />
            <div className="mt-2 w-60">
              <ProgressBar value={headerProgress} status={headerStatus} showLabel />
            </div>
            {isLive && (
              <div className="mt-1 text-[10px] text-ink-subtle">
                {live.jobsDone}/{live.jobsTotal} succeeded
                {live.jobsRunning > 0 && ` · ${live.jobsRunning} running`}
                {live.jobsFailed > 0 && ` · ${live.jobsFailed} failed`}
              </div>
            )}
          </div>
        </div>
      </section>

      {isImpact && <ImpactLivePanel />}

      {isLive ? (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Jenkins jobs</h2>
            <span className="text-[11px] text-ink-subtle">
              Live data · auto-refresh every {Math.round(config.api.pollIntervalMs / 1000)}s
            </span>
          </div>
          <div className="space-y-3">
            {liveSpecs.map((j) => (
              <JenkinsJobCard key={j.id} title={j.title} jenkinsUrl={j.jenkinsUrl} />
            ))}
          </div>
        </section>
      ) : (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Jobs</h2>
          <div className="space-y-3">
            {workflow.jobs.map((j) => (
              <JobCard key={j.id} job={j} onOpenConsole={setOpenJob} />
            ))}
          </div>
        </section>
      )}

      <ConsoleDrawer runId={currentRun.id} job={openJob} onClose={() => setOpenJob(null)} />
    </div>
  );
}
