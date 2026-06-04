import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { recentRuns } from "../mock/data";
import StatusPill from "../components/StatusPill";
import { formatTime, formatDuration } from "../lib/format";
import type { Status } from "../types";

const statusFilters: (Status | "all")[] = ["all", "running", "success", "failed", "pending"];

export default function History() {
  const [status, setStatus] = useState<Status | "all">("all");
  const [branchQ, setBranchQ] = useState("");

  const rows = useMemo(() => {
    return recentRuns.filter((r) => {
      if (status !== "all" && r.status !== status) return false;
      if (branchQ && !r.branch.toLowerCase().includes(branchQ.toLowerCase())) return false;
      return true;
    });
  }, [status, branchQ]);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
            Pipeline history
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Runs</h1>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded border border-line bg-surface-1 p-1">
          {statusFilters.map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={
                "rounded px-2.5 py-1 text-xs capitalize " +
                (status === s ? "bg-surface-2 text-ink font-medium" : "text-ink-muted hover:text-ink")
              }
            >
              {s}
            </button>
          ))}
        </div>
        <input
          value={branchQ}
          onChange={(e) => setBranchQ(e.target.value)}
          placeholder="Filter by branch…"
          className="w-64 rounded border border-line bg-surface-1 px-3 py-1.5 text-sm placeholder:text-ink-subtle focus:border-accent focus:outline-none"
        />
      </div>

      <div className="overflow-hidden rounded border border-line bg-surface-1">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] font-medium uppercase tracking-wider text-ink-subtle">
              <th className="px-4 py-3">Run</th>
              <th className="px-4 py-3">Branch</th>
              <th className="px-4 py-3">Trigger</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const dur =
                r.startedAt && r.finishedAt
                  ? formatDuration(new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime())
                  : "—";
              return (
                <tr key={r.id} className="border-b border-line/60 last:border-b-0 hover:bg-surface-2">
                  <td className="px-4 py-3 font-mono text-xs">{r.id}</td>
                  <td className="px-4 py-3 text-ink-muted">{r.branch}</td>
                  <td className="px-4 py-3 text-ink-muted capitalize">{r.trigger}</td>
                  <td className="px-4 py-3 text-ink-muted">{formatTime(r.startedAt)}</td>
                  <td className="px-4 py-3 text-ink-muted">{dur}</td>
                  <td className="px-4 py-3">
                    <StatusPill status={r.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      to={`/history/${r.id}`}
                      className="rounded border border-line px-2 py-1 text-xs text-ink-muted hover:bg-surface-3 hover:text-ink"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-xs text-ink-subtle">
                  No runs match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
