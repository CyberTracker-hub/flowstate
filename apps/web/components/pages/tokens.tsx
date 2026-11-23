"use client";

import { useOverview } from "../overview";
import { TokenTable } from "../token-table";

export function TokensPage() {
  const { data } = useOverview();
  return (
    <>
      <h1 className="page-title">Monitored tokens</h1>
      <p className="lede">
        {data
          ? `${data.tokens.length} Solana tokens with deep, active pools. Figures are summed over each token's largest pools; sort by any column, or pin the ones you follow.`
          : "Solana tokens with deep, active pools."}
      </p>
      {data && <TokenTable overview={data} />}
    </>
  );
}
