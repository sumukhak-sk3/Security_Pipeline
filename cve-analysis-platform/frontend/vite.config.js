import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
// Vite dev server runs on :5173. The FastAPI server runs on :8088 by default.
// CORS is enabled server-side; we also expose VITE_API_BASE for the client.
// Set VITE_API_BASE in frontend/.env.local to point at a non-default backend.
export default defineConfig(function (_a) {
    var _b, _c, _d;
    var mode = _a.mode;
    var env = loadEnv(mode, (_d = (_c = (_b = globalThis.process) === null || _b === void 0 ? void 0 : _b.cwd) === null || _c === void 0 ? void 0 : _c.call(_b)) !== null && _d !== void 0 ? _d : "", "VITE_");
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
