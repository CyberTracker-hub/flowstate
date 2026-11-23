"use client";

import { PUBLIC_SCHEMA } from "@flowstate/shared";
import { useEffect, useRef, useState } from "react";

/**
 * Where the published JSON lives. In production this is the repository's
 * data branch; locally it is ./public/data (see docs/deployment.md).
 */
const DATA_URL = (process.env.NEXT_PUBLIC_DATA_URL ?? `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/data`).replace(/\/+$/, "");

export type LoadError = "not_found" | "network" | "invalid" | "outdated_site";

export interface Loaded<T> {
  data: T | null;
  error: LoadError | null;
  /** True until the first attempt finished. */
  loading: boolean;
}

async function fetchJson<T>(path: string, signal: AbortSignal): Promise<T> {
  // A per-minute cache key: fresh enough for 5-minute data, kind to the CDN.
  const res = await fetch(`${DATA_URL}/${path}?v=${Math.floor(Date.now() / 60_000)}`, { signal, cache: "no-store" });
  if (res.status === 404) throw new Error("not_found");
  if (!res.ok) throw new Error("network");
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("invalid");
  }
  if (typeof body !== "object" || body === null) throw new Error("invalid");
  if ((body as { schema?: unknown }).schema !== PUBLIC_SCHEMA) throw new Error("outdated_site");
  return body as T;
}

function toLoadError(error: unknown): LoadError {
  const message = error instanceof Error ? error.message : "";
  return message === "not_found" || message === "invalid" || message === "outdated_site" ? message : "network";
}

/**
 * Load a published JSON file and keep it fresh. While a refresh is in
 * flight (or fails) the previous data stays on screen.
 */
export function useJson<T>(path: string | null, refreshMs = 60_000): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ data: null, error: null, loading: path !== null });
  const current = useRef<string | null>(null);

  useEffect(() => {
    if (path === null) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    if (current.current !== path) {
      current.current = path;
      setState({ data: null, error: null, loading: true });
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const data = await fetchJson<T>(path, controller.signal);
        setState({ data, error: null, loading: false });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((previous) => ({ data: previous.data, error: toLoadError(error), loading: false }));
      }
      if (!controller.signal.aborted) timer = setTimeout(load, refreshMs);
    };
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [path, refreshMs]);

  return state;
}

/** A clock that re-renders on an interval, for "4 min ago" labels. */
export function useNow(intervalMs = 15_000): number | null {
  // null on the server render so static HTML never bakes in a build-time clock.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Width of an element, for sizing SVG charts to their container. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setWidth(Math.round(box.width));
    });
    observer.observe(el);
    setWidth(Math.round(el.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
