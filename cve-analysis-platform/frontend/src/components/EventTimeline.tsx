import type { RunEvent } from "../types";

export default function EventTimeline({ events }: { events: RunEvent[] }) {
  if (!events.length) return <p className="muted">No events yet.</p>;
  return (
    <div className="event-timeline">
      {events.slice(-200).map((ev) => (
        <div className="ev" key={ev.seq}>
          <span className="ts">
            {new Date(ev.ts * 1000).toLocaleTimeString()}
          </span>
          <span className="name">{ev.event}</span>
          <span>{summarizeData(ev)}</span>
        </div>
      ))}
    </div>
  );
}

function summarizeData(ev: RunEvent): string {
  const d = ev.data || {};
  const cve = (d as any).cve_id;
  const verdict = (d as any).verdict;
  const idx = (d as any).index;
  const tot = (d as any).total;
  const parts: string[] = [];
  if (cve) parts.push(String(cve));
  if (idx !== undefined && tot !== undefined) parts.push(`${idx}/${tot}`);
  if (verdict) parts.push(`→ ${verdict}`);
  if (parts.length) return parts.join("  ");
  // Fallback: short JSON
  try {
    const s = JSON.stringify(d);
    return s.length > 120 ? s.slice(0, 117) + "..." : s;
  } catch {
    return "";
  }
}
