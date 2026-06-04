import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { RunSummary } from "../types";

export default function Dashboard() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    function load() {
      api
        .listRuns()
        .then((rs) => {
          if (!cancelled) setRuns(rs);
        })
        .catch((e) => !cancelled && setError(String(e)));
    }
    load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Runs</h2>
        <div className="row">
          <Link to="/runs/new">
            <button className="primary">+ New Run</button>
          </Link>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {!runs && <div className="empty">Loading…</div>}
        {runs && runs.length === 0 && (
          <div className="empty">
            No runs yet. Click <strong>New Run</strong> to start one.
          </div>
        )}
        {runs && runs.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Run</th>
                <th>State</th>
                <th>CVEs</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Modified</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.run_id}
                  style={{ cursor: "pointer" }}
                  onClick={() =>
                    (window.location.href = `/runs/${r.run_id}`)
                  }
                >
                  <td>
                    <strong>{r.project || "—"}</strong>
                    {r.index_id && (
                      <div className="muted" style={{ fontSize: 11 }}>
                        idx: <code>{r.index_id}</code>
                      </div>
                    )}
                  </td>
                  <td>
                    <Link to={`/runs/${r.run_id}`}>
                      <code>{r.run_id}</code>
                    </Link>
                  </td>
                  <td>
                    <span className={`badge ${statusClass(r.state)}`}>
                      {r.state ?? "archived"}
                    </span>
                  </td>
                  <td>{r.total_cves ?? "—"}</td>
                  <td>{fmtTime(r.started_at)}</td>
                  <td>{fmtDuration(r)}</td>
                  <td>{fmtTime(r.mtime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function fmtTime(t?: number): string {
  if (!t) return "—";
  return new Date(t * 1000).toLocaleString();
}
function fmtDuration(r: RunSummary): string {
  if (!r.started_at) return "—";
  const end = r.ended_at ?? Date.now() / 1000;
  const s = Math.max(0, end - r.started_at);
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s`;
}
function statusClass(state?: string): string {
  if (state === "completed" || state === "ok") return "not_applicable";
  if (state === "failed") return "needs_human";
  if (state === "running") return "package_upgrade";
  if (state === "cancelled") return "code_change";
  return "unknown";
}
