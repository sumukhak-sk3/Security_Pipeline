import { useMemo, useState } from "react";
import { useParams, Navigate } from "react-router-dom";
import { currentRun } from "../mock/data";
import JobCard from "../components/JobCard";
import StatusPill from "../components/StatusPill";
import ProgressBar from "../components/ProgressBar";
import ConsoleDrawer from "../components/ConsoleDrawer";
import ImpactLivePanel from "../components/ImpactLivePanel";
import SBOMPanel from "../components/SBOMPanel";
import JenkinsJobCard from "../components/JenkinsJobCard";
import type { Job, WorkflowId } from "../types";
import { workflowShortName } from "../workflows";
import { config } from "../config";
import { workflowJobSpecs } from "../workflowJobs";
import { useWorkflowLiveSummary } from "../hooks/useWorkflowLiveSummary";
import { triggerWorkflowE } from "../api/triggerJenkins";
import { cn } from "../lib/cn";

export default function WorkflowPage() {
  const { id } = useParams();
  const [openJob, setOpenJob] = useState<Job | null>(null);
  // Branch for RP lookup:
  // - Empty string = no explicit override → RP client searches for latest "bugfix_ubuntu-mirror" launch
  // - User types a branch in TriggerPanel → uses that specific branch tag
  const [rpBranch, setRpBranch] = useState("");

  const wfId = (id ?? "").toUpperCase() as WorkflowId;
  const workflow = currentRun.workflows.find((w) => w.id === wfId);

  const isImpact = wfId === "D";
  const isBuild = wfId === "E";
  const isSBOM = wfId === "B";
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

      {/* SBOM (B) runs in parallel — always show its own live state */}
      {isSBOM && <SBOMPanel />}

      {isBuild && <TriggerPanel onBranchChange={setRpBranch} />}

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
              <JenkinsJobCard
                key={j.id}
                title={j.title}
                jenkinsUrl={j.jenkinsUrl}
                rpBranchTag={
                  (j.id === "e-quick-ut" || j.id === "e-slow-ut")
                    ? (rpBranch.trim()
                        ? rpBranch.trim().replace(/\//g, "_")
                        : "bugfix_ubuntu-mirror")
                    : undefined
                }
                rpUtType={
                  j.id === "e-quick-ut" ? "quick"
                    : j.id === "e-slow-ut" ? "slow"
                    : undefined
                }
              />
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

/* ------------------------------------------------------------------ */
/* Trigger Panel — branch input + fire button for Workflow E           */
/* ------------------------------------------------------------------ */

function TriggerPanel({ onBranchChange }: { onBranchChange?: (branch: string) => void }) {
  const [branch, setBranch] = useState("");
  const [activeAction, setActiveAction] = useState<"none" | "test" | "trigger">("none");
  const [result, setResult] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const placeholder = `bugfix/ubuntu-mirror-${new Date().toISOString().slice(0, 10)}`;
  const busy = activeAction !== "none";

  const handleBranchChange = (value: string) => {
    setBranch(value);
    // Pass empty string when input is cleared → triggers broad "latest" search
    onBranchChange?.(value);
  };

  const handleTrigger = async () => {
    setActiveAction("trigger");
    setResult(null);
    const res = await triggerWorkflowE({ dryRun: false, branch });
    if (res.ok) {
      setResult({
        type: "success",
        msg: res.queueUrl ? `Triggered! Queue: ${res.queueUrl}` : "Build triggered successfully",
      });
    } else {
      setResult({ type: "error", msg: res.error ?? `HTTP ${res.status}` });
    }
    setActiveAction("none");
    setTimeout(() => setResult(null), 6000);
  };

  const handleDryRun = async () => {
    setActiveAction("test");
    setResult(null);
    const res = await triggerWorkflowE({ dryRun: true });
    if (res.ok) {
      setResult({ type: "success", msg: "✓ Jenkins reachable — auth OK, ready to trigger" });
    } else {
      setResult({ type: "error", msg: res.error ?? `HTTP ${res.status}` });
    }
    setActiveAction("none");
    setTimeout(() => setResult(null), 5000);
  };

  return (
    <section className="rounded border border-line bg-surface-1 p-5">
      <div className="mb-3">
        <h2 className="text-sm font-semibold">Trigger Build</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Start the NIOS-CVE-Repo orchestrator. It will sync the Ubuntu mirror,
          create/push a branch, and trigger the NIOS build + UT jobs.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="branch-input" className="mb-1 block text-xs font-medium text-ink-subtle">
            Branch name <span className="text-ink-muted">(optional — leave empty for auto-generated)</span>
          </label>
          <input
            id="branch-input"
            type="text"
            value={branch}
            onChange={(e) => handleBranchChange(e.target.value)}
            placeholder={placeholder}
            className="w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleDryRun}
            disabled={busy}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-2 text-sm font-medium transition-colors",
              "bg-surface-2 text-ink hover:bg-surface-1",
              activeAction === "test" && "cursor-wait opacity-70",
            )}
          >
            {activeAction === "test" ? (
              <>
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Testing…
              </>
            ) : (
              "Test Connection"
            )}
          </button>
          <button
            onClick={handleTrigger}
            disabled={busy}
            className={cn(
              "inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors",
              "bg-accent hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-accent/50",
              activeAction === "trigger" && "cursor-wait opacity-70",
            )}
          >
            {activeAction === "trigger" ? (
              <>
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Triggering…
              </>
            ) : (
              <>
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Trigger Build
              </>
            )}
          </button>
        </div>
      </div>

      {result && (
        <div
          className={cn(
            "mt-3 rounded px-3 py-2 text-xs",
            result.type === "success" && "border border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300",
            result.type === "error" && "border border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300",
          )}
        >
          {result.msg}
        </div>
      )}

      <div className="mt-3 text-[11px] text-ink-subtle">
        Default: <code className="rounded bg-surface-2 px-1 py-0.5">{placeholder}</code> · 
        Orchestrator: <code className="rounded bg-surface-2 px-1 py-0.5">NIOS-CVE-Repo</code>
      </div>
    </section>
  );
}
