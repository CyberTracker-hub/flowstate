/**
 * Structured JSON logging with defensive redaction: any field whose name
 * looks like a credential is replaced before it can reach a log sink.
 */

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

// Matches credential-like field names ("apiKey", "botToken", "authorization")
// without swallowing harmless ones such as "tokens" (a count) or "tokenMint".
const SENSITIVE_KEY =
  /(api[-_]?key|secret|password|authorization|cookie|signature|private[-_]?key|seed[-_]?phrase|(access|refresh|bot|auth|bearer|session|id|link)[-_]?token|^token$)/i;
const REDACTED = "[redacted]";

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export function createJsonLogger(
  base: LogFields = {},
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  now: () => number = Date.now,
): Logger {
  const emit = (level: string, message: string, fields: LogFields = {}) => {
    const record = { ...(redact({ ...base, ...fields }) as LogFields), level, message, time: new Date(now()).toISOString() };
    write(JSON.stringify(record));
  };
  return {
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
