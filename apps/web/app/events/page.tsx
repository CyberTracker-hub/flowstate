import type { Metadata } from "next";
import { EventsPage } from "@/components/pages/events";

export const metadata: Metadata = { title: "Anomaly events" };

export default function Page() {
  return <EventsPage />;
}
