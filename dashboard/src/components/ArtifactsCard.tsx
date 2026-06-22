/**
 * Artifacts list — shows the files attached to a Jenkins build (SBOM, CVE
 * lists, reports, etc.). Sourced live from `useJenkinsJob().artifacts` which
 * is populated server-side by the backend plugin (single API call per build).
 *
 * Download URLs go through the same Jenkins proxy as other Jenkins requests,
 * so auth is handled transparently.
 *
 * REVERSIBLE: Delete this file and remove its use from JenkinsJobCard.
 */

import type { CachedJenkinsArtifact } from "../api/cachedClient";
import { toProxyUrl } from "../api/jenkinsClient";

interface ArtifactsCardProps {
  readonly artifacts: CachedJenkinsArtifact[];
  readonly buildNumber: number | null;
  readonly jenkinsUrl: string;
}

// File-extension → label map for the small badge on each row
function kindLabel(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json") && lower.includes("sbom")) return "SBOM";
  if (lower.endsWith(".cdx.json") || lower.endsWith(".bom.json")) return "SBOM";
  if (lower.includes("cve") && (lower.endsWith(".json") || lower.endsWith(".csv"))) return "CVE LIST";
  if (lower.endsWith(".html") || lower.endsWith(".pdf")) return "REPORT";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return "REPORT";
  if (lower.endsWith(".log") || lower.endsWith(".txt")) return "LOG";
  if (lower.endsWith(".zip") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "ARCHIVE";
  if (lower.endsWith(".json")) return "JSON";
  if (lower.endsWith(".xml")) return "XML";
  return "FILE";
}

export default function ArtifactsCard({ artifacts, buildNumber, jenkinsUrl }: ArtifactsCardProps) {
  if (!artifacts || artifacts.length === 0) {
    return (
      <div className="border-t border-line px-4 py-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
          Artifacts {buildNumber ? `· #${buildNumber}` : ""}
        </div>
        <div className="mt-1 text-[11px] text-ink-subtle">
          No artifacts produced by this build.
        </div>
      </div>
    );
  }

  const browseAll = buildNumber ? toProxyUrl(`${jenkinsUrl}/${buildNumber}/artifact/`) : "";

  return (
    <div className="border-t border-line px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
          Artifacts {buildNumber ? `· #${buildNumber}` : ""} ({artifacts.length})
        </div>
        {browseAll && (
          <a
            href={browseAll}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-ink-muted hover:text-ink"
          >
            Browse all ↗
          </a>
        )}
      </div>
      <ul className="mt-2 divide-y divide-line rounded border border-line bg-surface-0">
        {artifacts.map((a) => {
          const proxied = toProxyUrl(a.downloadUrl);
          return (
            <li
              key={a.relativePath}
              className="flex items-center gap-3 px-3 py-2"
            >
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-ink-muted">
                {kindLabel(a.fileName)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[11px] text-ink">{a.fileName}</div>
                {a.relativePath !== a.fileName && (
                  <div className="truncate text-[10px] text-ink-subtle" title={a.relativePath}>
                    {a.relativePath}
                  </div>
                )}
              </div>
              <a
                href={proxied}
                download={a.fileName}
                className="rounded border border-line px-2 py-0.5 text-[10px] text-ink-muted hover:bg-surface-2 hover:text-ink"
              >
                Download
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
