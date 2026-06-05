import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import type { CVERow, Verdict } from "../types";
import VerdictBadge, { VERDICT_LABELS } from "../components/VerdictBadge";
import ProgressBar from "../components/ProgressBar";
import EventTimeline from "../components/EventTimeline";
import { useEventStream } from "../hooks/useEventStream";

interface RunEnvelope {
  run_id: string;
  status: { state?: string; started_at?: number; ended_at?: number } | null;
  artifact: any;
}

type CVELive = {
  cve_id: string;
  verdict?: string;
  model_verdict?: string | null;
  human_action?: string | null;
  component?: string;
  severity?: string;
  state?: "queued" | "running" | "completed" | "failed";
  has_patch?: boolean;
  files_touched?: string[];
};

const TAB_ORDER: Verdict[] = [
  "package_upgrade",
  "code_change",
  "needs_human",
  "not_applicable",
];

function isCancellable(
  run: RunEnvelope | null,
  events: Array<{ event: string }>,
): boolean {
  // A run is cancellable while it is still running (i.e. we haven't
  // observed a terminal event and the registry hasn't transitioned to
  // a non-running state).
  const state = run?.status?.state;
  if (state && state !== "running") return false;
  const terminal = events.some(
    (e) => e.event === "run.completed" || e.event === "run.failed",
  );
  return !terminal;
}

