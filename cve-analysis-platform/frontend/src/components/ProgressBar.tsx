export default function ProgressBar({
  done,
  total,
  label,
}: {
  done: number;
  total: number;
  label?: string;
}) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted">{label || "Progress"}</span>
        <span className="muted">
          {done}/{total > 0 ? total : "—"} ({pct}%)
        </span>
      </div>
      <div className="progress" style={{ marginTop: 4 }}>
        <div style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
