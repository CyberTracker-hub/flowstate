"use client";

import { useNow } from "@/lib/data";
import { useLiveOverview } from "../live";
import { TokenTable } from "../token-table";

export function TokensPage() {
  const now = useNow();
  const { overview: data, isLive } = useLiveOverview(now);
  return (
    <>
      <h1 className="page-title">Monitored tokens</h1>
      <p className="lede">
        {data
          ? `${data.tokens.length} Solana tokens with deep, active pools. Figures are summed over each token's largest pools${isLive ? " and refresh every 30 seconds; scores about every five minutes" : ""}. Sort by any column, or pin the ones you follow.`
          : "Solana tokens with deep, active pools."}
      </p>
      {data && <TokenTable overview={data} />}
    </>
  );
}