export default function RunDetail() {
  const { runId } = useParams();
  const [run, setRun] = useState<RunEnvelope | null>(null);
  const [rest, setRest] = useState<CVERow[]>([]);
  const [activeTab, setActiveTab] = useState<Verdict | "all">("all");
  const [cancelState, setCancelState] = useState<
    "idle" | "pending" | "requested" | "failed"
  >("idle");
  const [cancelError, setCancelError] = useState<string | null>(null);
  const { events, connected, error } = useEventStream(runId);

  // Poll the run summary
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    function load() {
      api.getRun(runId!).then(
        (r) => !cancelled && setRun(r),
        () => {},
      );
      api.getRunCVEs(runId!).then(
        (rs) => !cancelled && setRest(rs),
        () => {},
      );
    }
    load();
    const id = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runId]);

  // Derive a live CVE table from events + REST snapshot.
  // The SBOM can produce multiple rows for the same CVE id (one per
  // affected component), so we key by `cve_id|component` to keep them
  // distinct. Events only carry `cve_id`, so they are applied to every
  // matching component-row.
  const cves = useMemo(() => {
    const keyOf = (cve: string, comp?: string | null) =>
      `${cve}|${comp || ""}`;
    const map = new Map<string, CVELive>();
    for (const c of rest) {
      map.set(keyOf(c.cve_id, c.component), {
        cve_id: c.cve_id,
        verdict: c.verdict,
        model_verdict: c.model_verdict as string | null | undefined,
        human_action: c.human_action as string | null | undefined,
        component: c.component,
        severity: c.severity,
        state: c.state as CVELive["state"],
        has_patch: c.has_patch,
        files_touched: c.files_touched,
      });
    }
    const findMatches = (cve: string, comp?: string | null): CVELive[] => {
      if (comp) {
        const exact = map.get(keyOf(cve, comp));
        if (exact) return [exact];
      }
      // Fall back to every row that shares this cve_id.
      return Array.from(map.values()).filter((r) => r.cve_id === cve);
    };
    for (const ev of events) {
      const d = (ev.data || {}) as any;
      const cve = d.cve_id;
      if (!cve) continue;
      let targets = findMatches(cve, d.component);
      if (targets.length === 0) {
        // First time we see this CVE — create a placeholder row.
        const placeholder: CVELive = {
          cve_id: cve,
          verdict: "unknown",
          component: d.component,
        };
        map.set(keyOf(cve, d.component), placeholder);
        targets = [placeholder];
      }
      for (const cur of targets) {
        if (ev.event === "cve.queued") cur.state = "queued";
        if (ev.event === "cve.started") cur.state = "running";
        if (ev.event === "cve.completed") {
          cur.state = "completed";
          const v = d.final_verdict ?? d.verdict;
          // A human reassignment is authoritative — don't let a later
          // re-analysis event silently overwrite it. The model's new
          // verdict is preserved separately as model_verdict.
          if (v && cur.human_action !== "reassign") cur.verdict = v;
          if (v && cur.human_action === "reassign" && !cur.model_verdict) {
            cur.model_verdict = v;
          }
        }
        if (ev.event === "cve.failed") cur.state = "failed";
        if (d.component && !cur.component) cur.component = d.component;
        if (d.severity && !cur.severity) cur.severity = d.severity;
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      const byCve = a.cve_id.localeCompare(b.cve_id);
      if (byCve !== 0) return byCve;
      return (a.component || "").localeCompare(b.component || "");
    });
  }, [rest, events]);

  // Determine total CVEs even when no run.total event has fired yet.
  // We pick the max of: queued count, run payload limit, current cve set size.
  const queued = cves.filter((c) => !!c.state).length;
  const total = useMemo(() => {
    // Prefer an explicit RUN_STARTED total
    const startEv = events.find((e) => e.event === "run.started");
    const fromStart = startEv && (startEv.data as any)?.total;
    if (typeof fromStart === "number" && fromStart > 0) return fromStart;
    // Otherwise: number of cve.queued events we've ever seen
    const queuedSet = new Set<string>();
    for (const ev of events) {
      if (ev.event === "cve.queued") {
        const c = (ev.data as any).cve_id;
        if (c) queuedSet.add(c);
      }
    }
    if (queuedSet.size) return queuedSet.size;
    return cves.length;
  }, [events, cves.length, queued]);

  const done = cves.filter(
    (c) => c.state === "completed" || c.state === "failed",
  ).length;

  // Group by verdict for tabs
  const grouped: Record<string, CVELive[]> = {
    package_upgrade: [],
    code_change: [],
    needs_human: [],
    not_applicable: [],
    unknown: [],
  };
  for (const c of cves) {
    const v = (c.verdict || "unknown").toLowerCase();
    (grouped[v] ?? grouped.unknown).push(c);
    // When a human reassigned the verdict, also surface the row under its
    // original (model) verdict so operators can still find it where it
    // first appeared.
    if (c.human_action === "reassign" && c.model_verdict) {
      const mv = c.model_verdict.toLowerCase();
      if (mv && mv !== v && grouped[mv]) {
        grouped[mv].push(c);
      }
    }
  }

  return (
    <div>
      <div className="toolbar">
        <div>
          <Link to="/">← Runs</Link>
          <h2 style={{ margin: "8px 0" }}>
            <code>{runId}</code>
          </h2>
          <div className="row muted">
            <span>
              Status:{" "}
              <strong style={{ color: "var(--fg)" }}>
                {run?.status?.state ?? (run?.artifact ? "archived" : "—")}
              </strong>
            </span>
            <span>·</span>
            <span>WS: {connected ? "🟢 connected" : "⚪ idle"}</span>
            {error && <span className="error" style={{ padding: "2px 8px" }}>{error}</span>}
          </div>
        </div>
        <div className="row">
          <button
            className="danger"
            disabled={
              cancelState === "pending" ||
              cancelState === "requested" ||
              !runId ||
              !isCancellable(run, events)
            }
            title={
              isCancellable(run, events)
                ? "Stop / terminate this run"
                : "Run is no longer active"
            }
            onClick={async () => {
              if (!runId) return;
              setCancelState("pending");
              setCancelError(null);
              try {
                await api.cancelRun(runId);
                setCancelState("requested");
              } catch (e) {
                setCancelError(String(e));
                setCancelState("failed");
              }
            }}
          >
            {cancelState === "requested"
              ? "Stop requested…"
              : cancelState === "pending"
              ? "Stopping…"
              : "⏹ Stop run"}
          </button>
          <a
            href={api.reportXlsxUrl(runId!)}
            target="_blank"
            rel="noreferrer"
          >
            <button>⬇ Download Excel report</button>
          </a>
        </div>
      </div>
      {cancelError && <div className="error">{cancelError}</div>}

      <div className="card">
        <ProgressBar
          done={done}
          total={total}
          label={`Analyzing CVEs (${done} done of ${total})`}
        />
        <div className="row" style={{ marginTop: 12 }}>
          {TAB_ORDER.map((v) => (
            <span key={v} className={`badge ${v}`}>
              {VERDICT_LABELS[v]}: {grouped[v]?.length ?? 0}
            </span>
          ))}
          {grouped.unknown.length > 0 && (
            <span className="badge unknown">
              Pending: {grouped.unknown.length}
            </span>
          )}
        </div>
      </div>

      <FilesModifiedPanel cves={cves} runId={runId!} />

      <div className="tabs">
        <button
          className={`tab ${activeTab === "all" ? "active" : ""}`}
          onClick={() => setActiveTab("all")}
        >
          All <span className="count">{cves.length}</span>
        </button>
        {TAB_ORDER.map((v) => (
          <button
            key={v}
            className={`tab ${activeTab === v ? "active" : ""}`}
            onClick={() => setActiveTab(v)}
          >
            {VERDICT_LABELS[v]}{" "}
            <span className="count">{grouped[v]?.length ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <CVETable
          rows={
            activeTab === "all" ? cves : (grouped[activeTab] || []).slice()
          }
          runId={runId!}
        />
      </div>

      <div className="card">
        <h3>Event timeline</h3>
        <EventTimeline events={events} />
      </div>
    </div>
  );
}

function FilesModifiedPanel({
  cves,
  runId,
}: {
  cves: CVELive[];
  runId: string;
}) {
  // Aggregate every file touched by an authored patch across the run.
  // For each file we keep the count of CVEs that touched it and the first
  // CVE id, so the operator can click through to see the diff.
  const byFile = new Map<string, { count: number; firstCve: string }>();
  for (const c of cves) {
    if (!c.has_patch || !c.files_touched?.length) continue;
    for (const f of c.files_touched) {
      const cur = byFile.get(f);
      if (cur) cur.count += 1;
      else byFile.set(f, { count: 1, firstCve: c.cve_id });
    }
  }
  if (byFile.size === 0) return null;
  const entries = Array.from(byFile.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Files modified ({entries.length})</h3>
      <div className="muted" style={{ marginBottom: 8 }}>
        Source files that authored patches in this run will change. Click a file
        to see the patch for the first CVE that touched it.
      </div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {entries.map(([file, info]) => (
          <li key={file}>
            <Link to={`/runs/${runId}/cves/${info.firstCve}`}>
              <code>{file}</code>
            </Link>{" "}
            <span className="muted">
              · {info.count} CVE{info.count === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CVETable({ rows, runId }: { rows: CVELive[]; runId: string }) {
  if (!rows.length) return <div className="empty">No CVEs in this group.</div>;
  return (
    <table>
      <thead>
        <tr>
          <th>CVE</th>
          <th>Component</th>
          <th>Severity</th>
          <th>State</th>
          <th>Verdict</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr
            key={`${c.cve_id}|${c.component || ""}`}
            style={{ cursor: "pointer" }}
            onClick={(e) => {
              // ignore clicks on the link itself
              if ((e.target as HTMLElement).tagName === "A") return;
              window.location.href = `/runs/${runId}/cves/${c.cve_id}`;
            }}
          >
            <td>
              <Link to={`/runs/${runId}/cves/${c.cve_id}`}>
                <code>{c.cve_id}</code>
              </Link>
            </td>
            <td>{c.component || "—"}</td>
            <td>{c.severity || "—"}</td>
            <td>
              <span className="muted">{c.state || "—"}</span>
            </td>
            <td>
              <VerdictBadge verdict={c.verdict} />
              {c.human_action === "reassign" &&
                c.model_verdict &&
                c.model_verdict !== c.verdict && (
                  <span
                    className="badge unknown"
                    style={{ marginLeft: 6 }}
                    title={`Human override (model said ${c.model_verdict})`}
                  >
                    overridden
                  </span>
                )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
