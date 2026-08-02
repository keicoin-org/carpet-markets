/**
 * The bonding curve, and nothing else.
 *
 * Both halves of the game import this file, and it is the only place a price is
 * decided. That is deliberate: if the client and the server disagreed about what
 * a coin costs, the client would be lying to somebody about money, and it would
 * look like a bug in the chain.
 *
 * Everything here is `bigint` in **raw** units — raw Kei (10^18 to the Kei) and
 * whole coins (0 decimals). Floating point would be fine for a chart and wrong
 * for a ledger, and this is the file that feeds the ledger.
 *
 * The curve is linear in supply:
 *
 *     price(s) = BASE + SLOPE * s
 *
 * so the cost of buying `n` coins when `s` are already out is the sum of that
 * over the n coins, which has a closed form and no loop:
 *
 *     cost(s, n) = BASE*n + SLOPE*(n*s + n*(n-1)/2)
 *
 * Linear rather than the constant-product curve an AMM would use, because this
 * one can be read off the page: the tenth coin costs ten slopes more than the
 * first, and a player can check the arithmetic by hand if they want to.
 */

/** Raw units per Kei. Matches `KEI_DECIMALS` in the SDK; asserted in the tests. */
export const KEI_RAW = 10n ** 18n

/** Coins that can ever be sold off the curve. The cap on the asset, too. */
export const CURVE_SUPPLY = 1_000_000n

/** The price of the very first coin: 0.00000006 Kei. */
export const BASE_RAW = 60_000_000_000n

/** What each coin already sold adds to the price: 0.00000000006 Kei. */
export const SLOPE_RAW = 60_000_000n

/**
 * Reserve at which the curve stops being a curve.
 *
 * Reached around 577,000 coins, so roughly three fifths of the supply — far
 * enough in that getting there is a real pump, close enough that a demo can
 * actually see it happen.
 */
export const GRADUATION_RAW = 10n * KEI_RAW

/**
 * Reserve held for a coin whose supply is `sold`.
 *
 * The market does not trust its own bookkeeping for this: it is recomputed from
 * supply whenever it matters, so a lost update makes a payout wrong by nothing
 * rather than by a running total.
 */
export function reserveAt(sold: bigint): bigint {
  return costToBuy(0n, sold)
}

/**
 * Cost of buying `count` coins when `sold` are already out.
 *
 * Exact — `count * (count - 1)` is always even, so the halving never rounds and
 * a buy followed by a sell of the same size returns exactly what it cost.
 */
export function costToBuy(sold: bigint, count: bigint): bigint {
  if (count <= 0n) return 0n
  const triangle = (count * (count - 1n)) / 2n
  return BASE_RAW * count + SLOPE_RAW * (count * sold + triangle)
}

/**
 * What selling `count` coins back pays, when `sold` are out.
 *
 * The mirror image of `costToBuy`, walked backwards down the same curve, so the
 * reserve is exactly emptied by selling exactly what was bought. There is no
 * spread and no fee: a market maker that skimmed would be a more realistic toy
 * and a worse explanation, and the thing being explained here is the curve.
 */
export function proceedsOfSale(sold: bigint, count: bigint): bigint {
  if (count <= 0n) return 0n
  if (count > sold) throw new CurveError(`Cannot sell ${count} coins when only ${sold} exist.`)
  return costToBuy(sold - count, count)
}

/**
 * The largest number of coins `budget` raw Kei buys at supply `sold`.
 *
 * Solved by bisection rather than by the quadratic formula: the closed form
 * needs an integer square root, and a bisection over at most twenty steps is
 * shorter, obviously correct, and cannot be off by one in the direction that
 * would let somebody buy a coin they did not pay for.
 */
export function coinsFor(sold: bigint, budget: bigint): bigint {
  const headroom = CURVE_SUPPLY - sold
  if (budget < BASE_RAW + SLOPE_RAW * sold || headroom <= 0n) return 0n

  let low = 0n
  let high = headroom
  while (low < high) {
    const mid = (low + high + 1n) / 2n
    if (costToBuy(sold, mid) <= budget) low = mid
    else high = mid - 1n
  }
  return low
}

/** The price of the next single coin — what a chart plots and a page displays. */
export function spotPrice(sold: bigint): bigint {
  return BASE_RAW + SLOPE_RAW * sold
}

export class CurveError extends Error {}

// ------------------------------------------------------------------ formatting

/**
 * Raw Kei as a decimal string, trimmed.
 *
 * Written out rather than divided into a `number`, because 10^18 does not fit in
 * a double and a price that renders as `6e-8` in one browser and `0.00000006` in
 * another is a support ticket.
 */
export function formatKei(raw: bigint, places = 8): string {
  const negative = raw < 0n
  const value = negative ? -raw : raw
  const whole = value / KEI_RAW
  const fraction = (value % KEI_RAW).toString().padStart(18, '0').slice(0, places).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`
}

/** `1234567` → `1,234,567`. Coins are whole, so there is nothing else to do. */
export function formatCoins(count: bigint): string {
  return count.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** A decimal Kei string (what a form field holds) as raw. Throws on nonsense. */
export function parseKei(text: string): bigint {
  const trimmed = text.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new CurveError(`"${text}" is not an amount of Kei.`)
  const [whole = '0', fraction = ''] = trimmed.split('.')
  if (fraction.length > 18) throw new CurveError('Kei has 18 decimal places; that has more.')
  return BigInt(whole) * KEI_RAW + BigInt(fraction.padEnd(18, '0'))
}
