import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Vite dev server runs on :5173. The FastAPI server runs on :8088 by default.
// CORS is enabled server-side; we also expose VITE_API_BASE for the client.
// Set VITE_API_BASE in frontend/.env.local to point at a non-default backend.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, (globalThis as any).process?.cwd?.() ?? "", "VITE_");
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: false,
    },
    define: {
      __API_BASE__: JSON.stringify(env.VITE_API_BASE || "http://localhost:8088"),
    },
  };
});
