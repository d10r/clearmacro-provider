import { createPublicClient, http, type PublicClient } from "viem";

type RpcEntry = { name: string; url: string };

export function createChainClients(rpcs: RpcEntry[]): PublicClient[] {
  return rpcs.map((rpc) =>
    createPublicClient({
      transport: http(rpc.url),
    }),
  );
}

