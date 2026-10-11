// Meta sends and expects budgets and bids as integers in a unit it defines per
// currency through an "offset": 100 means hundredths of the currency, 1 means
// whole units. The offset is Meta's own and differs from ISO 4217, which gives
// COP, CRC, HUF, IDR and TWD two decimals and BHD and JOD three.
//
// Source: https://developers.facebook.com/docs/marketing-api/currencies
// (page dated Jun 30, 2026; read on 2026-10-11). All 66 rows are here.
const WHOLE_UNIT_CODES = ["CLP", "COP", "CRC", "HUF", "ISK", "IDR", "JPY", "KRW", "PYG", "TWD", "VND"];

const HUNDREDTHS_CODES = [
  "DZD", "ARS", "AUD", "BHD", "BDT", "BOB", "BGN", "BRL", "GBP", "CAD", "CNY",
  "HRK", "CZK", "DKK", "EGP", "EUR", "GTQ", "HNL", "HKD", "INR", "ILS", "JOD",
  "KES", "LVL", "LTL", "MOP", "MYR", "MXN", "NZD", "NIO", "NGN", "NOK", "PKR",
  "PEN", "PHP", "PLN", "QAR", "RON", "RUB", "SAR", "RSD", "SGD", "SKK", "ZAR",
  "SEK", "CHF", "THB", "TRY", "AED", "UAH", "USD", "UYU", "VEF", "FBZ", "VES",
];

const OFFSETS = new Map<string, number>([
  ...WHOLE_UNIT_CODES.map((code): [string, number] => [code, 1]),
  ...HUNDREDTHS_CODES.map((code): [string, number] => [code, 100]),
]);

export const SUPPORTED_CURRENCY_CODES: readonly string[] = [...OFFSETS.keys()];

/** The one sentence tool descriptions use for the unit of a budget or a bid. */
export const MINOR_UNIT_NOTE =
  "in the account currency's minor unit as Meta defines it: hundredths for most currencies (USD 5000 = $50.00), whole units for COP, CLP, PYG, CRC, JPY and others (COP 50000 = 50,000 pesos). Check the account currency first (ads_get_account_info)";

const GROUPED = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function normalizeCode(code: unknown): string | undefined {
  if (typeof code !== "string" || !/^[A-Za-z]{3}$/.test(code)) return undefined;
  return code.toUpperCase();
}

export function currencyOffset(code: string): number | undefined {
  const normalized = normalizeCode(code);
  return normalized === undefined ? undefined : OFFSETS.get(normalized);
}

/**
 * What an amount sent to or returned by Meta is worth, e.g. "USD 50.00" for
 * 5000 and "COP 50,000" for 50000. Undefined when the currency is not in
 * Meta's table or the amount is not a whole non-negative number: a guessed
 * conversion is worse than none.
 */
export function describeMinorAmount(amount: number, currency: string): string | undefined {
  const code = normalizeCode(currency);
  const offset = code === undefined ? undefined : OFFSETS.get(code);
  if (offset === undefined || !Number.isSafeInteger(amount) || amount < 0 || Object.is(amount, -0)) return undefined;
  if (offset === 1) return `${code} ${GROUPED.format(amount)}`;
  return `${code} ${GROUPED.format(Math.trunc(amount / offset))}.${String(amount % offset).padStart(2, "0")}`;
}

/**
 * An amount read from Meta (a budget, a bid, or an ad account's amount_spent,
 * balance or spend_cap) as display text. Without a currency, or with one that
 * is not in Meta's table, the raw number is shown with its unit named: it is
 * never divided on a guess. Not for insights figures such as spend or cpc,
 * which Meta already returns in whole currency.
 */
export function formatMinorAmount(amount: unknown, currency: string | undefined): string {
  const value = typeof amount === "string" && /^-?\d+(\.\d+)?$/.test(amount) ? Number(amount) : amount;
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  const raw = typeof amount === "string" ? amount : String(value);
  const code = normalizeCode(currency);
  if (code === undefined) return `${raw} (in the account currency's minor unit)`;
  const described = describeMinorAmount(Math.abs(value), code);
  if (described === undefined) return `${raw} (in the minor unit of ${code})`;
  return value < 0 ? described.replace(`${code} `, `${code} -`) : described;
}

/** One line of a tool result stating an amount, with the raw value when it cannot be converted. */
export function amountLine(label: string, amount: number, currency: string | undefined): string {
  const code = normalizeCode(currency);
  if (code === undefined) {
    return `${label}: ${amount} in the account currency's minor unit (currency not confirmed; check ads_get_account_info)`;
  }
  const described = describeMinorAmount(amount, code);
  return described === undefined
    ? `${label}: ${amount} in the minor unit of ${code} (account currency ${code})`
    : `${label}: ${described} (account currency ${code})`;
}
