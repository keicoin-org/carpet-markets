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

/** `1234567` → `1,234,567`. Coins have no decimals, so there is nothing else to do. */
export function formatCoins(count: number): string {
  return Math.trunc(count).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
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
  if (kei >= 1) return kei.toFixed(4).replace(/\.?0+$/, '')
  return kei.toPrecision(3).replace(/\.?0+$/, '')
}

export class FormatError extends Error {}
