import type { Run, Workflow, Status, Job } from "../types";

const now = Date.now();
const iso = (offsetMin: number) => new Date(now + offsetMin * 60_000).toISOString();

// Internal helper types so we don't have to repeat `workflowId` on each Job
// literal — attachWorkflowId() stamps it in at the end.
type DraftJob = Omit<Job, "workflowId">;
type DraftWorkflow = Omit<Workflow, "jobs"> & { jobs: DraftJob[] };

/** Stamp `workflowId` onto every job. */
function attachWorkflowId(w: DraftWorkflow): Workflow {
  return {
    ...w,
    jobs: w.jobs.map((j, i) => ({
      ...j,
      workflowId: w.id,
      buildNumber: 100 + i,
    })),
  };
}

function step(id: string, name: string, status: Status, progress: number, logs: string[] = []) {
  return {
    id,
    name,
    status,
    progress,
    startedAt: iso(-30),
    finishedAt: status === "success" || status === "failed" ? iso(-10) : undefined,
    log: logs,
  };
}

const workflowE: DraftWorkflow = {
  id: "E",
  name: "Build & Unit Tests — NIOS build + UT",
  description:
    "Triggered on Jenkins. Updates Jammy mirror, clones NIOS, creates bugfix branch, updates ubuntu.json, builds NIOS, runs quick + slow UT in parallel.",
  status: "running",
  progress: 62,
  startedAt: iso(-45),
  // workflowId stamped onto each job by attachWorkflowId() — see exports below.
  jobs: [
    {
      id: "e-orchestrator",
      name: "Orchestrator (entry job)",
      status: "success",
      progress: 100,
      startedAt: iso(-45),
      finishedAt: iso(-43),
      steps: [
        step("e-o-1", "Parse parameters", "success", 100),
        step("e-o-2", "Invoke phase-1 trigger", "success", 100),
      ],
    },
    {
      id: "e-mirror",
      name: "Phase 1 — Update Jammy mirror",
      status: "success",
      progress: 100,
      startedAt: iso(-43),
      finishedAt: iso(-30),
      steps: [
        step("e-m-1", "Sync upstream Ubuntu Jammy", "success", 100),
        step("e-m-2", "Publish to internal mirror", "success", 100),
        step("e-m-3", "Verify checksum", "success", 100),
      ],
    },
    {
      id: "e-nios-build",
      name: "NIOS build",
      status: "running",
      progress: 70,
      startedAt: iso(-30),
      steps: [
        step("e-b-1", "Clone NIOS repo", "success", 100),
        step("e-b-2", "Create bugfix branch", "success", 100),
        step("e-b-3", "Patch ubuntu.json mirror URL", "success", 100),
        step("e-b-4", "Build NIOS image", "running", 60, [
          "[12:04:11] make all",
          "[12:04:33] CC kernel/sched.o",
          "[12:05:01] CC drivers/net/...",
        ]),
        step("e-b-5", "Publish artifacts", "pending", 0),
      ],
    },
    {
      id: "e-quick-ut",
      name: "Quick UT",
      status: "running",
      progress: 40,
      startedAt: iso(-25),
      steps: [
        step("e-q-1", "Provision test VM", "success", 100),
        step("e-q-2", "Run quick suite", "running", 40),
      ],
    },
    {
      id: "e-slow-ut",
      name: "Slow UT",
      status: "pending",
      progress: 0,
      steps: [
        step("e-s-1", "Provision test VM", "pending", 0),
        step("e-s-2", "Run slow suite", "pending", 0),
      ],
    },
  ],
};

const workflowB: DraftWorkflow = {
  id: "B",
  name: "SBOM & CVE Scan — SBOM → Dependency-Track → S3",
  description:
    "Once NIOS build is done, SBOM is extracted, uploaded to Dependency-Track, the CVE list is fetched and stored to S3.",
  status: "pending",
  progress: 0,
  jobs: [
    {
      id: "b-extract",
      name: "Extract SBOM from build",
      status: "pending",
      progress: 0,
      steps: [step("b-e-1", "Read build artifact", "pending", 0), step("b-e-2", "Generate SBOM", "pending", 0)],
    },
    {
      id: "b-dtrack",
      name: "Upload to Dependency-Track",
      status: "pending",
      progress: 0,
      steps: [
        step("b-d-1", "POST /api/v1/bom", "pending", 0),
        step("b-d-2", "Poll for analysis completion", "pending", 0),
        step("b-d-3", "Fetch CVE list", "pending", 0),
      ],
    },
    {
      id: "b-s3",
      name: "Store CVE output to S3",
      status: "pending",
      progress: 0,
      steps: [step("b-s-1", "Upload object", "pending", 0), step("b-s-2", "Tag + index", "pending", 0)],
    },
  ],
};

