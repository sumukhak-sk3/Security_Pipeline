# Security Pipeline Dashboard

Unified dashboard for the NIOS security pipeline — three workflows, end-to-end,
with live Jenkins job status, pipeline-stage progress, streaming console
output, and a live view of the Impact Analyser backend.

| ID | Name                | What it does                                                                  |
| -- | ------------------- | ----------------------------------------------------------------------------- |
| E  | Build & Unit Tests  | Update Jammy mirror → build NIOS → run Quick UT + Slow UT in parallel         |
| B  | SBOM & CVE Scan     | Extract SBOM → upload to Dependency-Track → store CVE list to S3              |
| D  | Impact Analysis     | Poll S3 → (re)build code index → Impact Analyser → XLSX report → PR + upgrade |

## Stack

- React 18 + Vite 5 + TypeScript
- Tailwind CSS (dark + light theme via `class` strategy, Infoblox palette)
- React Router v6
- Vite dev proxy for Jenkins (Basic Auth held server-side — never in the client bundle)

## Quick start

```bash
npm install
cp .env.example .env.local      # fill in real URLs + tokens (see below)
npm run dev                     # http://localhost:5173
```

On boot, the dev server prints which Jenkins auth tokens it loaded, e.g.

```
[vite proxy] jenkins auth → inca=set ut=set impact=set
```

If any says `MISSING`, that workflow's job cards will render an error pill
until the token is added to `.env.local` and the server is restarted.

## Configuration

All runtime settings live in [src/config.ts](src/config.ts) and are read from
`VITE_*` env vars. Components never read `import.meta.env` directly. See
[.env.example](.env.example) for the full list. Highlights:

### Client-side (`VITE_*` — exposed to the browser bundle)

