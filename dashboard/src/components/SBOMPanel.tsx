import { useEffect, useState } from "react";
import {
  fetchProjects,
  fetchProjectMetrics,
  type DTrackProject,
  type DTrackMetrics,
} from "../api/dtrackClient";
import { cn } from "../lib/cn";

interface ProjectWithMetrics extends DTrackProject {
  metrics: DTrackMetrics;
}

export default function SBOMPanel() {
  const [projects, setProjects] = useState<ProjectWithMetrics[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const projs = await fetchProjects();
        if (cancelled) return;

        // Fetch metrics for each project (parallel, capped at 10)
        const withMetrics: ProjectWithMetrics[] = [];
        const batch = projs.slice(0, 20); // limit to first 20
        const results = await Promise.allSettled(
          batch.map(async (p) => {
            const metrics = await fetchProjectMetrics(p.uuid);
            return { ...p, metrics };
          }),
        );
        for (const r of results) {
          if (r.status === "fulfilled") withMetrics.push(r.value);
        }
        if (!cancelled) {
          setProjects(withMetrics);
          setError(null);
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? "Failed to load Dependency-Track data");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="rounded border border-line bg-surface-1 px-4 py-6">
        <div className="text-sm font-medium">SBOM & Vulnerability Data</div>
        <div className="mt-3 h-2 w-full animate-pulse rounded bg-surface-2" />
        <div className="mt-2 text-[11px] text-ink-subtle">Loading from Dependency-Track…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded border border-status-failed/40 bg-status-failed/5 px-4 py-4">
        <div className="text-sm font-medium">SBOM & Vulnerability Data</div>
        <div className="mt-2 text-[11px] text-status-failed">{error}</div>
        <div className="mt-1 text-[10px] text-ink-subtle">
          Ensure Dependency-Track is reachable and <code>DTRACK_API_KEY</code> is set in .env.local
        </div>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="rounded border border-line bg-surface-1 px-4 py-4">
        <div className="text-sm font-medium">SBOM & Vulnerability Data</div>
        <div className="mt-2 text-[11px] text-ink-subtle">No projects found in Dependency-Track.</div>
      </div>
    );
  }

  // Aggregate totals
  const totals = projects.reduce(
    (acc, p) => ({
      critical: acc.critical + p.metrics.critical,
      high: acc.high + p.metrics.high,
      medium: acc.medium + p.metrics.medium,
      low: acc.low + p.metrics.low,
      components: acc.components + p.metrics.components,
      vulnerabilities: acc.vulnerabilities + p.metrics.vulnerabilities,
    }),
    { critical: 0, high: 0, medium: 0, low: 0, components: 0, vulnerabilities: 0 },
  );

  return (
    <div className="space-y-4">
      {/* Summary row */}
      <div className="rounded border border-line bg-surface-1 px-4 py-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">SBOM & Vulnerability Summary</div>
          <a
            href="http://54.215.67.129:8081/projects"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-line px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            Open Dependency-Track ↗
          </a>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <MetricBox label="Critical" value={totals.critical} color="text-red-500" />
          <MetricBox label="High" value={totals.high} color="text-orange-500" />
          <MetricBox label="Medium" value={totals.medium} color="text-yellow-500" />
          <MetricBox label="Low" value={totals.low} color="text-blue-400" />
          <MetricBox label="Components" value={totals.components} color="text-ink" />
          <MetricBox label="Total Vulns" value={totals.vulnerabilities} color="text-ink" />
        </div>
      </div>

      {/* Projects table */}
      <div className="rounded border border-line bg-surface-1 overflow-hidden">
        <div className="border-b border-line px-4 py-2">
          <div className="text-xs font-semibold">Projects ({projects.length})</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-line bg-surface-2/50 text-left text-ink-subtle">
                <th className="px-4 py-2 font-medium">Project</th>
                <th className="px-4 py-2 font-medium">Version</th>
                <th className="px-4 py-2 font-medium text-center">Critical</th>
                <th className="px-4 py-2 font-medium text-center">High</th>
                <th className="px-4 py-2 font-medium text-center">Medium</th>
                <th className="px-4 py-2 font-medium text-center">Low</th>
                <th className="px-4 py-2 font-medium text-center">Components</th>
                <th className="px-4 py-2 font-medium">Last Import</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.uuid} className="border-b border-line/50 hover:bg-surface-2/30">
                  <td className="px-4 py-2 font-medium text-ink">
                    <a
                      href={`http://54.215.67.129:8081/projects/${p.uuid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-accent hover:underline"
                    >
                      {p.name}
                    </a>
                  </td>
                  <td className="px-4 py-2 text-ink-muted">{p.version || "—"}</td>
                  <td className={cn("px-4 py-2 text-center font-medium", p.metrics.critical > 0 && "text-red-500")}>
                    {p.metrics.critical}
                  </td>
                  <td className={cn("px-4 py-2 text-center font-medium", p.metrics.high > 0 && "text-orange-500")}>
                    {p.metrics.high}
                  </td>
                  <td className={cn("px-4 py-2 text-center font-medium", p.metrics.medium > 0 && "text-yellow-500")}>
                    {p.metrics.medium}
                  </td>
                  <td className="px-4 py-2 text-center">{p.metrics.low}</td>
                  <td className="px-4 py-2 text-center">{p.metrics.components}</td>
                  <td className="px-4 py-2 text-ink-muted">
                    {p.lastBomImport ? new Date(p.lastBomImport).toLocaleDateString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function MetricBox({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded bg-surface-2 px-3 py-2 text-center">
      <div className={cn("text-lg font-semibold", color)}>{value}</div>
      <div className="text-[10px] text-ink-subtle">{label}</div>
    </div>
  );
}
