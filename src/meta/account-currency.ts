import { getAccessTokenHash } from "../auth/token-store.js";
import { withDeadline } from "../utils/with-deadline.js";
import { metaApiClient } from "./client.js";
import { amountLine } from "./currency.js";

// The lookup only decorates the result of a write that already happened, so
// it must not hold that result back: a client that times out waiting would
// repeat the write.
const LOOKUP_DEADLINE_MS = 2000;
const MAX_ENTRIES = 2000;

// An account's currency and an object's account never change, so entries do
// not expire. Keys carry the token hash: one tenant's read never answers
// another's.
const remembered = new Map<string, string>();
const inFlight = new Map<string, Promise<string | undefined>>();

function remember(key: string, value: string): void {
  if (!remembered.has(key) && remembered.size >= MAX_ENTRIES) {
    const oldest = remembered.keys().next().value;
    if (oldest !== undefined) remembered.delete(oldest);
  }
  remembered.set(key, value);
}

async function readOnce(
  key: string,
  path: string,
  field: string,
  accept: RegExp,
): Promise<string | undefined> {
  const known = remembered.get(key);
  if (known !== undefined) return known;

  let pending = inFlight.get(key);
  if (!pending) {
    pending = metaApiClient
      .get<Record<string, unknown>>(path, { fields: field })
      .then((response) => {
        const value = response?.[field];
        if (typeof value !== "string" || !accept.test(value)) return undefined;
        remember(key, value);
        return value;
      })
      .catch(() => undefined)
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

async function readAccountCurrency(tokenHash: string, accountId: string): Promise<string | undefined> {
  const match = /^(?:act_)?(\d{1,30})$/.exec(accountId);
  if (!match) return undefined;
  const account = `act_${match[1]}`;
  const currency = await readOnce(`${tokenHash}:currency:${account}`, `/${account}`, "currency", /^[A-Za-z]{3}$/);
  return currency?.toUpperCase();
}

async function bounded(lookup: (tokenHash: string) => Promise<string | undefined>): Promise<string | undefined> {
  try {
    const result = await withDeadline(lookup(getAccessTokenHash()), LOOKUP_DEADLINE_MS);
    return result.settled ? result.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The currency of an ad account, read once per token and account and then
 * answered from memory. Resolves to undefined, and never rejects, when Meta
 * does not answer within two seconds or the read fails: callers use it to
 * word a result, not to decide anything.
 */
export function accountCurrency(accountId: string): Promise<string | undefined> {
  return bounded((tokenHash) => readAccountCurrency(tokenHash, accountId));
}

/** Same, starting from a campaign, ad set or ad id: its account is read first. */
export function entityAccountCurrency(entityId: string): Promise<string | undefined> {
  return bounded(async (tokenHash) => {
    if (!/^\d{1,30}$/.test(entityId)) return undefined;
    const accountId = await readOnce(`${tokenHash}:account:${entityId}`, `/${entityId}`, "account_id", /^\d{1,30}$/);
    return accountId === undefined ? undefined : readAccountCurrency(tokenHash, accountId);
  });
}

const AMOUNT_LABELS = {
  daily_budget: "Daily budget",
  lifetime_budget: "Lifetime budget",
  bid_amount: "Bid amount",
} as const;

/**
 * Lines for the result of a write, one per amount it carried, each starting
 * with a line break: "\nDaily budget: COP 50,000 (account currency COP)".
 * Empty, and without any request, when the write carried no amount. A value
 * that is neither a number nor a string of digits is left out.
 */
export async function statedAmounts(
  amounts: Partial<Record<keyof typeof AMOUNT_LABELS, unknown>>,
  owner: { accountId: string } | { entityId: string },
): Promise<string> {
  const given: Array<[string, number]> = [];
  for (const [field, label] of Object.entries(AMOUNT_LABELS)) {
    const raw = amounts[field as keyof typeof AMOUNT_LABELS];
    const amount = typeof raw === "string" && /^\d{1,15}$/.test(raw) ? Number(raw) : raw;
    if (typeof amount === "number" && Number.isFinite(amount)) given.push([label, amount]);
  }
  if (given.length === 0) return "";

  const currency = "accountId" in owner
    ? await accountCurrency(owner.accountId)
    : await entityAccountCurrency(owner.entityId);
  return given.map(([label, amount]) => `\n${amountLine(label, amount, currency)}`).join("");
}

export function resetAccountCurrencyCacheForTests(): void {
  remembered.clear();
  inFlight.clear();
}
