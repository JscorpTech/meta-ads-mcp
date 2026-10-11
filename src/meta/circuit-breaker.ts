import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../utils/logger.js";
import type { RequestContext } from "./rate-limiter.js";
import type { MetaErrorClassification } from "./errors.js";

/**
 * When to open a circuit:
 *   - Abuse signal (subcode 1996) → 60 min mandatory cool-down.
 *   - Any throttled error that carries a `retryAfterMs` → honor that.
 *   - ≥3 throttled errors (platform/BUC/global) in the same bucket within 5 min
 *     → 15 min local cool-down.
 *   - Data-per-call limit does NOT open a circuit — the query is wrong, not
 *     the rate. We still record it so the operator sees it.
 *
 * The client MUST guard every request via `assertClosed` before fetching.
 * This is what turns Meta's "stop calling" rule into hard code.
 */
export type CircuitReason =
  | "abuse_signal"
  | "retry_after_hint"
  | "repeated_throttle"
  | "temporary_block";

export interface CircuitState {
  key: string;
  openUntil: number;
  reason: CircuitReason;
  lastError?: string;
  tripCount: number;
}

export interface CircuitContext extends RequestContext {
  type?: string;
}

const REPEATED_THROTTLE_WINDOW_MS = 5 * 60 * 1000;
const REPEATED_THROTTLE_THRESHOLD = 3;
const REPEATED_THROTTLE_COOLDOWN_MS = 15 * 60 * 1000;
const ABUSE_SIGNAL_COOLDOWN_MS = 60 * 60 * 1000;
const TEMPORARY_BLOCK_COOLDOWN_MS = 30 * 60 * 1000;

interface ThrottleEvent {
  at: number;
}

export class CircuitBreaker {
  private readonly circuits = new Map<string, CircuitState>();
  private readonly throttleEvents = new Map<string, ThrottleEvent[]>();

  /**
   * Throw if the circuit for this context is currently open.
   * Called BEFORE each fetch.
   */
  assertClosed(context: CircuitContext): void {
    const now = Date.now();
    for (const circuit of this.relevantCircuits(context)) {
      if (circuit.openUntil > now) {
        const remainingSec = Math.ceil((circuit.openUntil - now) / 1000);
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Circuit open for ${circuit.key} — ${remainingSec}s remaining (${circuit.reason}). Halting calls to avoid further throttle/suspension.`,
        );
      }
    }
    // Sweep stale circuits so snapshots stay clean.
    for (const [k, c] of this.circuits) {
      if (c.openUntil <= now) this.circuits.delete(k);
    }
  }

  /** Whether a request in this context would be refused now. Reads only. */
  isOpen(context: CircuitContext): boolean {
    const now = Date.now();
    for (const circuit of this.relevantCircuits(context)) {
      if (circuit.openUntil > now) return true;
    }
    return false;
  }

  /**
   * Record a throttle outcome and decide whether to open the circuit.
   */
  trip(
    context: CircuitContext,
    classification: MetaErrorClassification,
  ): void {
    const now = Date.now();
    const key = circuitKey(context);

    if (classification.category === "abuse_signal") {
      this.openCircuit(key, {
        key,
        openUntil: now + ABUSE_SIGNAL_COOLDOWN_MS,
        reason: "abuse_signal",
        lastError: classification.mcpError.message,
        tripCount: (this.circuits.get(key)?.tripCount ?? 0) + 1,
      });
      return;
    }

    if (classification.category === "temporary_block") {
      const until =
        now + (classification.retryAfterMs ?? TEMPORARY_BLOCK_COOLDOWN_MS);
      this.openCircuit(key, {
        key,
        openUntil: until,
        reason: "temporary_block",
        lastError: classification.mcpError.message,
        tripCount: (this.circuits.get(key)?.tripCount ?? 0) + 1,
      });
      return;
    }

    if (!classification.throttled) return;

    if (classification.retryAfterMs && classification.retryAfterMs > 0) {
      this.openCircuit(key, {
        key,
        openUntil: now + classification.retryAfterMs,
        reason: "retry_after_hint",
        lastError: classification.mcpError.message,
        tripCount: (this.circuits.get(key)?.tripCount ?? 0) + 1,
      });
      return;
    }

    // Otherwise, count throttle events and open if over threshold.
    const events = this.throttleEvents.get(key) ?? [];
    const recent = events.filter(
      (e) => now - e.at < REPEATED_THROTTLE_WINDOW_MS,
    );
    recent.push({ at: now });
    this.throttleEvents.set(key, recent);

    if (recent.length >= REPEATED_THROTTLE_THRESHOLD) {
      this.openCircuit(key, {
        key,
        openUntil: now + REPEATED_THROTTLE_COOLDOWN_MS,
        reason: "repeated_throttle",
        lastError: classification.mcpError.message,
        tripCount: (this.circuits.get(key)?.tripCount ?? 0) + 1,
      });
      this.throttleEvents.delete(key);
    }
  }

  /** For observability. */
  snapshot(): CircuitState[] {
    const now = Date.now();
    return Array.from(this.circuits.values())
      .filter((c) => c.openUntil > now)
      .map((c) => ({ ...c }));
  }

  /** Test helper. */
  reset(): void {
    this.circuits.clear();
    this.throttleEvents.clear();
  }

  private openCircuit(key: string, state: CircuitState): void {
    const prev = this.circuits.get(key);
    // Never shrink an existing cool-down.
    if (prev && prev.openUntil > state.openUntil) return;
    this.circuits.set(key, state);
    logger.error(
      {
        event: "meta_circuit_open",
        key,
        reason: state.reason,
        openUntil: state.openUntil,
        tripCount: state.tripCount,
      },
      `Circuit opened: ${state.reason}`,
    );
  }

  private *relevantCircuits(context: CircuitContext): Iterable<CircuitState> {
    // A circuit opened on (token, account, type) blocks all requests for that
    // triple. We also honor broader circuits keyed on just (token) — used by
    // abuse signals that should pause the entire token.
    for (const circuit of this.circuits.values()) {
      if (!circuit.key.startsWith(context.tokenHash)) continue;
      const parts = circuit.key.split(":");
      // token only
      if (parts.length === 1) {
        yield circuit;
        continue;
      }
      // token:account
      if (parts.length === 2) {
        if (parts[1] === (context.accountId ?? "_")) yield circuit;
        continue;
      }
      // token:account:type
      if (parts.length === 3) {
        const matchAccount = parts[1] === (context.accountId ?? "_");
        const matchType = parts[2] === (context.type ?? "_");
        if (matchAccount && matchType) yield circuit;
      }
    }
  }
}

function circuitKey(context: CircuitContext): string {
  return [
    context.tokenHash,
    context.accountId ?? "_",
    context.type ?? "_",
  ].join(":");
}
