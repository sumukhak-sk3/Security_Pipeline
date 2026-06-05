import { NavLink } from "react-router-dom";
import { cn } from "../lib/cn";
import { config } from "../config";
import { workflowMeta } from "../workflows";
import { useTheme } from "../theme/ThemeProvider";

export default function Sidebar() {
  const { theme } = useTheme();
  const logoSrc = theme === "dark" ? "/logo.jpg" : "/logo.png";

  const items = [
    { to: "/", label: "Overview", end: true },
    ...workflowMeta.map((w) => ({
      to: `/workflows/${w.id}`,
      label: w.shortName,
    })),
    { to: "/history", label: "History" },
    ...(config.features.metrics ? [{ to: "/metrics", label: "Metrics" }] : []),
  ];

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface-1 md:flex">
      <div className="flex h-14 items-center gap-2 border-b border-line px-5">
        <img
          src={logoSrc}
          alt={config.appName}
          className="h-7 w-auto"
          onError={(e) => {
            // graceful fallback if logo isn't placed yet
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
        <div className="text-sm font-semibold tracking-tight">{config.appName}</div>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 p-3">
        <div className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
          Navigate
        </div>
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={(it as { end?: boolean }).end}
            className={({ isActive }) =>
              cn(
                "rounded px-3 py-1.5 text-sm transition-colors",
                isActive
                  ? "bg-surface-2 text-ink font-medium"
                  : "text-ink-muted hover:bg-surface-2 hover:text-ink"
              )
            }
          >
            {it.label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-line p-4 text-[11px] text-ink-subtle">
        v0.1.0 · {config.dataSource} data
      </div>
    </aside>
  );
}
