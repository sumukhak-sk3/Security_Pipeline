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
import WaitingJobCard from "../components/WaitingJobCard";
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

  // Cross-workflow awareness: always poll E so D and B know when upstream is running
  const eSpecs = useMemo(() => workflowJobSpecs("E"), []);
  const liveE = useWorkflowLiveSummary(eSpecs);

  // Is Workflow E currently running? (orchestrator or any E job building)
  const eIsRunning = liveE.jobs.some((j) => j.headline?.building === true);
  const pipelineStartTs =
    liveE.jobs.find((j) => j.id === "e-orchestrator")?.headline?.timestamp ?? 0;

  // Is this downstream workflow stale (not yet triggered in current pipeline run)?
  const isStale = useMemo(() => {
    if (!eIsRunning || pipelineStartTs === 0) return false;
    if (wfId === "E") return false; // E is the upstream, it's never "stale"
    if (wfId === "D") {
      // If D itself is building, it's current
      if (live.jobs.some((j) => j.headline?.building)) return false;
      const dLatest = Math.max(...live.jobs.map((j) => j.headline?.timestamp ?? 0));
      return dLatest < pipelineStartTs;
    }
    if (wfId === "B") return true; // B has no live data; if E is running → B is waiting
    return false;
  }, [eIsRunning, pipelineStartTs, wfId, live.jobs]);

  if (!workflow) return <Navigate to="/" replace />;

  const redirectUrl = config.impactAnalyser.redirectUrl;
  const redirectLabel = config.impactAnalyser.redirectLabel;

  const headerStatus = isStale ? "pending" : isLive ? live.status : workflow.status;
  const headerProgress = isStale ? 0 : isLive ? live.progress : workflow.progress;

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
            {isLive && !isStale && (
              <div className="mt-1 text-[10px] text-ink-subtle">
                {live.jobsDone}/{live.jobsTotal} succeeded
                {live.jobsRunning > 0 && ` · ${live.jobsRunning} running`}
                {live.jobsFailed > 0 && ` · ${live.jobsFailed} failed`}
              </div>
            )}
            {isStale && (
              <div className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                Waiting for upstream pipeline
              </div>
            )}
          </div>
        </div>
      </section>

      {isImpact && !isStale && <ImpactLivePanel />}

      {/* SBOM (B) — show its panel only when not waiting */}
      {isSBOM && !isStale && <SBOMPanel />}

      {isBuild && <TriggerPanel onBranchChange={setRpBranch} />}

      {isStale ? (
        <CrossWorkflowWaitingSection wfId={wfId} liveE={liveE} />
      ) : isLive ? (
        <LiveJobsSection
          liveSpecs={liveSpecs}
          live={live}
          rpBranch={rpBranch}
        />
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
/* Live Jobs Section — pipeline-aware rendering                        */
/* Shows WaitingJobCard for downstream jobs when upstream is running   */
/* ------------------------------------------------------------------ */

import type { ResolvedJobSpec } from "../workflowJobs";
import type { LiveWorkflowSummary } from "../hooks/useWorkflowLiveSummary";

function LiveJobsSection({
  liveSpecs,
  live,
  rpBranch,
}: {
  liveSpecs: ResolvedJobSpec[];
  live: LiveWorkflowSummary;
  rpBranch: string;
}) {
  // Is any job in the pipeline currently building?
  const anyBuilding = live.jobs.some(
    (j) => j.headline?.building === true,
  );

  // Build a lookup: jobId → live summary
  const jobById = Object.fromEntries(live.jobs.map((j) => [j.id, j]));

  // Build a lookup: jobId → spec (for dependsOn info)
  const specById = Object.fromEntries(liveSpecs.map((s) => [s.id, s]));

  // Determine if a downstream job should show "waiting" state:
  // - Pipeline is actively running (anyBuilding)
  // - This job's upstream dependency is still running or pending
  // - This job itself has NOT started in the current run (not building, no result)
  function isWaiting(spec: ResolvedJobSpec): boolean {
    if (!anyBuilding) return false;
    if (!spec.dependsOn) return false;

    const thisJob = jobById[spec.id];
    const upstream = jobById[spec.dependsOn];

    // If this job is already building or has a result, it's not waiting
    if (thisJob?.headline?.building) return false;

    // If upstream is still building, this job is waiting
    if (upstream?.headline?.building) return true;

    // If upstream finished successfully but this job hasn't started its
    // current run yet (its lastBuild timestamp is older than the upstream's),
    // it's waiting for Jenkins to pick it up
    if (upstream?.headline && thisJob?.headline) {
      const upstreamStart = upstream.headline.timestamp;
      const thisStart = thisJob.headline.timestamp;
      // If this job's last build started BEFORE the current upstream run, it's stale
      if (thisStart < upstreamStart && !thisJob.headline.building) return true;
    }

    // If upstream is building and this job has no data at all, it's waiting
    if (!thisJob?.headline && upstream?.headline?.building) return true;

    return false;
  }

  // Get the title of the upstream dependency
  function upstreamTitle(spec: ResolvedJobSpec): string {
    if (!spec.dependsOn) return "";
    return specById[spec.dependsOn]?.title ?? spec.dependsOn;
  }

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">
          Jenkins jobs
          {anyBuilding && (
            <span className="ml-2 inline-flex items-center gap-1 text-[11px] font-normal text-amber-600 dark:text-amber-400">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
              </span>
              Pipeline in progress
            </span>
          )}
        </h2>
        <span className="text-[11px] text-ink-subtle">
          Live data · auto-refresh every {Math.round(config.api.pollIntervalMs / 1000)}s
        </span>
      </div>
      <div className="space-y-3">
        {liveSpecs.map((j, idx) =>
          isWaiting(j) ? (
            <WaitingJobCard
              key={j.id}
              title={j.title}
              waitingFor={upstreamTitle(j)}
              description={j.waitDescription}
              step={idx + 1}
              totalSteps={liveSpecs.length}
            />
          ) : (
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
          ),
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Cross-Workflow Waiting — shown when upstream E is still running     */
/* ------------------------------------------------------------------ */

function CrossWorkflowWaitingSection({
  wfId,
  liveE,
}: {
  wfId: WorkflowId;
  liveE: LiveWorkflowSummary;
}) {
  // Find the currently building E job for display
  const buildingJob = liveE.jobs.find((j) => j.headline?.building);
  const buildingTitle = buildingJob
    ? liveE.jobs.find((j) => j.id === buildingJob.id)?.title ?? buildingJob.id
    : "Build & Unit Tests";

  const descriptions: Record<string, { wait: string; detail: string }> = {
    B: {
      wait: "Build & Unit Tests",
      detail:
        "The SBOM & CVE Scan step will start after the NIOS Build completes and produces the SBOM artifact. " +
        "It will upload the SBOM to Dependency-Track for CVE analysis.",
    },
    D: {
      wait: "Build & Unit Tests",
      detail:
        "Impact Analysis will be triggered after Build & Unit Tests and SBOM & CVE Scan complete. " +
        "It runs code-level impact analysis using the CVE list produced upstream.",
    },
  };

  const desc = descriptions[wfId] ?? { wait: "upstream pipeline", detail: "" };

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">
          Pipeline status
          <span className="ml-2 inline-flex items-center gap-1 text-[11px] font-normal text-amber-600 dark:text-amber-400">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
            </span>
            Waiting for upstream
          </span>
        </h2>
      </div>

      {/* Main waiting card */}
      <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50/50 p-5 dark:border-amber-700 dark:bg-amber-950/30">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/50">
            <svg className="h-5 w-5 text-amber-600 dark:text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-ink">
              Waiting for <span className="text-amber-600 dark:text-amber-400">{desc.wait}</span> to complete
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
              {desc.detail}
            </p>

            {/* Show what E is currently doing */}
            {buildingJob && (
              <div className="mt-3 flex items-center gap-2 rounded-md bg-surface-1 px-3 py-2 text-xs">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
                </span>
                <span className="text-ink-subtle">Currently running upstream:</span>
                <span className="font-medium text-ink">{buildingTitle}</span>
                {buildingJob.headline && (
                  <span className="text-ink-muted">
                    (#{buildingJob.headline.number})
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Empty progress bar at 0% */}
        <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-amber-200/50 dark:bg-amber-800/30" />
      </div>
    </section>
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
