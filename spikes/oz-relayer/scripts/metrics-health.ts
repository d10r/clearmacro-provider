import { RELAYER_BASE_URL, RELAYER_ID, relayerFetch, writeResult } from "./common.js";

async function main() {
  const health = await relayerFetch("/api/v1/health");
  const readiness = await relayerFetch("/api/v1/ready");
  const relayer = await relayerFetch(`/api/v1/relayers/${RELAYER_ID}`);
  const metricsUrl = new URL(RELAYER_BASE_URL);
  metricsUrl.port = "8081";
  metricsUrl.pathname = "/metrics";
  const metricsResponse = await fetch(metricsUrl);
  const metricsText = await metricsResponse.text();
  const metricNames = metricsText
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/[ {]/)[0])
    .filter(Boolean)
    .slice(0, 300);

  await writeResult("scenario6-metrics-health.json", {
    health,
    readiness,
    relayer,
    metricsStatus: metricsResponse.status,
    metricSample: metricNames,
  });
  console.log(`Metrics/health captured (${metricsResponse.status}).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
