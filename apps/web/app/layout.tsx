import "@fontsource-variable/archivo/wdth.css";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { OverviewProvider } from "@/components/overview";
import { Shell } from "@/components/shell";

export const metadata: Metadata = {
  title: { default: "FLOWSTATE — unusual flow on Solana, measured every five minutes", template: "%s — FLOWSTATE" },
  description:
    "FLOWSTATE compares each Solana token's last five minutes of trading with its own recent history and scores how unusual it is. Free, no account. It measures; it does not predict.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef2f1" },
    { media: "(prefers-color-scheme: dark)", color: "#0a141b" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <OverviewProvider>
          <Shell>{children}</Shell>
        </OverviewProvider>
      </body>
    </html>
  );
}
