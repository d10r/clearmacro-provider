import { spawn } from "node:child_process";
import {
  getTransaction,
  pollUntilTerminal,
  sendAnvilTransferFromRelayerTargetAddress,
  sleep,
  waitForReady,
  writeResult,
} from "./common.js";

function run(command: string, args: string[]) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
    });
  });
}

async function main() {
  const count = Number(process.env.RESTART_TX_COUNT ?? "6");
  const submittedIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const tx = await sendAnvilTransferFromRelayerTargetAddress();
    submittedIds.push(tx.id);
  }

  await run("docker", ["compose", "-f", "spikes/oz-relayer/compose.yaml", "restart", "relayer"]);
  await waitForReady();

  const afterRestart: Array<Record<string, unknown>> = [];
  for (const id of submittedIds) {
    let attempts = 0;
    let captured = false;
    while (attempts < 5) {
      try {
        afterRestart.push({ id, transaction: await getTransaction(id) });
        captured = true;
        break;
      } catch (error) {
        attempts += 1;
        if (attempts >= 5) {
          afterRestart.push({ id, error: String(error) });
        }
        await sleep(500);
      }
    }
    if (!captured && attempts === 0) {
      afterRestart.push({ id, error: "unknown retrieval failure" });
    }
  }

  let final: Record<string, unknown>;
  try {
    final = await pollUntilTerminal(submittedIds, { timeoutMs: 180_000, pollMs: 1_000 });
  } catch (error) {
    final = { error: String(error) };
  }

  await writeResult("scenario3-restart-recovery.json", {
    submittedIds,
    afterRestart,
    final,
  });
  console.log(`Restart recovery complete for ${submittedIds.length} txs.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
