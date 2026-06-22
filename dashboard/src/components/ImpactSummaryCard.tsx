/**
 * Impact Analyser summary card — shows aggregate stats for the latest CVE
 * scan run (total, decided/pending counts, severity breakdown, verdict
 * breakdown). Drops into Workflow D's d-impact JenkinsJobCard via the
 * `historyOverride` prop, replacing the recent-builds list.
 *
 * Data: useImpactStatus().cveSummary (populated server-side by pollImpact).
 *
 * REVERSIBLE: Delete this file and remove its use from WorkflowPage.
 */

import { useImpactStatus } from "../hooks/useImpactStatus";

const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;

function severityClass(sev: string): string {
  switch (sev) {
    case "CRITICAL": return "text-red-600 dark:text-red-400";
    case "HIGH":     return "text-orange-600 dark:text-orange-400";
    case "MEDIUM":   return "text-yellow-600 dark:text-yellow-400";
    case "LOW":      return "text-sky-600 dark:text-sky-400";
    default:         return "text-ink-subtle";
  }
}

function verdictClass(v: string): string {
  if (v.includes("NOT_VULNERABLE") || v === "SAFE" || v === "RESOLVED") {
    return "bg-status-success/15 text-status-success";
  }
  if (v.includes("VULNERABLE") || v === "AFFECTED" || v === "EXPLOITABLE") {
    return "bg-status-failed/15 text-status-failed";
  }
  return "bg-surface-2 text-ink-muted";
}

export default function ImpactSummaryCard() {
  const { loading, latestRun, cveSummary } = useImpactStatus();

  if (loading && !cveSummary) {
    return (
      <div className="mt-3 rounded-lg border border-line bg-surface-0 p-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
          Run Summary
        </div>
        <p className="mt-2 text-xs text-ink-subtle">Loading…</p>
      </div>
    );
  }

  if (!cveSummary) {
    return (
      <div className="mt-3 rounded-lg border border-line bg-surface-0 p-3">
        <div className="flex items-center justify-between">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
            Run Summary
          </div>
          {latestRun && (
            <span className="text-[10px] text-ink-subtle">
              run {String(latestRun.run_id ?? latestRun.id ?? "—")}
            </span>
          )}
        </div>
        <p className="mt-2 text-xs text-ink-subtle">
          No CVE data available for the latest run yet.
        </p>
      </div>
    );
  }

  const { total, withDecision, withoutDecision, bySeverity, byVerdict, runId } = cveSummary;
  const decidedPct = total > 0 ? Math.round((withDecision / total) * 100) : 0;

  return (
    <div className="mt-3 rounded-lg border border-line bg-surface-0 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
          Run Summary
        </div>
        <span className="text-[10px] text-ink-subtle">run {runId}</span>
      </div>

      {/* Headline counters */}
      <div className="mt-2 grid grid-cols-3 gap-3 text-center">
        <div className="rounded-md border border-line bg-surface-1 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-ink-subtle">Total CVEs</div>
          <div className="mt-0.5 text-lg font-semibold text-ink">{total}</div>
        </div>
        <div className="rounded-md border border-line bg-surface-1 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-ink-subtle">Decided</div>
          <div className="mt-0.5 text-lg font-semibold text-status-success">{withDecision}</div>
          <div className="text-[10px] text-ink-subtle">{decidedPct}%</div>
        </div>
        <div className="rounded-md border border-line bg-surface-1 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-ink-subtle">Pending</div>
          <div className="mt-0.5 text-lg font-semibold text-ink-muted">{withoutDecision}</div>
        </div>
      </div>

      {/* Severity breakdown */}
      {Object.keys(bySeverity).length > 0 && (
        <div className="mt-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
            By severity
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            {SEVERITY_ORDER
              .filter((s) => bySeverity[s])
              .concat(
                Object.keys(bySeverity)
                  .filter((s) => !(SEVERITY_ORDER as readonly string[]).includes(s)) as Array<typeof SEVERITY_ORDER[number]>,
              )
              .map((sev) => (
                <div key={sev} className="flex items-center gap-1">
                  <span className={`font-semibold ${severityClass(sev)}`}>{sev}</span>
                  <span className="text-ink">{bySeverity[sev]}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Verdict breakdown */}
      {Object.keys(byVerdict).length > 0 && (
        <div className="mt-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
            By verdict
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {Object.entries(byVerdict).map(([v, n]) => (
              <span
                key={v}
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${verdictClass(v)}`}
              >
                {v} · {n}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
