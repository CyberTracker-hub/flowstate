import type { Metadata } from "next";
import { TokensPage } from "@/components/pages/tokens";

export const metadata: Metadata = { title: "Monitored tokens" };

export default function Page() {
  return <TokensPage />;
}
