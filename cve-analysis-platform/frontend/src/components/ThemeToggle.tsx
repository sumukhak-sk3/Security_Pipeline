import { useEffect, useState } from "react";
import { getTheme, setTheme } from "../theme";

export default function ThemeToggle() {
  const [t, setT] = useState(getTheme());
  useEffect(() => {
    const onChange = (e: Event) => setT((e as CustomEvent).detail);
    window.addEventListener("theme-change", onChange);
    return () => window.removeEventListener("theme-change", onChange);
  }, []);
  return (
    <button
      type="button"
      title="Toggle light/dark theme"
      onClick={() => setTheme(t === "dark" ? "light" : "dark")}
    >
      {t === "dark" ? "🌙 Dark" : "☀️ Light"}
    </button>
  );
}
