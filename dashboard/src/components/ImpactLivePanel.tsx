import { useImpactStatus } from "../hooks/useImpactStatus";
import { useEffect, useState } from "react";
import { config } from "../config";
import { awaitPrefetch } from "../api/prefetch";
import type { IndexInfo, RunInfo } from "../api/impactClient";

function indexesText(indexes: IndexInfo[] | null, err?: string): string {
  if (indexes != null) return String(indexes.length);
  return err ? "n/a" : "…";
}

function latestRunText(run: RunInfo | null, err?: string): string {
  if (run) {
    const id = run.run_id ?? run.id ?? "—";
    const status = run.status ?? "?";
    return `${id} · ${status}`;
  }
  return err ? "n/a" : "…";
}

/**
 * Live status panel for the Impact Analyser backend.
 * Only rendered on the Workflow D page. Fails gracefully per endpoint.
 */
export default function ImpactLivePanel() {
  const { loading, healthy, health, indexes, latestRun, errors, refresh } =
    useImpactStatus();
  const [pipelineParams, setPipelineParams] = useState<Record<string, string>>({});

  // Load d-impact build params from prefetch for CVE context
  useEffect(() => {
    awaitPrefetch().then((pre) => {
      const params = pre?.jenkins?.jobs?.["d-impact"]?.buildParams;
      if (params) setPipelineParams(params);
    });
  }, []);

  const apiUrl = config.impactAnalyser.apiUrl;
  const uiUrl = config.impactAnalyser.uiUrl;

  let healthLabel: string;
  if (healthy === null) {
    healthLabel = "Unknown";
  } else if (healthy) {
    healthLabel = (typeof health?.status === "string" && health.status) || "Healthy";
  } else {
    healthLabel = "Unreachable";
  }

  let healthClass: string;
  if (healthy === true) {
    healthClass = "bg-status-success/15 text-status-success";
  } else if (healthy === false) {
    healthClass = "bg-status-failed/15 text-status-failed";
  } else {
    healthClass = "bg-surface-2 text-ink-muted";
  }

  return (
    <section className="rounded-xl border border-line bg-surface-1 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold">Live API status</h2>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${healthClass}`}
          >
            {loading ? "Checking…" : healthLabel}
          </span>
        </div>
        <button
          onClick={refresh}
          className="rounded-md border border-line bg-surface-0 px-2.5 py-1 text-xs text-ink-muted hover:text-ink"
        >
          Refresh
        </button>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Frontend"
          value={
            uiUrl ? (
              <a
                href={uiUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                <code className="text-[11px]">{uiUrl}</code>
              </a>
            ) : (
              "—"
            )
          }
        />
        <Metric
          label="API endpoint"
          value={<code className="text-[11px]">{apiUrl || "—"}</code>}
        />
        <Metric
          label="Indexes"
          value={indexesText(indexes, errors.indexes)}
          hint={errors.indexes}
        />
        <Metric
          label="Latest run"
          value={latestRunText(latestRun, errors.latestRun)}
          hint={errors.latestRun}
        />
      </div>

      {errors.health && (
        <div className="mt-3 rounded-md border border-status-failed/40 bg-status-failed/10 px-3 py-2 text-xs text-status-failed">
          Health check failed: {errors.health}
        </div>
      )}

      {/* Pipeline analysis summary from Jenkins build params */}
      {Object.keys(pipelineParams).length > 0 && (
        <div className="mt-3 rounded-lg border border-line bg-surface-0 px-3 py-2.5">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
            Last Analysis Configuration
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-3 lg:grid-cols-5">
            {pipelineParams.SEVERITIES && (
              <div>
                <div className="text-[10px] text-ink-subtle">Severities</div>
                <div className="font-medium text-red-600 dark:text-red-400">{pipelineParams.SEVERITIES}</div>
              </div>
            )}
            {pipelineParams.ANALYSIS_MODE && (
              <div>
                <div className="text-[10px] text-ink-subtle">Mode</div>
                <div className="font-medium text-ink">{pipelineParams.ANALYSIS_MODE}</div>
              </div>
            )}
            {pipelineParams.WORKERS && (
              <div>
                <div className="text-[10px] text-ink-subtle">Workers</div>
                <div className="font-medium text-ink">{pipelineParams.WORKERS}</div>
              </div>
            )}
            {pipelineParams.LIMIT && (
              <div>
                <div className="text-[10px] text-ink-subtle">CVE Limit</div>
                <div className="font-medium text-ink">{pipelineParams.LIMIT === "0" ? "All (no limit)" : pipelineParams.LIMIT}</div>
              </div>
            )}
            {pipelineParams.REPOSITORY_URL && (
              <div className="col-span-2 sm:col-span-1">
                <div className="text-[10px] text-ink-subtle">Repository</div>
                <div className="font-medium text-ink truncate" title={pipelineParams.REPOSITORY_URL}>
                  {pipelineParams.REPOSITORY_URL.split("/").pop()?.replace(".git", "") || pipelineParams.REPOSITORY_URL}
                </div>
              </div>
            )}
          </div>
          {/* Indexes count when available */}
          {indexes && indexes.length > 0 && (
            <div className="mt-2 flex items-center gap-2 border-t border-line pt-2 text-[11px]">
              <span className="text-ink-subtle">Code indexes:</span>
              <span className="font-semibold text-ink">{indexes.length}</span>
              {latestRun?.status && (
                <>
                  <span className="text-ink-subtle">·</span>
                  <span className="text-ink-subtle">Last run:</span>
                  <span className={`font-semibold ${latestRun.status === "completed" ? "text-green-600 dark:text-green-400" : latestRun.status === "failed" ? "text-red-600 dark:text-red-400" : "text-ink"}`}>
                    {latestRun.status}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

interface MetricProps {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly hint?: string;
}

function Metric({ label, value, hint }: MetricProps) {
  return (
    <div className="rounded-lg border border-line bg-surface-0 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
        {label}
      </div>
      <div className="mt-1 text-sm text-ink">{value}</div>
      {hint && (
        <div
          className="mt-1 truncate text-[10px] text-ink-subtle"
          title={hint}
        >
          {hint}
        </div>
      )}
    </div>
  );
}
