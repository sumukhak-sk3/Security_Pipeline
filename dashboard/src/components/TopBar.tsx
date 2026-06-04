import { useTheme } from "../theme/ThemeProvider";
import { currentRun } from "../mock/data";
import StatusPill from "./StatusPill";

export default function TopBar() {
  const { theme, toggle } = useTheme();
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface-1 px-6">
      <div className="flex items-center gap-3">
        <div className="text-sm text-ink-muted">Current run</div>
        <div className="font-mono text-sm">{currentRun.id}</div>
        <StatusPill status={currentRun.status} />
        <div className="text-sm text-ink-muted">·</div>
        <div className="text-sm text-ink-muted">{currentRun.branch}</div>
      </div>

      <div className="flex items-center gap-2">
        <button
          className="rounded border border-line bg-surface-1 px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-surface-2 hover:text-ink"
          onClick={toggle}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? "Light" : "Dark"}
        </button>
        <div className="grid h-8 w-8 place-items-center rounded-full bg-surface-2 text-xs font-semibold">
          SK
        </div>
      </div>
    </header>
  );
}
