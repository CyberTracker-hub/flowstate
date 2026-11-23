/**
 * REAL DexScreener responses, captured on 2026-11-23 from
 *   GET https://api.dexscreener.com/token-pairs/v1/solana/6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN
 * (the four deepest pools; `info` trimmed to `imageUrl`). Used only by tests,
 * to keep the adapter honest about the actual response shape. Note the second
 * pool: idle, no `volume.m5`, empty `priceChange`, and a stale price.
 */
export const TRUMP_MINT = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";

const IMAGE =
  "https://cdn.dexscreener.com/cms/images/85a2613c51c8ded8e51b1b3910487ab66691cb60fecec7d0905481a603bba899?width=800&height=800&quality=95&format=auto";
const BASE = { address: TRUMP_MINT, name: "OFFICIAL TRUMP", symbol: "TRUMP" };
const USDC = { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", name: "USD Coin", symbol: "USDC" };

export const TRUMP_POOLS: unknown[] = [
  {
    chainId: "solana",
    dexId: "meteora",
    url: "https://dexscreener.com/solana/3c5ye97hadpdxzehyq9cis8axr9anyrusczkze1ndbw9",
    pairAddress: "3C5YE97HADPDxZehYq9Cis8AXr9aNyrUsczKzE1nDbW9",
    labels: ["DLMM"],
    baseToken: BASE,
    quoteToken: USDC,
    priceNative: "0.8897",
    priceUsd: "0.8897",
    txns: { m5: { buys: 17, sells: 7 }, h1: { buys: 115, sells: 118 }, h6: { buys: 1448, sells: 1506 }, h24: { buys: 4344, sells: 8183 } },
    volume: { h24: 2029999.58, h6: 1170175.42, h1: 70183.73, m5: 8252.35 },
    priceChange: { m5: 0.51, h1: -1.48, h6: -0.39, h24: -0.49 },
    liquidity: { base: 2965421, quote: 1212314, usd: 3850658.49 },
    fdv: 889702428,
    marketCap: 250778694,
    pairCreatedAt: 1737191463000,
    info: { imageUrl: IMAGE },
  },
  {
    chainId: "solana",
    dexId: "meteora",
    url: "https://dexscreener.com/solana/9d9mb8kooffad3sctgztkxqypkshx6ezhbkio89ixyy2",
    pairAddress: "9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2",
    labels: ["DLMM"],
    baseToken: BASE,
    quoteToken: USDC,
    priceNative: "0.9989",
    priceUsd: "0.9989",
    txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 }, h6: { buys: 1, sells: 2 }, h24: { buys: 4, sells: 11 } },
    volume: { h24: 149.2, h6: 74.95 },
    priceChange: {},
    liquidity: { base: 3597353, quote: 12452, usd: 3606066.87 },
    fdv: 998959988,
    marketCap: 281574910,
    pairCreatedAt: 1737196771000,
    info: { imageUrl: IMAGE },
  },
  {
    chainId: "solana",
    dexId: "orca",
    url: "https://dexscreener.com/solana/5wrgxzwiz93g4l5xbmr3ggmybw5gfl7drnakoqmgpdhc",
    pairAddress: "5WrgXzWiz93g4L5XBmr3ggMybW5gfL7drNAKoQMgpDHc",
    labels: ["wp"],
    baseToken: BASE,
    quoteToken: USDC,
    priceNative: "0.8900",
    priceUsd: "0.8900",
    txns: { m5: { buys: 23, sells: 8 }, h1: { buys: 70, sells: 109 }, h6: { buys: 874, sells: 972 }, h24: { buys: 1611, sells: 1772 } },
    volume: { h24: 116352.96, h6: 75618.41, h1: 5731.46, m5: 823.87 },
    priceChange: { m5: 0.28, h1: -1.5, h6: -0.3, h24: -0.12 },
    liquidity: { base: 349080, quote: 311711, usd: 622408.93 },
    fdv: 890045473,
    marketCap: 250875388,
    pairCreatedAt: 1754499167000,
    info: { imageUrl: IMAGE },
  },
  {
    chainId: "solana",
    dexId: "raydium",
    url: "https://dexscreener.com/solana/crotddum3njgbuvb7vr9rhmrxnsswmjntlc1anjhwsdq",
    pairAddress: "CRoTdDUM3NJGbuvB7Vr9rhmRxnSswMjnTLC1ANjhwsdq",
    labels: ["CLMM"],
    baseToken: BASE,
    quoteToken: USDC,
    priceNative: "0.8899",
    priceUsd: "0.8899",
    txns: { m5: { buys: 21, sells: 8 }, h1: { buys: 106, sells: 133 }, h6: { buys: 1605, sells: 1642 }, h24: { buys: 3157, sells: 3180 } },
    volume: { h24: 222788.27, h6: 138567.96, h1: 8250.23, m5: 1340.05 },
    priceChange: { m5: 0.45, h1: -1.42, h6: -0.4, h24: -0.27 },
    liquidity: { base: 348892, quote: 310577, usd: 621079.84 },
    fdv: 889963452,
    marketCap: 250852268,
    pairCreatedAt: 1737417722000,
    info: { imageUrl: IMAGE },
  },
];
