import type { Artifact } from "../types";
import { relTime } from "../lib/format";

const kindLabel: Record<Artifact["kind"], string> = {
  sbom: "SBOM",
  "cve-list": "CVE list",
  report: "Report",
  index: "Index",
  other: "Artifact",
};

export default function ArtifactsPanel({ artifacts }: { artifacts: Artifact[] }) {
  return (
    <div className="rounded border border-line bg-surface-1">
      <div className="border-b border-line px-4 py-3 text-sm font-semibold">Artifacts</div>
      {artifacts.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-ink-subtle">
          No artifacts produced yet.
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {artifacts.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-4 py-3">
              <span className="rounded bg-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                {kindLabel[a.kind]}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs">{a.name}</div>
                <div className="text-[11px] text-ink-subtle">
                  {a.producedBy} · {relTime(a.createdAt)} {a.size ? `· ${a.size}` : ""}
                </div>
              </div>
              <a
                href={a.url ?? "#"}
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
