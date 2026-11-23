import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CircuitBreaker, ProviderError, backoffDelay, isRetryable, parseRetryAfter, withRetry } from "./retry";

const noSleep = async () => {};

describe("backoff", () => {
  it("grows exponentially, is capped, and jitter stays within bounds", () => {
    const opts = { baseMs: 100, maxMs: 1_000, factor: 2 };
    assert.equal(backoffDelay(1, opts, () => 1), 100);
    assert.equal(backoffDelay(2, opts, () => 1), 200);
    assert.equal(backoffDelay(3, opts, () => 1), 400);
    assert.equal(backoffDelay(10, opts, () => 1), 1_000);
    assert.equal(backoffDelay(3, opts, () => 0), 0);
    assert.equal(backoffDelay(3, opts, () => 0.5), 200);
  });

  it("parses Retry-After as seconds or as an HTTP date", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    assert.equal(parseRetryAfter("7", now), 7_000);
    assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now), 30_000);
    assert.equal(parseRetryAfter("soon", now), null);
    assert.equal(parseRetryAfter(null, now), null);
  });
});

describe("withRetry", () => {
  it("retries transient failures and returns the eventual result", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new ProviderError("birdeye", "timeout", "timed out");
        return "ok";
      },
      { maxAttempts: 5, sleep: noSleep, rng: () => 0 },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 3);
  });

  it("honours Retry-After on 429, within the configured ceiling", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new ProviderError("birdeye", "rate_limited", "429", { status: 429, retryAfterMs: 4_000 });
        if (calls === 2) throw new ProviderError("birdeye", "rate_limited", "429", { status: 429, retryAfterMs: 999_000 });
        return true;
      },
      { maxAttempts: 5, sleep: async (ms) => void delays.push(ms), rng: () => 0, maxRetryAfterMs: 10_000 },
    );
    assert.deepEqual(delays, [4_000, 10_000]);
  });

  it("gives up after maxAttempts", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new ProviderError("helius", "server", "503", { status: 503 });
        },
        { maxAttempts: 3, sleep: noSleep },
      ),
      /503/,
    );
    assert.equal(calls, 3);
  });

  it("never retries auth, client or invalid-response errors", async () => {
    for (const kind of ["auth", "client", "invalid_response", "circuit_open"] as const) {
      let calls = 0;
      await assert.rejects(
        withRetry(
          async () => {
            calls += 1;
            throw new ProviderError("birdeye", kind, kind);
          },
          { maxAttempts: 5, sleep: noSleep },
        ),
      );
      assert.equal(calls, 1, kind);
    }
    assert.equal(isRetryable(new Error("plain")), false);
  });
});

describe("CircuitBreaker", () => {
  it("opens after consecutive failures, then allows a single trial", () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 3, openMs: 1_000, now: () => now });
    assert.equal(breaker.tryAcquire(), true);
    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.state, "closed");
    breaker.recordFailure();
    assert.equal(breaker.state, "open");
    assert.equal(breaker.tryAcquire(), false);

    now = 1_000;
    assert.equal(breaker.state, "half_open");
    assert.equal(breaker.tryAcquire(), true, "one trial request is allowed");
    assert.equal(breaker.tryAcquire(), false, "but only one at a time");
    breaker.recordFailure();
    assert.equal(breaker.state, "open", "a failed trial re-opens the circuit");

    now = 2_000;
    assert.equal(breaker.tryAcquire(), true);
    breaker.recordSuccess();
    assert.equal(breaker.state, "closed");
    assert.equal(breaker.tryAcquire(), true);
  });

  it("a success resets the failure streak", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, openMs: 1_000, now: () => 0 });
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    assert.equal(breaker.state, "closed");
  });
});
