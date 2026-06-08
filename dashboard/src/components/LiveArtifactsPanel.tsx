import { useEffect, useState } from "react";
import { awaitPrefetch } from "../api/prefetch";
import { useBackendWs } from "../hooks/useBackendWs";
import { toProxyUrl } from "../api/jenkinsClient";
import { workflowJobSpecs } from "../workflowJobs";

interface Row {
  jobId: string;
  jobTitle: string;
  buildNumber: number | null;
  fileName: string;
  relativePath: string;
  downloadUrl: string;
}

const MAX_ROWS = 100;

function kindLabel(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".cdx.json") || lower.endsWith(".bom.json")) return "SBOM";
  if (lower.endsWith(".json") && lower.includes("sbom")) return "SBOM";
  if (lower.includes("cve") && (lower.endsWith(".json") || lower.endsWith(".csv"))) return "CVE LIST";
  if (lower.endsWith(".html") || lower.endsWith(".pdf")) return "REPORT";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return "REPORT";
  if (lower.endsWith(".log") || lower.endsWith(".txt")) return "LOG";
  if (lower.endsWith(".zip") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "ARCHIVE";
  if (lower.endsWith(".json")) return "JSON";
  if (lower.endsWith(".xml")) return "XML";
  return "FILE";
}

export default function LiveArtifactsPanel({
  excludeJobIds = [],
}: {
  /** Job IDs whose artifacts should never appear (e.g. downstream jobs not
   *  triggered in the current pipeline run). */
  excludeJobIds?: string[];
} = {}) {
  const [rows, setRows] = useState<Row[]>([]);
  const ws = useBackendWs(["init", "jenkins:update"]);
  const excludeKey = excludeJobIds.slice().sort().join(",");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pre = await awaitPrefetch();
      if (cancelled) return;
      const jobs = pre?.jenkins?.jobs ?? {};
      // Empty / failed fetch: don't wipe the table — keep whatever we last
      // had so a transient refresh blip doesn't make artifacts vanish.
      if (!pre || Object.keys(jobs).length === 0) return;
      const excluded = new Set(excludeJobIds);
      const titleById: Record<string, string> = {};
      for (const wf of ["E", "B", "D"] as const) {
        for (const spec of workflowJobSpecs(wf)) titleById[spec.id] = spec.title;
      }

      // Anchor the current pipeline run.
      //
      // Primary anchor: orchestrator's latest build start time.
      // Backup anchor: earliest currently-running job (covers cases where the
      // orchestrator already finished but downstream jobs are still building).
      //
      // We use the EARLIER of the two so artifacts produced anywhere in the
      // current run window pass through, but stale artifacts from previous
      // runs (e.g. a d-impact #54 from a week ago) are correctly excluded.
      const orchestratorTs: number =
        jobs["e-orchestrator"]?.lastBuild?.timestamp ?? 0;
      const runningTimestamps: number[] = Object.values(jobs)
        .filter((j) => j?.lastBuild?.building === true)
        .map((j) => (j as any)?.lastBuild?.timestamp as number)
        .filter((t) => typeof t === "number" && t > 0);
      const candidates: number[] = [];
      if (orchestratorTs > 0) candidates.push(orchestratorTs);
      if (runningTimestamps.length) candidates.push(Math.min(...runningTimestamps));
      const pipelineStartTs: number = candidates.length
        ? Math.min(...candidates)
        : 0;

      const out: Row[] = [];
      const PER_JOB_CAP = 25;
      for (const [jobId, cached] of Object.entries(jobs)) {
        if (excluded.has(jobId)) continue;
        if (!cached?.artifacts?.length) continue;
        const buildNumber = cached.artifactsBuildNumber ?? null;
        const buildTs: number = cached.lastBuild?.timestamp ?? 0;

        // Orchestrator's own artifacts always belong to the current run.
        // Other jobs must have a build started during/after the run anchor.
        if (jobId !== "e-orchestrator" && pipelineStartTs > 0 && buildTs < pipelineStartTs) {
          continue;
        }

        // Per-job cap as a safety net — backend already trims to ~50, but
        // we re-cap here so a single rogue job can't dominate the table.
        for (const a of cached.artifacts.slice(0, PER_JOB_CAP)) {
          out.push({
            jobId,
            jobTitle: titleById[jobId] ?? jobId,
            buildNumber,
            fileName: a.fileName,
            relativePath: a.relativePath,
            downloadUrl: a.downloadUrl,
          });
        }
      }
      setRows(out);
    })();
    return () => { cancelled = true; };
  }, [ws?.ts, excludeKey]);

  return (
    <div className="rounded border border-line bg-surface-1">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="text-sm font-semibold">Artifacts</div>
        <div className="flex items-center gap-3">
          {rows.length > 0 && (
            <div className="text-[11px] text-ink-subtle">
              {rows.length} file{rows.length === 1 ? "" : "s"}
              {rows.length > MAX_ROWS ? ` · showing first ${MAX_ROWS}` : ""}
            </div>
          )}
          <JiraUploadButton disabled={rows.length === 0} />
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-ink-subtle">
          No artifacts produced yet in this run.
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {rows.slice(0, MAX_ROWS).map((r) => (
            <li key={`${r.jobId}-${r.relativePath}`} className="flex items-center gap-3 px-4 py-3">
              <span className="rounded bg-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                {kindLabel(r.fileName)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs">{r.fileName}</div>
                <div className="truncate text-[11px] text-ink-subtle">
                  {r.jobTitle}{r.buildNumber ? ` · #${r.buildNumber}` : ""}
                </div>
              </div>
              <a
                href={toProxyUrl(r.downloadUrl)}
                download={r.fileName}
                className="rounded border border-line px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink"
              >
                Download
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ─── Jira upload button ─────────────────────────────────────────────────── */

interface JiraUploadResponse {
  ok: boolean;
  issueKey?: string;
  jiraBaseUrl?: string;
  error?: string;
  note?: string;
  result?: {
    uploaded: { fileName: string; size: number; jobId: string }[];
    skipped: { fileName: string; reason: string; jobId: string }[];
    totalBytes: number;
    durationMs: number;
  };
}

function JiraUploadButton({ disabled }: { disabled: boolean }) {
  const [state, setState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [resp, setResp] = useState<JiraUploadResponse | null>(null);

  const click = async () => {
    if (state === "uploading") return;
    setState("uploading");
    setResp(null);
    try {
      const r = await fetch("/_api/jira/upload-current-run", { method: "POST" });
      const json: JiraUploadResponse = await r.json();
      setResp(json);
      setState(json.ok ? "done" : "error");
    } catch (err: any) {
      setResp({ ok: false, error: err?.message ?? String(err) });
      setState("error");
    }
  };

  const label = (() => {
    if (state === "uploading") return "Uploading…";
    if (state === "done") return "Upload to Jira";
    if (state === "error") return "Retry Jira upload";
    return "Upload to Jira";
  })();

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={click}
        disabled={disabled || state === "uploading"}
        className="rounded border border-line bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-ink hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
        title="Uploads current-run artifacts to the configured Jira issue (max 25 files, 50 MB)"
      >
        {label}
      </button>
      {resp && state === "done" && resp.result && (
        <div className="text-[10px] text-ink-subtle">
          {resp.note
            ? resp.note
            : <>
                Uploaded {resp.result.uploaded.length} · skipped {resp.result.skipped.length}
                {" · "}
                <a
                  className="underline hover:text-ink"
                  href={`${resp.jiraBaseUrl}/browse/${resp.issueKey}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {resp.issueKey} ↗
                </a>
              </>
          }
        </div>
      )}
      {resp && state === "error" && (
        <div className="max-w-xs truncate text-[10px] text-status-failed" title={resp.error}>
          {resp.error ?? "Upload failed"}
        </div>
      )}
    </div>
  );
}
