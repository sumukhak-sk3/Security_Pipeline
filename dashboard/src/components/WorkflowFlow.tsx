import { Fragment, useState } from "react";
import type { Workflow } from "../types";
import ProgressBar from "./ProgressBar";
import StatusPill from "./StatusPill";
import { cn } from "../lib/cn";
import { Link } from "react-router-dom";
import { workflowShortName } from "../workflows";
import { useCICDStatus } from "../hooks/useCICDStatus";
import { toProxyUrl } from "../api/jenkinsClient";

export default function WorkflowFlow({ workflows }: { workflows: Workflow[] }) {
  return (
    <div className="rounded border border-line bg-surface-1 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">End-to-end pipeline</div>
        </div>
        <Link
          to="/workflows/e"
          className={cn(
            "inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors",
            "bg-accent hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-accent/50",
          )}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Trigger Pipeline
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] xl:items-stretch">
        {workflows.map((w, i) => (
          <Fragment key={w.id}>
            <div className="min-w-0">
              <WorkflowNode w={w} index={i + 1} />
            </div>
            {i < workflows.length - 1 && (
              <div
                className="hidden items-center justify-center text-ink-subtle xl:flex"
                aria-hidden
              >
                →
              </div>
            )}
          </Fragment>
        ))}
        <div
          className="hidden items-center justify-center text-ink-subtle xl:flex"
          aria-hidden
        >
          →
        </div>
        <div className="min-w-0">
          <CICDNode />
        </div>
      </div>
    </div>
  );
}

function WorkflowNode({ w, index }: { w: Workflow; index: number }) {
  return (
    <Link
      to={`/workflows/${w.id}`}
      className={cn(
        "group flex h-full flex-col rounded border border-line bg-surface-1 p-4 transition-colors hover:border-accent/60 hover:bg-surface-2"
      )}
    >
      <div className="flex items-start gap-2">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded bg-surface-2 text-xs font-semibold text-ink-muted group-hover:text-ink">
          {index}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-sm font-medium">{workflowShortName(w.id)}</div>
            <StatusPill status={w.status} className="shrink-0" />
          </div>
        </div>
      </div>
      <div className="mt-3 flex-1 text-xs leading-relaxed text-ink-muted line-clamp-2">{w.description}</div>
      <div className="mt-auto pt-3">
        <ProgressBar value={w.progress} status={w.status} showLabel />
      </div>
      <div className="mt-2 text-[11px] text-ink-subtle">
        {w.jobs.filter((j) => j.status === "success").length} / {w.jobs.length} jobs complete
      </div>
    </Link>
  );
}

function CICDNode() {
  const { status, lastBuild, lastSuccessfulBuild } = useCICDStatus();
  const [triggering, setTriggering] = useState(false);

  // Surface the last successful build on the overview — a single failed
  // latest run shouldn't dominate the card. We still show the failed/running
  // pill so the user knows the most recent attempt's state, but the build
  // `displayBuild` shows the most recent successful build number when one
  // exists, falling back to the latest build attempt otherwise. The status
  // pill always reflects the current/latest build so a failed or running
  // build is not masked by historical successes.
  const displayBuild = lastSuccessfulBuild ?? lastBuild;
  const displayStatus = status;
  const buildLabel =
    lastSuccessfulBuild != null && lastBuild === lastSuccessfulBuild
      ? `Last successful build #${displayBuild}`
      : lastSuccessfulBuild != null
        ? `Last successful build #${lastSuccessfulBuild} (latest #${lastBuild})`
        : lastBuild != null
          ? `Last build #${lastBuild}`
          : "No builds yet";

  const proxyBase = toProxyUrl("https://jenkins-qa2.inca.infoblox.com/job/IB_QA_CI_NIOS_CVE_Analyser");
  const today = new Date().toISOString().slice(0, 10);
  const defaultBranch = `NIOSRFE-8575-${today}`;

  async function handleQuickTrigger(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setTriggering(true);
    try {
      const params = new URLSearchParams();
      params.set("BRANCH", defaultBranch);
      await fetch(`${proxyBase}/buildWithParameters`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
    } finally {
      setTriggering(false);
    }
  }

  return (
    <Link
      to="/cicd"
      className={cn(
        "group flex h-full flex-col rounded border border-line bg-surface-1 p-4 transition-colors hover:border-accent/60 hover:bg-surface-2"
      )}
    >
      <div className="flex items-start gap-2">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded bg-surface-2 text-xs font-semibold text-ink-muted group-hover:text-ink">
          4
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-sm font-medium">CICD Trigger</div>
            <StatusPill status={displayStatus} className="shrink-0" />
          </div>
        </div>
      </div>
      <div className="mt-3 flex-1 text-xs leading-relaxed text-ink-muted line-clamp-2">
        Triggers IB_QA_CI_NIOS_CVE_Analyser on jenkins-qa2 with branch parameter.
      </div>
      <div className="mt-auto pt-3">
        <button
          onClick={handleQuickTrigger}
          disabled={triggering}
          className={cn(
            "w-full rounded bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
          )}
        >
          {triggering ? "Triggering…" : "▶ Trigger"}
        </button>
      </div>
      <div className="mt-2 text-[11px] text-ink-subtle">
        {buildLabel}
      </div>
    </Link>
  );
}
