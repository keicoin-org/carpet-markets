/**
 * Turning numbers into text, and nothing else.
 *
 * This file used to be `curve.ts` and used to be the most important file here:
 * it held a bonding curve, and the server priced every trade with it. There is
 * no curve now. Prices come from the order book, which is to say from whatever
 * two people agreed on, which is what a price is.
 *
 * What survives is formatting, because a price that renders as `6e-8` in one
 * browser and `0.00000006` in another is a support ticket.
 */

/** Raw units per Kei. Matches `KEI_DECIMALS` in the SDK; asserted in the tests. */
export const KEI_RAW = 10n ** 18n

/**
 * Raw Kei as a decimal string, trimmed.
 *
 * Written out rather than divided into a `number`, because 10^18 does not fit
 * in a double. Only the launch fee travels as raw — it is compared against a
 * balance, and a fee that rounds up is a launch that cannot be paid for.
 */
export function formatKei(raw: bigint, places = 8): string {
  const negative = raw < 0n
  const value = negative ? -raw : raw
  const whole = value / KEI_RAW
  const fraction = (value % KEI_RAW).toString().padStart(18, '0').slice(0, places).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`
}

/** A decimal Kei string as raw. Throws on nonsense. */
export function parseKei(text: string): bigint {
  const trimmed = text.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new FormatError(`"${text}" is not an amount of Kei.`)
  const [whole = '0', fraction = ''] = trimmed.split('.')
  if (fraction.length > 18) throw new FormatError('Kei has 18 decimal places; that has more.')
  return BigInt(whole) * KEI_RAW + BigInt(fraction.padEnd(18, '0'))
}

/**
 * A Kei amount that arrived as a JS number, as raw.
 *
 * Prices cross the wire as doubles — `shared/listing.ts` says why, and says
 * that no balance is allowed to. Eighteen places is as far as one can be
 * trusted, and not quite that far: the double nearest 1.1 is a hair *above*
 * 1.1, so this answers 1.1 plus 89 attoKei rather than exactly 1.1. The drift
 * is in the eighteenth decimal place either way, which is far below anything a
 * balance is quoted in — so a total converted here cannot become affordable by
 * rounding, which is the only direction that would matter.
 */
export function rawOfKei(amount: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n
  // `toFixed` gives up and returns exponent notation at 1e21, which `parseKei`
  // rightly refuses. Nothing here trades at 10^21 Kei, but a total is a product
  // of two numbers a stranger chose, so it is not this function's place to assume.
  if (amount >= 1e21) return BigInt(Math.round(amount)) * KEI_RAW
  return parseKei(amount.toFixed(18))
}

/** `1234567` → `1,234,567`. Coins have no decimals, so there is nothing else to do. */
export function formatCoins(count: number): string {
  return Math.trunc(count).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** What somebody typed into an Amount field, once it is read as a quantity. */
export interface CoinAmount {
  /** Whole coins. Zero unless the text is an amount this can read. */
  count: number
  /** The text is not a non-negative decimal number, so there is no quantity. */
  malformed: boolean
  /** It named a fraction of a coin. Coins have none, so it was dropped. */
  truncated: boolean
}

/**
 * A typed Amount as a whole number of coins.
 *
 * The previous version of this deleted every non-digit and called the result
 * truncation, so `2.5` listed 25 coins and a bid of `100.00` locked Kei for
 * 10,000 (#16): the separator was removed and its digits promoted into the
 * integer. Nothing downstream could catch it, because by the time
 * `lib/refusals.ts` saw the number it was already the wrong one, and every
 * total on screen was arithmetically consistent with a quantity nobody typed.
 *
 * So this parses rather than coerces, and it accepts exactly what `parseKei`
 * accepts: digits, optionally one point, nothing else. `Number()` is not a
 * parser for this — it reads `1e3`, `0x10`, `Infinity`, leading signs and
 * surrounding whitespace, and answers `NaN` for everything else, which is a
 * value every caller then has to remember to check.
 *
 * Grouping separators are refused rather than stripped. Stripping them is how
 * the original bug read `2.5`, and `1,5` is one-and-a-half to half the world
 * and fifteen to the other half — a field that silently multiplies by ten
 * depending on locale is worse than one that says it did not understand.
 *
 * Truncation is reported rather than applied silently for the same reason:
 * SPEC §9.6 criterion 2 wants every state that changes a trade named on screen
 * before the click, and quietly listing 2 coins for somebody who asked for 2.5
 * is a changed trade.
 */
export function parseCoins(text: string): CoinAmount {
  const trimmed = text.trim()
  if (trimmed === '') return { count: 0, malformed: false, truncated: false }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return { count: 0, malformed: true, truncated: false }
  const [whole = '0', fraction = ''] = trimmed.split('.')
  const count = Number(whole)
  // Past 2^53 a `number` cannot hold a quantity without losing units, and a lot
  // that is off by one unit is off by one unit on somebody's own chain.
  if (!Number.isSafeInteger(count)) return { count: 0, malformed: true, truncated: false }
  return { count, malformed: false, truncated: /[1-9]/.test(fraction) }
}

/**
 * What to say on screen when an Amount field names a fraction of a coin.
 *
 * A note rather than a refusal: 2.5 is a usable quantity, it is just two coins.
 * But it has to be *said*, and said before the button, because the alternative
 * is somebody finding out from the settled block that they listed a different
 * number than they typed — which is the shape of #16 even once the arithmetic is
 * right. SPEC §9.6 criterion 2 asks for every state that changes a trade to be
 * named up front, and quietly listing 2 for somebody who asked for 2.5 is a
 * changed trade.
 *
 * Here rather than in the panel so that the sentence is asserted rather than
 * eyeballed — though since #23 the harness in `test/dom.ts` can type into the
 * field as well, and `test/screen.test.tsx` asserts this note is what a person
 * reads after pressing `2`, `.`, `5`.
 */
export function coinNote(amount: CoinAmount, symbol: string): string | null {
  if (!amount.truncated) return null
  return `${symbol} has no decimal places, so that is ${formatCoins(amount.count)} ${symbol}.`
}

/**
 * A price, at enough significant figures to tell two of them apart.
 *
 * Prices on a new coin are very small and on a pumped one are not, so a fixed
 * number of decimal places renders one of those two as `0.00000000` and the
 * other as `1234.56000000`.
 */
export function formatPrice(kei: number): string {
  if (!Number.isFinite(kei) || kei <= 0) return '0'
  if (kei >= 1) return trim(kei.toFixed(4))

  // Three significant figures, written out in full. `toPrecision` was doing the
  // significant figures and then handing back `6.00e-7` below a millionth,
  // which is the exact rendering this function exists to prevent — and it is
  // the range a coin trades in for as long as anybody is still deciding about
  // it, so the one price worth reading carefully was the one in exponent form.
  const places = Math.min(KEI_PLACES, 2 - Math.floor(Math.log10(kei)))
  return trim(kei.toFixed(places))
}

/** Kei has eighteen decimal places, so there is no seeing past the eighteenth. */
const KEI_PLACES = 18

/** Trailing zeros, and the decimal point if they were all that followed it. */
function trim(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/**
 * How long ago, in the shortest form that is still true.
 *
 * Coarse on purpose: a launchpad where a coin is "1m ago" and then "1m ago" and
 * then "2m ago" is a page that redraws every list item every second to tell
 * somebody nothing. Seconds are only shown for the first minute, when they are
 * the whole story.
 */
export function formatAge(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * An address, shortened, keeping both ends.
 *
 * Both ends because the prefix is the same on every Kei address and the tail is
 * what tells two of them apart — truncating only the end shows a column of
 * identical strings.
 */
export function shortAddress(address: string, keep = 6): string {
  if (address.length <= keep * 2 + 5) return address
  return `${address.slice(0, 4 + keep)}…${address.slice(-keep)}`
}

export class FormatError extends Error {}