| Var | Purpose |
| --- | ------- |
| `VITE_APP_NAME` | Header / page title |
| `VITE_DATA_SOURCE` | `mock` or `live` (mock fills the workflows that aren't yet wired) |
| `VITE_POLL_INTERVAL_MS` | How often Jenkins + Impact API are polled (default 5000) |
| `VITE_JENKINS_JOB_E_NIOS_BUILD` / `_QUICK_UT` / `_SLOW_UT` | Full Jenkins job URLs for Workflow E |
| `VITE_JENKINS_JOB_D_*` | Full Jenkins job URL for the Impact Analyser pipeline |
| `VITE_IMPACT_API_URL` | Impact Analyser backend base (e.g. `http://10.120.23.89:8088`) |
| `VITE_IMPACT_UI_URL` | Impact Analyser frontend (e.g. `http://10.120.23.89:5173`) |
| `VITE_IMPACT_REDIRECT_URL` / `_LABEL` | Top-right CTA on the Impact Analysis page (defaults to `VITE_IMPACT_UI_URL`) |
| `VITE_FEAT_CONSOLE` / `_NOTIFICATIONS` / `_METRICS` | Feature flags |

### Server-side only (NO `VITE_` prefix — used by `vite.config.ts`)

| Var | Purpose |
| --- | ------- |
| `JENKINS_USER` / `JENKINS_API_TOKEN` | Basic Auth for `jenkins.inca.infoblox.com` (NIOS build) |
| `UT_JENKINS_USER` / `UT_JENKINS_API_TOKEN` | Basic Auth for the UT Jenkins (`10.197.38.69:8080`) |
| `IMPACT_JENKINS_USER` / `IMPACT_JENKINS_API_TOKEN` | Basic Auth for the Impact Analyser job (different owner than the NIOS build) |

> **Never** prefix these with `VITE_`. The `VITE_` prefix tells Vite to inline
> the value into the client bundle, which would publish your tokens.

## How Jenkins integration works

Browsers can't call Jenkins directly: CORS + Basic Auth would either fail or
require shipping the API token to every visitor. So in dev,
[vite.config.ts](vite.config.ts) sets up three reverse proxies:

```
/_jenkins/impact/*  →  https://jenkins.inca.infoblox.com/*   (IMPACT_JENKINS_*)
/_jenkins/inca/*    →  https://jenkins.inca.infoblox.com/*   (JENKINS_*)
/_jenkins/ut/*      →  http://<ip>:8080/*            (UT_JENKINS_*)
```

[src/api/jenkinsClient.ts](src/api/jenkinsClient.ts) rewrites real Jenkins URLs
to those proxy paths at fetch time, so:

- The `Open in Jenkins ↗` links keep pointing at the real UI.
- All API calls go through the proxy with the right token injected.
- The proxy strips upstream `WWW-Authenticate` headers so a 401 surfaces as an
  in-app error card instead of triggering the browser's native login prompt.

> For production, replace this with a real backend that proxies + authenticates
> the same way. The dev proxy is dev-only.

## Pages

- **Overview** (`/`) — pipeline strip with live aggregated status for E + D,
  active-job feed, artifacts, PR status.
- **Workflow page** (`/workflows/:id`) — per-job cards with live Jenkins
  status, pipeline-stage breakdown, recent-build history, and a streaming
  console drawer.
- **History** (`/history`) — runs table with status + branch filters.
- **Metrics** (`/metrics`) — placeholder for trend charts.

## Progress model

Each Jenkins job's progress bar is computed from the **headline build**
(running build if any, otherwise the last completed build):

1. If the build is a Pipeline with stage info → `completed_stages / total_stages`
   (running stage counts as half-done). This advances live as the pipeline
   moves between stages.
2. Else, while building → `elapsed / estimatedDuration`.
3. Else → 100% (the build is finished, regardless of result).

Workflow-level progress is the average of its jobs. The aggregation lives in
[src/lib/jenkinsMap.ts](src/lib/jenkinsMap.ts) and is used by both the
Overview tiles and the per-workflow cards so they always agree.

## Live data plumbing

| What | Hook | Component |
| --- | --- | --- |
| One Jenkins job (status + stages) | [`useJenkinsJob`](src/hooks/useJenkinsJob.ts) | [`JenkinsJobCard`](src/components/JenkinsJobCard.tsx) |
| Many Jenkins jobs, aggregated | [`useWorkflowLiveSummary`](src/hooks/useWorkflowLiveSummary.ts) | Overview workflow tiles |
| Impact Analyser backend | [`useImpactStatus`](src/hooks/useImpactStatus.ts) | [`ImpactLivePanel`](src/components/ImpactLivePanel.tsx) |
| Streaming Jenkins console | inline | [`JenkinsConsoleDrawer`](src/components/JenkinsConsoleDrawer.tsx) |

Workflow B still uses mock data from [src/mock/data.ts](src/mock/data.ts) until
its Jenkins jobs are wired — just add them to the `B` block in
[src/config.ts](src/config.ts) and [src/workflowJobs.ts](src/workflowJobs.ts).

## Theming

CSS variables in [src/index.css](src/index.css) drive Tailwind's `surface`,
`ink`, `line`, `accent`, and `status` tokens. Swap the variable values to
re-brand without touching components.

## Project layout

```
src/
  api/           # jenkinsClient.ts, impactClient.ts
  components/    # JenkinsJobCard, JenkinsConsoleDrawer, ImpactLivePanel, ...
  hooks/         # useJenkinsJob, useWorkflowLiveSummary, useImpactStatus, ...
  lib/           # cn, format, jenkinsMap (shared mapping helpers)
  mock/          # data.ts — fallback data for not-yet-wired workflows
  pages/         # Overview, WorkflowPage, History, Metrics
  config.ts      # ONE place env vars are read; everything else imports from here
  workflowJobs.ts # workflow → [{id,title,jenkinsUrl}] mapping (shared by pages)
  workflows.ts   # display metadata (short/full names)
  types.ts       # Run, Workflow, Job, Step, Status
vite.config.ts   # dev proxy with server-side Basic Auth
```

## Security checklist before pushing

- ✅ `.env.local` is gitignored — confirm with `git check-ignore .env.local`.
- ✅ Real tokens live ONLY in `.env.local`, never in `.env.example` or source.
- ✅ Server-side env vars (`JENKINS_*`, `UT_JENKINS_*`, `IMPACT_JENKINS_*`) have
  NO `VITE_` prefix, so they're not bundled.
- ✅ Run `git ls-files | xargs grep -nE '<your_token_pattern>'` before each
  push to confirm nothing leaked.

## Removing the backend plugin (optional)

The embedded caching proxy (`vite-backend-plugin.ts`) provides server-side
polling, in-memory caching, WebSocket push updates, and inline prefetch data.
If your architecture does not require WebSocket or server-side caching (e.g.
you have a separate backend service, or you only need the Vite dev proxy for
direct API calls), you can safely remove it:

1. Delete `vite-backend-plugin.ts`
2. In `vite.config.ts`, remove the `import { backendPlugin }` line and remove
   `backendPlugin()` from the `plugins` array
3. Delete `src/api/prefetch.ts` and remove the `startPrefetch()` call from
   `src/main.tsx`
4. Delete `src/hooks/useBackendWs.ts`

The existing proxy routes (`/_jenkins/*`, `/_rp/*`) in `vite.config.ts` will
continue to work as before — components will fall back to direct API calls
through those proxies.

## Build

```bash
npm run build    # → dist/
npm run preview  # serves the production bundle locally
```

> `npm run preview` does NOT include the dev proxy. For live Jenkins data in
> a deployed build, a real backend (or a tiny Node/Express proxy mirroring
> `vite.config.ts`) is required.
