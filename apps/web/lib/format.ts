import type { Confidence, Severity } from "@flowstate/anomaly-engine";

export const SEVERITIES: readonly Severity[] = ["normal", "elevated", "unusual", "high", "extreme"];

export const SEVERITY_LABEL: Record<Severity, string> = {
  normal: "Normal",
  elevated: "Elevated",
  unusual: "Unusual",
  high: "High",
  extreme: "Extreme",
};

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  insufficient: "Insufficient data",
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** "just now", "4 min ago", "2 h 5 min ago", "3 d ago". */
export function timeAgo(then: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h ago` : `${hours} h ${minutes % 60} min ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** "45 min", "2 h 10 min". */
export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  return minutes % 60 === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function dateTime(ms: number): string {
  return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
