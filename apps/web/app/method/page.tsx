import type { Metadata } from "next";
import { MethodPage } from "@/components/pages/method";

export const metadata: Metadata = { title: "How it works" };

export default function Page() {
  return <MethodPage />;
}
