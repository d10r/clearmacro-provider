import { writeResult, waitForReady } from "./common.js";

async function main() {
  const startedAt = new Date().toISOString();
  await waitForReady();
  await writeResult("wait-ready.json", {
    startedAt,
    finishedAt: new Date().toISOString(),
    status: "ready",
  });
  console.log("Relayer readiness checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
