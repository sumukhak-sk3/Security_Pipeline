import { recentRuns } from "../mock/data";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border border-line bg-surface-1 p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-subtle">{hint}</div>}
    </div>
  );
}

export default function Metrics() {
  const total = recentRuns.length;
  const success = recentRuns.filter((r) => r.status === "success").length;
  const failed = recentRuns.filter((r) => r.status === "failed").length;
  const avgMin = 42; // mock

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
          Pipeline metrics
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Health</h1>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Runs (7d)" value={String(total)} />
        <Stat
          label="Success rate"
          value={`${Math.round((success / Math.max(total, 1)) * 100)}%`}
          hint={`${success} success · ${failed} failed`}
        />
        <Stat label="Avg duration" value={`${avgMin}m`} hint="Mocked" />
        <Stat label="CVEs (last run)" value="12" hint="3 high · 9 medium" />
      </div>

      <div className="rounded border border-line bg-surface-1 p-6">
        <div className="text-sm font-semibold">Trends</div>
        <div className="mt-1 text-xs text-ink-muted">
          Chart placeholder — wire to real data later.
        </div>
        <div className="mt-6 grid h-48 place-items-center rounded border border-dashed border-line text-xs text-ink-subtle">
          [ chart goes here ]
        </div>
      </div>
    </div>
  );
}
