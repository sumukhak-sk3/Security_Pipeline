export const VERDICT_LABELS: Record<string, string> = {
  code_change: "Code Change",
  package_upgrade: "Package Upgrade",
  not_applicable: "Not Applicable",
  needs_human: "Needs Human Review",
  unknown: "Unknown",
};

export default function VerdictBadge({ verdict }: { verdict?: string }) {
  const key = (verdict || "unknown").toLowerCase();
  const label = VERDICT_LABELS[key] || verdict || "—";
  return <span className={`badge ${key}`}>{label}</span>;
}
