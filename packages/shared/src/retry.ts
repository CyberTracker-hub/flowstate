/**
 * Retry with exponential backoff + jitter, and a small circuit breaker.
 * Clock, sleep and randomness are injectable so behaviour is testable.
 */

export type FailureKind =
  | "rate_limited"
  | "timeout"
  | "network"
  | "server"
  | "auth"
  | "client"
  | "invalid_response"
  | "circuit_open";

export class ProviderError extends Error {
  readonly provider: string;
  readonly kind: FailureKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(
    provider: string,
    kind: FailureKind,
    message: string,
    opts: { status?: number | null; retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.kind = kind;
    this.status = opts.status ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

const RETRYABLE: ReadonlySet<FailureKind> = new Set(["rate_limited", "timeout", "network", "server"]);

export function isRetryable(err: unknown): boolean {
  return err instanceof ProviderError && RETRYABLE.has(err.kind);
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  factor: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 30_000, factor: 2 };

/**
 * "Full jitter" backoff: a uniformly random delay in
 * [0, min(maxMs, baseMs * factor^(attempt-1))]. `attempt` starts at 1.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions = DEFAULT_BACKOFF, rng: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const ceiling = Math.min(opts.maxMs, opts.baseMs * Math.pow(opts.factor, n - 1));
  const r = Math.min(1, Math.max(0, rng()));
  return Math.floor(r * ceiling);
}

/** Parse an HTTP Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

export interface RetryOptions {
  maxAttempts: number;
  backoff?: BackoffOptions;
  /** Upper bound for honouring a server-provided Retry-After. */
  maxRetryAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying only failures classified as transient. Non-retryable
 * errors (auth, client, invalid response, open circuit) are rethrown at once.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? 60_000;
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts));
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryable(error)) throw error;
      let delayMs = backoffDelay(attempt, backoff, opts.rng);
      if (error instanceof ProviderError && error.retryAfterMs !== null) {
        delayMs = Math.min(maxRetryAfterMs, Math.max(delayMs, error.retryAfterMs));
      }
      opts.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before one trial request is allowed. */
  openMs: number;
  now?: () => number;
}

/**
 * Stops hammering a provider that is clearly down. After `openMs` a single
 * trial request is let through (half-open); success closes the circuit,
 * failure opens it again.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;
  private readonly opts: Required<CircuitBreakerOptions>;

  constructor(opts: CircuitBreakerOptions) {
    this.opts = { now: Date.now, ...opts };
  }

  get state(): CircuitState {
    if (this.openedAt === null) return "closed";
    return this.opts.now() - this.openedAt >= this.opts.openMs ? "half_open" : "open";
  }

  /** Call before each request. Returns false when the request must be skipped. */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === "closed") return true;
    if (state === "open") return false;
    if (this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }

  recordFailure(): void {
    this.trialInFlight = false;
    if (this.openedAt !== null) {
      // Failed trial: restart the open period.
      this.openedAt = this.opts.now();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.opts.failureThreshold) this.openedAt = this.opts.now();
  }
}
