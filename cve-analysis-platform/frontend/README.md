# Frontend — CVE Analysis Platform

React + TypeScript + Vite dashboard for the Workflow D backend.

## Pages

| Route | Purpose |
| --- | --- |
| `/` | Recent runs (auto-refreshes every 5s) |
| `/runs/new` | Start a new run — author/verifier model dropdowns sourced from `GET /models` |
| `/runs/:rid` | Live run detail with **tabs by verdict** (Package Upgrade / Code Change / Needs Human Review / Not Applicable), progress bar, event timeline, **Download Excel report** button |
| `/runs/:rid/cves/:cveId` | Human-readable CVE summary (description, impact, reachability, suggested remediation, …) + **HITL action buttons** (Approve / Reject / Reassign / Add note) + audit history |
| `/index` | Build / update the code index from **a local path OR a git URL + branch** |
| `/jenkins` | Placeholder Jenkins trigger button (records request, real client wired later) |

## Light / Dark theme

Toggled from the top-right corner. Persisted in `localStorage`; default = OS preference.

## Configuration

The frontend talks to the FastAPI backend at `VITE_API_BASE` (default `http://localhost:8088`).
Copy `.env.example` → `.env.local` to override.

## Running

```bash
# 1. Install once
cd cve-analysis-platform/frontend
npm install

# 2. Start the backend (port 8088 by default)
cd ..
source ../.venv/bin/activate           # adjust to your venv
python scripts/run_workflow_d.py --port 8088

# 3. In a second terminal, start the React dev server
cd cve-analysis-platform/frontend
npm run dev                            # opens http://localhost:5173
```

CORS is enabled server-side for `http://localhost:5173` and `:3000` (see
`cfg.service.cors_origins` in `configs/app.yaml`).

## Production build

```bash
npm run build       # emits dist/
npm run preview     # serves dist/ on :4173 for spot-checks
```

The old static dashboard at `apps/workflow_d/ui/index.html` is left untouched
and is still served at `GET /`. The React app is the new managed surface.
