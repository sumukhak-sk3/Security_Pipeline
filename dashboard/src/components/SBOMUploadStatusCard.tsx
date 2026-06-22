/**
 * SBOM upload status card — shows the BOM upload metadata parsed from the
 * CVE-BUILD console output (project, components, groups, DTrack target,
 * upload token). Rendered on Workflow B above the existing DTrack panel.
 *
 * Data flows: vite-backend-plugin (server-side console tail + parse) →
 *             /_api/sbom + WS push → useSbomSummary → this card.
 *
 * REVERSIBLE: Delete this file and remove its import from WorkflowPage.
 */

import { useSbomSummary } from "../hooks/useSbomSummary";

interface Props {
  /**
   * If set, the card only renders summary data when its `buildNumber`
   * matches. Used by Workflow B to prevent showing a previous run's
   * SBOM data while the new CVE-BUILD is still in flight.
   */
  readonly expectedBuildNumber?: number | null;
}

export default function SBOMUploadStatusCard({ expectedBuildNumber }: Props = {}) {
  const { loading, summary, error } = useSbomSummary();

  if (loading) {
    return (
      <section className="rounded-xl border border-line bg-surface-1 p-4">
        <h2 className="text-sm font-semibold">SBOM upload status</h2>
        <p className="mt-2 text-xs text-ink-subtle">Loading from latest CVE-BUILD…</p>
      </section>
    );
  }

  const stale =
    expectedBuildNumber != null &&
    summary != null &&
    summary.buildNumber !== expectedBuildNumber;

  if (!summary || stale) {
    return (
      <section className="rounded-xl border border-line bg-surface-1 p-4">
        <h2 className="text-sm font-semibold">SBOM upload status</h2>
        <p className="mt-2 text-xs text-ink-subtle">
          {error
            ? `Error: ${error}`
            : stale
              ? `Waiting for SBOM data from CVE-BUILD #${expectedBuildNumber}…`
              : "No completed CVE-BUILD found yet — waiting for first SUCCESS build."}
        </p>
      </section>
    );
  }

  const uploaded = summary.bomUploaded;
  const badgeClass = uploaded
    ? "bg-status-success/15 text-status-success"
    : "bg-status-failed/15 text-status-failed";
  const badgeLabel = uploaded ? "BOM Uploaded" : "BOM Missing";

  return (
    <section className="rounded-xl border border-line bg-surface-1 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold">SBOM upload status</h2>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${badgeClass}`}>
            {badgeLabel}
          </span>
          <span className="text-[11px] text-ink-subtle">
            CVE-BUILD #{summary.buildNumber}
          </span>
        </div>
        <a
          href={summary.buildUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md border border-line bg-surface-0 px-2.5 py-1 text-xs text-ink-muted hover:text-ink"
        >
          View build
        </a>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Project" value={summary.project ?? "—"} />
        <Metric label="Components" value={summary.components != null ? summary.components.toLocaleString() : "—"} />
        <Metric label="Build label" value={summary.buildLabel ?? "—"} />
        <Metric
          label="Dependency-Track"
          value={
            summary.dtrackUrl ? (
              <a
                href={summary.dtrackUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                <code className="text-[11px] break-all">{summary.dtrackUrl}</code>
              </a>
            ) : (
              "—"
            )
          }
        />
      </div>

      {summary.groups.length > 0 && (
        <div className="mt-3 rounded-lg border border-line bg-surface-0 px-3 py-2.5">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
            Component groups ({summary.groups.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {summary.groups.map((g) => (
              <span
                key={g}
                className="rounded-full border border-line bg-surface-1 px-2 py-0.5 text-[10px] text-ink"
              >
                {g}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

interface MetricProps {
  readonly label: string;
  readonly value: React.ReactNode;
}

function Metric({ label, value }: MetricProps) {
  return (
    <div className="rounded-lg border border-line bg-surface-0 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
        {label}
      </div>
      <div className="mt-1 text-sm text-ink break-words">{value}</div>
    </div>
  );
}
