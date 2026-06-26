import CICDTriggerCard from "../components/CICDTriggerCard";
import JenkinsJobCard from "../components/JenkinsJobCard";
import { config } from "../config";

const NIGHTLY_JOB_URL =
  import.meta.env.VITE_JENKINS_JOB_CICD_URL ||
  "https://jenkins-qa2.inca.infoblox.com/job/NIGHTLY_GIT_WAPI_RFE_6827_PERCY_Security";

export default function CICDPage() {
  return (
    <div className="space-y-6">
      <section>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
          End-to-End Pipeline
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          CICD Pipeline
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-muted">
          Triggers the full end-to-end NIOS CVE pipeline on QA2 Jenkins. The trigger button kicks off
          IB_QA_CI_NIOS_CVE_Analyser, which in turn launches the actual NIGHTLY_GIT_WAPI test job shown below.
        </p>
      </section>

      {/* Trigger section */}
      <CICDTriggerCard />

      {/* Live job status — show the actual NIGHTLY job, not the trigger wrapper */}
      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold">Jenkins Job Status</h2>
          <span className="text-[11px] text-ink-subtle">Live data · auto-refresh every {Math.round(config.api.pollIntervalMs / 1000)}s</span>
        </div>
        <JenkinsJobCard
          title="NIGHTLY_GIT_WAPI_RFE_6827_PERCY_Security"
          jenkinsUrl={NIGHTLY_JOB_URL}
        />
      </section>
    </div>
  );
}