const workflowD: DraftWorkflow = {
  id: "D",
  name: "Impact Analysis — code scan & remediation",
  description:
    "Polls S3 for the CVE list, runs code indexing if needed, calls Impact Analyser, produces XLSX report, then triggers package upgrades and raises a PR.",
  status: "pending",
  progress: 0,
  jobs: [
    {
      id: "d-poll",
      name: "Poll S3 for new CVE output",
      status: "pending",
      progress: 0,
      steps: [step("d-p-1", "List bucket", "pending", 0), step("d-p-2", "Detect new object", "pending", 0)],
    },
    {
      id: "d-index",
      name: "Code index (build or reuse)",
      status: "pending",
      progress: 0,
      steps: [
        step("d-i-1", "Check existing index id", "pending", 0),
        step("d-i-2", "Clone repo @ branch", "pending", 0),
        step("d-i-3", "Build index", "pending", 0),
      ],
    },
    {
      id: "d-impact",
      name: "Impact Analyser",
      status: "pending",
      progress: 0,
      steps: [
        step("d-a-1", "Call analyser API", "pending", 0),
        step("d-a-2", "Run author model", "pending", 0),
        step("d-a-3", "Run verifier model", "pending", 0),
      ],
    },
    {
      id: "d-report",
      name: "Report + downstream triggers",
      status: "pending",
      progress: 0,
      steps: [
        step("d-r-1", "Generate XLSX report", "pending", 0),
        step("d-r-2", "Store in Jenkins workspace", "pending", 0),
        step("d-r-3", "Trigger Workflow E (upgrade)", "pending", 0),
        step("d-r-4", "Raise PR for code changes", "pending", 0),
      ],
    },
  ],
};

export const currentRun: Run = {
  id: "run-4821",
  triggeredBy: "skondreddy",
  trigger: "manual",
  branch: "bugfix/jammy-cve-sweep",
  startedAt: iso(-45),
  status: "running",
  workflows: [workflowE, workflowB, workflowD].map(attachWorkflowId),
  artifacts: [
    {
      id: "a-1",
      kind: "sbom",
      name: "nios-9.0.4.sbom.json",
      size: "1.2 MB",
      producedBy: "Workflow B / extract",
      createdAt: iso(-5),
    },
  ],
  pr: undefined,
};

export const recentRuns: Run[] = [
  currentRun,
  {
    id: "run-4820",
    triggeredBy: "scheduler",
    trigger: "scheduled",
    branch: "bugfix/jammy-weekly",
    startedAt: iso(-60 * 26),
    finishedAt: iso(-60 * 24),
    status: "success",
    workflows: [
      attachWorkflowId({ ...workflowE, status: "success", progress: 100 }),
      attachWorkflowId({ ...workflowB, status: "success", progress: 100 }),
      attachWorkflowId({ ...workflowD, status: "success", progress: 100 }),
    ],
    artifacts: [],
    pr: {
      id: "pr-1",
      number: 1342,
      title: "Bump openssl, libxml2 per CVE sweep",
      repo: "infoblox/nios",
      branch: "bugfix/jammy-weekly",
      author: "ci-bot",
      state: "open",
      url: "#",
      createdAt: iso(-60 * 24),
    },
  },
  {
    id: "run-4819",
    triggeredBy: "akumar",
    trigger: "manual",
    branch: "bugfix/sec-patch-22",
    startedAt: iso(-60 * 50),
    finishedAt: iso(-60 * 48),
    status: "failed",
    workflows: [
      attachWorkflowId({ ...workflowE, status: "success", progress: 100 }),
      attachWorkflowId({ ...workflowB, status: "failed", progress: 45 }),
      attachWorkflowId({ ...workflowD, status: "skipped", progress: 0 }),
    ],
    artifacts: [],
  },
];
