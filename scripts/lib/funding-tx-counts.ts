import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { countFlowUpdatedEventsSince, protocolSubgraphUrl } from "./sf-subgraph.js";

export type ActivitySource = "subgraph" | "database" | "override" | "flat" | "fallback";

export type ChainActivity = {
  chainId: number;
  flowEvents30d: number;
  relayExecutions30d: number;
  activityScore: number;
  fundingTxCount: number;
  source: ActivitySource;
  note?: string;
};

export type FundingTxCountOptions = {
  chainIds: number[];
  activityDays: number;
  baseTxCount: number;
  minTxCount: number;
  maxTxCount: number;
  flatTxCount?: number;
  databasePath?: string;
  perChainOverride: (chainId: number) => number | undefined;
};

function medianPositive(values: number[]): number {
  const positive = values.filter((v) => v > 0);
  if (positive.length === 0) return 1;
  const sorted = [...positive].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function computeFundingTxCountsFromActivity(
  activityByChainId: Map<number, number>,
  opts: Pick<FundingTxCountOptions, "baseTxCount" | "minTxCount" | "maxTxCount">,
): Map<number, number> {
  const median = medianPositive([...activityByChainId.values()]);
  const out = new Map<number, number>();
  for (const [chainId, activity] of activityByChainId) {
    const scaled =
      activity > 0 ? Math.round((opts.baseTxCount * activity) / median) : opts.minTxCount;
    out.set(chainId, Math.min(opts.maxTxCount, Math.max(opts.minTxCount, scaled)));
  }
  return out;
}

function countRelaysSince(dbPath: string, sinceIso: string): Map<number, number> {
  const counts = new Map<number, number>();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT chain_id AS chainId, COUNT(*) AS n
         FROM relay_executions
         WHERE created_at >= ?
         GROUP BY chain_id`,
      )
      .all(sinceIso) as { chainId: number; n: number }[];
    for (const row of rows) {
      counts.set(Number(row.chainId), Number(row.n));
    }
  } finally {
    db.close();
  }
  return counts;
}

export async function resolveChainFundingPlan(opts: FundingTxCountOptions): Promise<ChainActivity[]> {
  const sinceMs = Date.now() - opts.activityDays * 24 * 60 * 60 * 1000;
  const sinceTimestamp = Math.floor(sinceMs / 1000);
  const sinceIso = new Date(sinceMs).toISOString();

  const relayCounts =
    opts.databasePath && existsSync(opts.databasePath) ? countRelaysSince(opts.databasePath, sinceIso) : new Map();

  const subgraphCounts = new Map<number, { count: number; capped: boolean }>();
  await Promise.all(
    opts.chainIds.map(async (chainId) => {
      const endpoint = protocolSubgraphUrl(chainId);
      if (!endpoint) return;
      try {
        subgraphCounts.set(chainId, await countFlowUpdatedEventsSince(endpoint, sinceTimestamp));
      } catch {
        // Omitted; fallback handled below.
      }
    }),
  );

  const activityByChainId = new Map<number, number>();
  for (const chainId of opts.chainIds) {
    if (opts.perChainOverride(chainId) !== undefined) continue;
    if (opts.flatTxCount !== undefined) continue;
    const db = relayCounts.get(chainId) ?? 0;
    const sg = subgraphCounts.get(chainId)?.count ?? 0;
    activityByChainId.set(chainId, db > 0 ? db : sg);
  }

  const fundingCounts = computeFundingTxCountsFromActivity(activityByChainId, opts);

  return opts.chainIds.map((chainId) => {
    const override = opts.perChainOverride(chainId);
    const flat = opts.flatTxCount;
    const relayExecutions30d = relayCounts.get(chainId) ?? 0;
    const sg = subgraphCounts.get(chainId);
    const flowEvents30d = sg?.count ?? 0;
    const activityScore = relayExecutions30d > 0 ? relayExecutions30d : flowEvents30d;
    const fundingTxCount =
      override ?? flat ?? fundingCounts.get(chainId) ?? opts.minTxCount;

    let source: ActivitySource = "fallback";
    let note: string | undefined;
    if (override !== undefined) {
      source = "override";
    } else if (flat !== undefined) {
      source = "flat";
    } else if (relayExecutions30d > 0) {
      source = "database";
    } else if (sg !== undefined) {
      source = "subgraph";
      if (sg.capped) note = `subgraph count capped at ${sg.count}`;
    } else {
      note = "no subgraph or DB activity; using min tx count";
    }

    const row: ChainActivity = {
      chainId,
      flowEvents30d,
      relayExecutions30d,
      activityScore,
      fundingTxCount,
      source,
    };
    if (note !== undefined) row.note = note;
    return row;
  });
}
