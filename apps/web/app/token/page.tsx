import type { Metadata } from "next";
import { Suspense } from "react";
import { TokenPage } from "@/components/pages/token";

export const metadata: Metadata = { title: "Token" };

export default function Page() {
  // The token is chosen by ?mint=… in the browser, so one static page serves every token.
  return (
    <Suspense fallback={<p className="empty">Loading readings…</p>}>
      <TokenPage />
    </Suspense>
  );
}
