export type Status =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "skipped";

export interface Step {
  id: string;
  name: string;
  status: Status;
  progress: number; // 0..100
  startedAt?: string;
  finishedAt?: string;
  log?: string[];
}

export interface Job {
  id: string;
  name: string;
  /** Workflow this job belongs to — used to look up the Jenkins job name. */
  workflowId: WorkflowId;
  /** Jenkins build number for the current run, if started. */
  buildNumber?: number;
  /** Optional direct console URL override; otherwise built from config. */
  jenkinsUrl?: string;
  status: Status;
  progress: number;
  startedAt?: string;
  finishedAt?: string;
  steps: Step[];
}

export type WorkflowId = "E" | "B" | "D";

export interface Workflow {
  id: WorkflowId;
  name: string;
  description: string;
  status: Status;
  progress: number;
  startedAt?: string;
  finishedAt?: string;
  jobs: Job[];
}

export interface Artifact {
  id: string;
  kind: "sbom" | "cve-list" | "report" | "index" | "other";
  name: string;
  size?: string;
  url?: string;
  producedBy: string; // workflow/job
  createdAt: string;
}

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  repo: string;
  branch: string;
  author: string;
  state: "open" | "approved" | "merged" | "changes_requested";
  url: string;
  createdAt: string;
}

export interface Run {
  id: string;
  triggeredBy: string;
  trigger: "manual" | "scheduled" | "upstream";
  branch: string;
  startedAt: string;
  finishedAt?: string;
  status: Status;
  workflows: Workflow[];
  artifacts: Artifact[];
  pr?: PullRequest;
}
