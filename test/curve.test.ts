/**
 * The curve, on its own.
 *
 * These are the properties the market's money depends on, so they are checked
 * here rather than inferred from a game that happened to balance. The one that
 * matters most is round-tripping: buy n and sell n and the reserve is exactly
 * where it started, because anything else is a spread the game never disclosed.
 */

import { expect, test } from 'bun:test'
import { KEI_DECIMALS } from 'kei-transaction'

import {
  BASE_RAW,
  CURVE_SUPPLY,
  CurveError,
  KEI_RAW,
  SLOPE_RAW,
  coinsFor,
  costToBuy,
  formatCoins,
  formatKei,
  parseKei,
  proceedsOfSale,
  reserveAt,
  spotPrice,
} from '../shared/curve.js'

test('raw units match the SDK, or every price on the page is wrong by a factor of ten', () => {
  expect(KEI_RAW).toBe(10n ** BigInt(KEI_DECIMALS))
})

test('the first coin costs the base price', () => {
  expect(costToBuy(0n, 1n)).toBe(BASE_RAW)
  expect(spotPrice(0n)).toBe(BASE_RAW)
})

test('price rises by exactly one slope per coin sold', () => {
  expect(spotPrice(1n) - spotPrice(0n)).toBe(SLOPE_RAW)
  expect(spotPrice(999_999n) - spotPrice(999_998n)).toBe(SLOPE_RAW)
})

test('buying n at once costs the same as buying n one at a time', () => {
  let piecemeal = 0n
  for (let sold = 0n; sold < 250n; sold += 1n) piecemeal += costToBuy(sold, 1n)
  expect(costToBuy(0n, 250n)).toBe(piecemeal)
})

test('a round trip is exact — no spread, no dust, nothing kept', () => {
  const start = 12_345n
  const size = 6_789n
  const paid = costToBuy(start, size)
  const back = proceedsOfSale(start + size, size)
  expect(back).toBe(paid)
  expect(reserveAt(start)).toBe(reserveAt(start + size) - paid)
})

test('the reserve is always exactly what the coins in circulation cost', () => {
  for (const sold of [0n, 1n, 1_000n, 577_351n, CURVE_SUPPLY]) {
    expect(reserveAt(sold)).toBe(costToBuy(0n, sold))
  }
})

test('filling the whole curve costs about 30 Kei', () => {
  const total = reserveAt(CURVE_SUPPLY)
  expect(total).toBeGreaterThan(30n * KEI_RAW)
  expect(total).toBeLessThan(31n * KEI_RAW)
})

test('the last coin costs about a thousand times the first', () => {
  const ratio = spotPrice(CURVE_SUPPLY - 1n) / BASE_RAW
  expect(ratio).toBeGreaterThan(900n)
  expect(ratio).toBeLessThan(1_100n)
})

test('coinsFor never sells a coin that was not paid for', () => {
  for (const sold of [0n, 5_000n, 400_000n]) {
    for (const budget of [0n, BASE_RAW, KEI_RAW / 1000n, KEI_RAW, 5n * KEI_RAW]) {
      const count = coinsFor(sold, budget)
      expect(costToBuy(sold, count)).toBeLessThanOrEqual(budget)
      // And it is the *most* that fits: one more would cost more than was paid.
      if (sold + count < CURVE_SUPPLY) expect(costToBuy(sold, count + 1n)).toBeGreaterThan(budget)
    }
  }
})

test('a budget below one coin buys nothing rather than rounding up to one', () => {
  expect(coinsFor(0n, BASE_RAW - 1n)).toBe(0n)
  expect(coinsFor(0n, BASE_RAW)).toBe(1n)
})

test('coinsFor stops at the supply cap however much is offered', () => {
  expect(coinsFor(0n, 1_000_000n * KEI_RAW)).toBe(CURVE_SUPPLY)
  expect(coinsFor(CURVE_SUPPLY, KEI_RAW)).toBe(0n)
})

test('selling more than exists is refused, not clamped silently', () => {
  expect(() => proceedsOfSale(10n, 11n)).toThrow(CurveError)
})

test('formatting round-trips through parsing', () => {
  for (const raw of [0n, 1n, BASE_RAW, KEI_RAW, 30_057_000_000_000_000_000n]) {
    expect(parseKei(formatKei(raw, 18))).toBe(raw)
  }
})

test('formatting never reaches for a double', () => {
  // 1e-18 Kei is below the resolution of a JS number at this magnitude, so a
  // formatter that divided would print 0 and the page would say a payment of one
  // raw unit was a payment of nothing.
  expect(formatKei(1n, 18)).toBe('0.000000000000000001')
  expect(formatKei(BASE_RAW)).toBe('0.00000006')
  expect(formatCoins(1_234_567n)).toBe('1,234,567')
})

test('parseKei refuses things that are not amounts', () => {
  for (const text of ['', '-1', '1.2.3', 'abc', '0.0000000000000000001']) {
    expect(() => parseKei(text)).toThrow(CurveError)
  }
})
