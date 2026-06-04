# Security Pipeline

Minimal skeleton frontend for the NIOS security pipeline.

Three workflows, end-to-end:

| ID | Name                | What it does                                                              |
| -- | ------------------- | ------------------------------------------------------------------------- |
| E  | Build & Unit Tests  | Update Jammy mirror → build NIOS → quick + slow UT                        |
| B  | SBOM & CVE Scan     | Extract SBOM → upload to Dependency-Track → store CVE list to S3          |
| D  | Impact Analysis     | Poll S3 → (re)build code index → Impact Analyser → XLSX report → PR + upgrade |

## Stack
- React 18 + Vite + TypeScript
- Tailwind CSS (dark + light theme via `class` strategy)
- React Router
- Mock data by default (see [src/mock/data.ts](src/mock/data.ts))

## Run

```bash
npm install
cp .env.example .env.local   # optional — only needed when wiring real endpoints
npm run dev
```

Open http://localhost:5173.

## Configuration

All runtime settings live in [src/config.ts](src/config.ts) and are read from `VITE_*` env vars. Nothing in the components reads `import.meta.env` directly. See [.env.example](.env.example) for the full list:

- `VITE_APP_NAME`, `VITE_DATA_SOURCE` (`mock` | `live`)
- `VITE_API_BASE_URL`, `VITE_POLL_INTERVAL_MS`
- `VITE_JENKINS_BASE_URL`, `VITE_JENKINS_JOB_*`
- `VITE_DTRACK_BASE_URL`, `VITE_DTRACK_PROJECT_ID`
- `VITE_S3_BUCKET`, `VITE_S3_CVE_PREFIX`, `VITE_S3_REGION`
- `VITE_IMPACT_API_URL`, `VITE_IMPACT_AUTHOR_MODEL`, `VITE_IMPACT_VERIFIER_MODEL`
- Feature flags: `VITE_FEAT_CONSOLE`, `VITE_FEAT_NOTIFICATIONS`, `VITE_FEAT_METRICS`

Workflow display names live in [src/workflows.ts](src/workflows.ts) — change once, updated everywhere.

## What's in here

- **Overview** (`/`) — end-to-end run with all 3 workflows, active jobs, artifacts, PR status.
- **Workflow page** (`/workflows/:id`) — drill into one workflow's jobs, each expandable to per-step progress bars.
- **History** (`/history`) — runs table with status + branch filters; click into a run for full detail.
- **Metrics** (`/metrics`) — placeholder stats + chart slot.
- **Console drawer** — slide-in panel showing per-job step logs.
- **Theme toggle** — top-right of the header.

## Progress model

Three levels, all driven by `progress: 0..100` and `status` on each node:

```
Workflow → Job → Step
```

Each level renders the same `ProgressBar` component with a status-coloured fill; `running` adds a striped animation.

## Wiring real data later

Replace the exports in [src/mock/data.ts](src/mock/data.ts) with a real API client that returns the same `Run` shape from [src/types.ts](src/types.ts). Endpoints come from [src/config.ts](src/config.ts); set `VITE_DATA_SOURCE=live` and add a thin `src/api/client.ts`.

## Theming

CSS variables in [src/index.css](src/index.css) drive Tailwind's `surface`, `ink`, `line`, `accent`, and `status` colors. Adjust those tokens (or drop in real Infoblox brand values) without touching components.

