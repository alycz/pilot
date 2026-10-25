import {
  createFileAgentCoreIdentityApprovalJournal,
  createMountedFileAgentCoreSecretProvider,
  runAgentCoreIdentityLiveAcceptance,
  serializeAgentCoreIdentityLiveAcceptanceReport,
} from "../src/index";

const args = process.argv.slice(2);
const liveRequested = args.length === 1 && args[0] === "--live";
const secretProvider = liveRequested
  ? createMountedFileAgentCoreSecretProvider({
      root: process.env.AGENTCORE_RUNTIME_OAUTH_SECRET_MOUNT_ROOT?.trim() || "/run/secrets/pilot",
    })
  : undefined;
const approvalJournal = liveRequested && process.env.AGENTCORE_IDENTITY_ACCEPTANCE_STATE_ROOT
  ? createFileAgentCoreIdentityApprovalJournal({
      root: process.env.AGENTCORE_IDENTITY_ACCEPTANCE_STATE_ROOT,
    })
  : undefined;

try {
  const report = await runAgentCoreIdentityLiveAcceptance({
    args,
    ...(secretProvider ? { secretProvider } : {}),
    ...(approvalJournal ? { approvalJournal } : {}),
  });
  process.stdout.write(`${serializeAgentCoreIdentityLiveAcceptanceReport(report)}\n`);
} catch {
  process.stderr.write('{"schemaVersion":1,"mode":"live","scenario":{"id":"bounded-public-market-read","status":"FAIL"}}\n');
  process.exitCode = 1;
}
