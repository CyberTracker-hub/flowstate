"use client";

import type { PublicOverview } from "@flowstate/shared";
import { createContext, useContext, type ReactNode } from "react";
import { useJson, type Loaded } from "@/lib/data";

const OverviewContext = createContext<Loaded<PublicOverview>>({ data: null, error: null, loading: true });

/** One shared copy of overview.json for the whole site, refreshed every minute. */
export function OverviewProvider({ children }: { children: ReactNode }) {
  const overview = useJson<PublicOverview>("overview.json");
  return <OverviewContext.Provider value={overview}>{children}</OverviewContext.Provider>;
}

export function useOverview(): Loaded<PublicOverview> {
  return useContext(OverviewContext);
}

export const DEFAULT_BANDS = { elevated: 25, unusual: 50, high: 70, extreme: 85 };
