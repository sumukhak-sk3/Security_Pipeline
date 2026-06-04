import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { cn } from "../lib/cn";

type Toast = { id: number; title: string; kind: "info" | "success" | "error" };
type Ctx = { push: (t: Omit<Toast, "id">) => void };

const ToastCtx = createContext<Ctx>({ push: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { ...t, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 4000);
  }, []);

  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-5 right-5 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "rounded border border-line bg-surface-1 px-4 py-3 text-sm shadow-card",
              t.kind === "success" && "border-status-success/40",
              t.kind === "error" && "border-status-failed/40"
            )}
          >
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
              {t.kind}
            </div>
            <div className="mt-0.5">{t.title}</div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
