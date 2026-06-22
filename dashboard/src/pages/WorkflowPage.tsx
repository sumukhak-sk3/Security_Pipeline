import { useMemo, useState } from "react";
import { useParams, Navigate } from "react-router-dom";
import { currentRun } from "../mock/data";
import JobCard from "../components/JobCard";
import StatusPill from "../components/StatusPill";
import ProgressBar from "../components/ProgressBar";
import ConsoleDrawer from "../components/ConsoleDrawer";
import ImpactLivePanel from "../components/ImpactLivePanel";
import ImpactSummaryCard from "../components/ImpactSummaryCard";
import SBOMPanel from "../components/SBOMPanel";
import SBOMUploadStatusCard from "../components/SBOMUploadStatusCard";
import JenkinsJobCard from "../components/JenkinsJobCard";
import WaitingJobCard from "../components/WaitingJobCard";
import type { Job, WorkflowId } from "../types";
import { workflowShortName } from "../workflows";
import { config } from "../config";
import { workflowJobSpecs } from "../workflowJobs";
import { useWorkflowLiveSummary } from "../hooks/useWorkflowLiveSummary";
import { useSbomSummary } from "../hooks/useSbomSummary";
import { useS3Cve } from "../hooks/useS3Cve";
import { triggerWorkflowE } from "../api/triggerJenkins";
import { cn } from "../lib/cn";
import { relTime } from "../lib/format";
import type { Status } from "../types";
import { computeSbomPhase, sbomPhaseToStatus, type SbomPhase } from "../lib/sbomPhase";
import type { S3CvePayload } from "../hooks/useBackendWs";

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
  // B is live now too — it mirrors the CVE-BUILD job from E
  const isLive = isImpact || isBuild || isSBOM;

  // Hooks MUST be unconditional — compute spec list before any early return.
  const liveSpecs = useMemo(
    () => (isLive && (wfId === "E" || wfId === "D") ? workflowJobSpecs(wfId) : []),
    [isLive, wfId],
  );
  const live = useWorkflowLiveSummary(liveSpecs);

  // Cross-workflow awareness: always poll E so D and B know when upstream is
  // running. For B (SBOM) we also need D so we can detect when Impact
  // Analyser has been triggered for this run (= "stored to S3" signal).
  const eSpecs = useMemo(() => workflowJobSpecs("E"), []);
  const liveE = useWorkflowLiveSummary(eSpecs);
  const dSpecs = useMemo(() => workflowJobSpecs("D"), []);
  const liveD = useWorkflowLiveSummary(dSpecs);

  // SBOM upload state (B's live data source = CVE-BUILD console parse)
  const sbom = useSbomSummary();
  const s3Cve = useS3Cve();
  const eNiosBuild = liveE.jobs.find((j) => j.id === "e-nios-build");
  const dImpactJob = liveD.jobs.find((j) => j.id === "d-impact");

  // Is Workflow E currently running? (orchestrator or any E job building)
  const eIsRunning = liveE.jobs.some((j) => j.headline?.building === true);
  const pipelineStartTs =
    liveE.jobs.find((j) => j.id === "e-orchestrator")?.headline?.timestamp ?? 0;

  // ────────────────────────────────────────────────────────────────
  // SBOM (Workflow B) phase machine — shared with the Overview card via
  // lib/sbomPhase so both views always agree.
  // ────────────────────────────────────────────────────────────────
  const sbomPhase: SbomPhase = useMemo(
    () => computeSbomPhase(
      eNiosBuild?.headline ?? null,
      sbom.summary ?? null,
      dImpactJob?.headline ?? null,
      s3Cve.data ?? null,
      pipelineStartTs,
    ),
    [eNiosBuild, sbom.summary, dImpactJob, s3Cve.data, pipelineStartTs],
  );

  const liveBStatus = useMemo<{ status: Status; progress: number }>(
    () => sbomPhaseToStatus(sbomPhase, eNiosBuild?.headline?.building === true),
    [sbomPhase, eNiosBuild],
  );

  // Is this downstream workflow stale (not yet triggered in current pipeline run)?
  const isStale = useMemo(() => {
    if (pipelineStartTs === 0) return false;
    if (wfId === "E") return false; // E is the upstream, never "stale"
    if (wfId === "D") {
      // Impact Analyser depends on NIOS Build AND the S3 CVE upload (when
      // S3 polling is configured). Quick/Slow UT do NOT block this step.
      if (live.jobs.some((j) => j.headline?.building)) return false;
      const dLatest = Math.max(...live.jobs.map((j) => j.headline?.timestamp ?? 0));
      if (dLatest >= pipelineStartTs) return false; // D already ran in this run
      const niosNotStarted = !eNiosBuild?.headline
        || eNiosBuild.headline.timestamp < pipelineStartTs;
      const niosStillBuilding = eNiosBuild?.headline?.building === true;
      if (niosNotStarted || niosStillBuilding) return true;
      // NIOS Build done for this run — gate on S3 if configured.
      if (s3Cve.data?.configured) {
        return (s3Cve.data.lastModifiedMs ?? 0) < pipelineStartTs;
      }
      return false;
    }
    if (wfId === "B") {
      // B is stale only if the orchestrator is running AND CVE-BUILD hasn't started yet
      if (!eIsRunning) return false;
      const niosTs = eNiosBuild?.headline?.timestamp ?? 0;
      if (eNiosBuild?.headline?.building) return false;
      return niosTs < pipelineStartTs;
    }
    return false;
  }, [eIsRunning, pipelineStartTs, wfId, live.jobs, eNiosBuild, s3Cve.data]);

  if (!workflow) return <Navigate to="/" replace />;

  const redirectUrl = config.impactAnalyser.redirectUrl;
  const redirectLabel = config.impactAnalyser.redirectLabel;

  // Header status: B uses derived liveBStatus; E/D use live summary; otherwise mock
  let headerStatus: Status;
  let headerProgress: number;
  if (isStale) {
    headerStatus = "pending"; headerProgress = 0;
  } else if (isSBOM) {
    headerStatus = liveBStatus.status; headerProgress = liveBStatus.progress;
  } else if (isLive) {
    headerStatus = live.status; headerProgress = live.progress;
  } else {
    headerStatus = workflow.status; headerProgress = workflow.progress;
  }

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
            {isLive && !isStale && !isSBOM && (
              <div className="mt-1 text-[10px] text-ink-subtle">
                {live.jobsDone}/{live.jobsTotal} succeeded
                {live.jobsRunning > 0 && ` · ${live.jobsRunning} running`}
                {live.jobsFailed > 0 && ` · ${live.jobsFailed} failed`}
              </div>
            )}
            {isSBOM && !isStale && eNiosBuild?.headline && (
              <div className="mt-1 text-[10px] text-ink-subtle">
                CVE-BUILD #{eNiosBuild.headline.number}
                {sbomPhase === "uploaded" && (
                  <> · <span className="text-status-success">BOM uploaded</span></>
                )}
                {sbomPhase === "s3" && (
                  <> · <span className="text-status-success">Stored to S3</span></>
                )}
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

      {isBuild && <TriggerPanel onBranchChange={setRpBranch} />}

      {isStale ? (
        <CrossWorkflowWaitingSection wfId={wfId} liveE={liveE} />
      ) : isSBOM ? (
        <SBOMWorkflowSection
          cveBuildUrl={eSpecs.find((s) => s.id === "e-nios-build")?.jenkinsUrl ?? ""}
          phase={sbomPhase}
          currentBuildNumber={eNiosBuild?.headline?.number ?? null}
          currentBuildIsBuilding={eNiosBuild?.headline?.building === true}
          dImpactBuildNumber={
            sbomPhase === "s3" ? dImpactJob?.headline?.number ?? null : null
          }
          s3={s3Cve.data ?? null}
          pipelineStartTs={pipelineStartTs}
        />
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
/* SBOM Workflow Section — Workflow B body                             */
/* Phase-aware: waiting → uploaded → s3 (or failed).                   */
/* Stale previous-build data is suppressed by passing currentBuildNumber */
/* down to SBOMUploadStatusCard.                                       */
/* ------------------------------------------------------------------ */

function SBOMWorkflowSection({
  cveBuildUrl,
  phase,
  currentBuildNumber,
  currentBuildIsBuilding,
  dImpactBuildNumber,
  s3,
  pipelineStartTs,
}: {
  readonly cveBuildUrl: string;
  readonly phase: SbomPhase;
  readonly currentBuildNumber: number | null;
  readonly currentBuildIsBuilding: boolean;
  readonly dImpactBuildNumber: number | null;
  readonly s3: S3CvePayload | null;
  readonly pipelineStartTs: number;
}) {
  return (
    <div className="space-y-6">
      <SBOMPhaseBanner
        phase={phase}
        currentBuildNumber={currentBuildNumber}
        currentBuildIsBuilding={currentBuildIsBuilding}
        dImpactBuildNumber={dImpactBuildNumber}
      />
      {(phase === "uploaded" || phase === "s3") && (
        <SBOMUploadStatusCard expectedBuildNumber={currentBuildNumber} />
      )}
      <S3UploadStatusCard s3={s3} pipelineStartTs={pipelineStartTs} phase={phase} />
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">CVE-BUILD job</h2>
        {cveBuildUrl ? (
          <JenkinsJobCard
            title="CVE-BUILD (SBOM Upload)"
            jenkinsUrl={cveBuildUrl}
          />
        ) : (
          <div className="rounded border border-line bg-surface-1 p-4 text-xs text-ink-subtle">
            CVE-BUILD URL not configured. Set <code>VITE_JENKINS_JOB_E_NIOS_BUILD</code> in your environment.
          </div>
        )}
      </section>
      {phase === "s3" && <SBOMPanel />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* S3 Upload Status Card — surfaces backend S3 poller state            */
/* Shows bucket + prefix, latest object key, last-modified timestamp,  */
/* and whether the latest upload belongs to the current pipeline run.  */
/* ------------------------------------------------------------------ */

function S3UploadStatusCard({
  s3,
  pipelineStartTs,
  phase,
}: {
  readonly s3: S3CvePayload | null;
  readonly pipelineStartTs: number;
  readonly phase: SbomPhase;
}) {
  if (!s3) {
    return (
      <section className="rounded-xl border border-line bg-surface-1 p-4">
        <div className="text-sm font-semibold">CVE delta → S3</div>
        <p className="mt-1 text-xs text-ink-subtle">
          Waiting for the first S3 poll. The backend lists the configured bucket
          every few seconds to detect new CVE delta uploads.
        </p>
      </section>
    );
  }

  if (!s3.configured) {
    return (
      <section className="rounded-xl border border-dashed border-line bg-surface-1 p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold">CVE delta → S3</div>
            <p className="mt-1 text-xs text-ink-subtle">
              S3 polling is not configured. Fill in <code>AWS_ACCESS_KEY_ID</code>,
              {" "}<code>AWS_SECRET_ACCESS_KEY</code>, <code>S3_CVE_BUCKET</code>,
              and <code>S3_CVE_PREFIX</code> in <code>.env.local</code> and restart
              the dev server. Until then, Impact Analyser gating falls back to
              detecting the downstream Jenkins job firing.
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
            Not configured
          </span>
        </div>
      </section>
    );
  }

  const latestMs = s3.lastModifiedMs || 0;
  const matchesRun =
    pipelineStartTs > 0 && latestMs > 0 && latestMs >= pipelineStartTs;
  const hasNewerThanRun = matchesRun;

  let badgeLabel: string;
  let badgeClass: string;
  let bodyDetail: string;

  if (s3.error) {
    badgeLabel = "Error";
    badgeClass = "bg-status-failed/10 text-status-failed";
    bodyDetail = s3.error;
  } else if (latestMs === 0) {
    badgeLabel = "Empty";
    badgeClass = "bg-surface-2 text-ink-subtle";
    bodyDetail = "No CSV or JSON objects found under the configured prefix yet.";
  } else if (hasNewerThanRun) {
    badgeLabel = "Stored for this run";
    badgeClass = "bg-status-success/10 text-status-success";
    bodyDetail =
      "A new CVE delta has been uploaded since the current pipeline started. Impact Analyser is unblocked.";
  } else if (pipelineStartTs > 0) {
    badgeLabel = phase === "uploaded" ? "Waiting for new upload" : "Stale";
    badgeClass = "bg-amber-500/10 text-amber-600 dark:text-amber-400";
    bodyDetail =
      "The newest S3 object is older than the current pipeline start. Impact Analyser will unblock once a new CVE delta appears.";
  } else {
    badgeLabel = "Latest";
    badgeClass = "bg-surface-2 text-ink-muted";
    bodyDetail = "Last known CVE delta upload.";
  }

  const lastModifiedIso = latestMs ? new Date(latestMs).toISOString() : "";

  return (
    <section className="rounded-xl border border-line bg-surface-1 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold">CVE delta → S3</div>
            <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", badgeClass)}>
              {badgeLabel}
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-muted">{bodyDetail}</p>
        </div>
        <div className="shrink-0 text-right text-[11px] text-ink-subtle">
          {s3.totalCount} object{s3.totalCount === 1 ? "" : "s"} in prefix
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">Bucket</div>
          <div className="mt-1 truncate font-mono text-xs text-ink" title={s3.bucket}>
            {s3.bucket || "—"}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">Prefix</div>
          <div className="mt-1 truncate font-mono text-xs text-ink" title={s3.prefix}>
            {s3.prefix || "(root)"}
          </div>
        </div>
        <div className="sm:col-span-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">Latest object</div>
          <div className="mt-1 truncate font-mono text-xs text-ink" title={s3.key ?? ""}>
            {s3.key ?? "—"}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">Last modified</div>
          <div className="mt-1 text-xs text-ink">
            {lastModifiedIso ? <>{relTime(lastModifiedIso)}</> : "—"}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">Poller last ran</div>
          <div className="mt-1 text-xs text-ink">
            {s3.fetchedAt ? relTime(new Date(s3.fetchedAt).toISOString()) : "—"}
          </div>
        </div>
      </div>
    </section>
  );
}

function SBOMPhaseBanner({
  phase,
  currentBuildNumber,
  currentBuildIsBuilding,
  dImpactBuildNumber,
}: {
  readonly phase: SbomPhase;
  readonly currentBuildNumber: number | null;
  readonly currentBuildIsBuilding: boolean;
  readonly dImpactBuildNumber: number | null;
}) {
  const buildRef = currentBuildNumber ? `#${currentBuildNumber}` : "";
  if (phase === "noBuild") {
    return (
      <section className="rounded-xl border border-dashed border-line bg-surface-1 p-4 text-xs text-ink-subtle">
        No CVE-BUILD has run yet. Trigger the pipeline from the Build &amp; Unit Tests page.
      </section>
    );
  }
  if (phase === "failed") {
    return (
      <section className="rounded-xl border border-status-failed/30 bg-status-failed/5 p-4">
        <div className="text-sm font-semibold text-status-failed">CVE-BUILD {buildRef} failed</div>
        <p className="mt-1 text-xs text-ink-muted">
          The build did not reach the SBOM upload step. Check the CVE-BUILD console below.
        </p>
      </section>
    );
  }
  if (phase === "waiting") {
    return (
      <section className="rounded-xl border border-amber-300/40 bg-amber-50/40 p-4 dark:border-amber-400/30 dark:bg-amber-500/10">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
          </span>
          <div className="text-sm font-semibold text-amber-700 dark:text-amber-300">
            Waiting for NIOS Build {buildRef} to complete
          </div>
        </div>
        <p className="mt-1 text-xs text-ink-muted">
          SBOM extraction starts once the CVE-BUILD console prints <code>BOM uploaded successfully</code>.
          {currentBuildIsBuilding ? " Build is still running." : " Build completed; waiting for the upload step to be detected."}
        </p>
      </section>
    );
  }
  if (phase === "uploaded") {
    return (
      <section className="rounded-xl border border-status-running/40 bg-status-running/5 p-4">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-status-running animate-pulse" />
          <div className="text-sm font-semibold text-status-running">
            BOM uploaded for {buildRef} — preparing CVE list
          </div>
        </div>
        <p className="mt-1 text-xs text-ink-muted">
          Waiting for the CVE list to be handed off to S3 and the Impact Analyser pipeline to be triggered.
        </p>
      </section>
    );
  }
  // phase === "s3"
  return (
    <section className="rounded-xl border border-status-success/40 bg-status-success/5 p-4">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-status-success" />
        <div className="text-sm font-semibold text-status-success">
          Stored to S3 — Impact Analyser triggered
        </div>
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        CVE list from CVE-BUILD {buildRef} has been uploaded and the Impact Analyser pipeline
        {dImpactBuildNumber ? <> picked it up as run #{dImpactBuildNumber}.</> : " has started."}
      </p>
    </section>
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
              historyOverride={j.id === "d-impact" ? <ImpactSummaryCard /> : undefined}
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
  // For B and D, the only blocking upstream is the orchestrator + NIOS Build.
  // Quick UT / Slow UT run in parallel and do NOT block these downstream
  // workflows, so we exclude them from the "currently running upstream" hint.
  const blockingUpstreamIds = wfId === "B" || wfId === "D"
    ? new Set(["e-orchestrator", "e-nios-build"])
    : null;
  const buildingJob = liveE.jobs.find((j) =>
    j.headline?.building && (!blockingUpstreamIds || blockingUpstreamIds.has(j.id)),
  );
  const buildingTitle = buildingJob
    ? liveE.jobs.find((j) => j.id === buildingJob.id)?.title ?? buildingJob.id
    : "NIOS Build";

  const descriptions: Record<string, { wait: string; detail: string }> = {
    B: {
      wait: "NIOS Build",
      detail:
        "The SBOM & CVE Scan step will start after NIOS Build completes and uploads the BOM to Dependency-Track. " +
        "Quick UT / Slow UT are independent and do not block this step.",
    },
    D: {
      wait: "SBOM/CVE upload to S3",
      detail:
        "Impact Analyser will be triggered as soon as the CVE delta CSV from this pipeline run lands in the configured S3 bucket. " +
        "Quick UT and Slow UT run in parallel and do NOT block Impact Analysis.",
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

  const placeholder = `NIOSRFE-8575-${new Date().toISOString().slice(0, 10)}`;
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
