/**
 * What an ad account's spend_cap field says. Meta sends "0" for an account
 * without a cap, so only an explicit zero means there is none. A field it
 * left out, or one that is not a plain non-negative number, says nothing:
 * neither that there is a cap nor that there is none.
 */
export type HeldSpendCap =
  | { state: "none" }
  | {
      state: "set";
      /** The cap in the account currency's minor unit, as Meta reads it back. */
      minor: number;
    }
  | { state: "unknown" };

/** What the tools that read the cap print when the field says nothing. */
export const SPEND_CAP_NOT_REPORTED = "not reported by Meta";

export function readSpendCap(raw: unknown): HeldSpendCap {
  const value = typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return { state: "unknown" };
  if (value > 0) return { state: "set", minor: value };
  // A positive decimal too small for a double converts to 0: only a zero
  // that was written as one means there is no cap.
  return typeof raw === "string" && /[1-9]/.test(raw) ? { state: "unknown" } : { state: "none" };
}
