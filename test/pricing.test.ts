/**
 * Which way up a price is.
 *
 * `Offer.price` is `want.amount` per one unit of `give`, which is the number
 * everybody means on an **ask**: the seller gives coins and wants Kei. On a
 * **bid** the legs are the other way up, so the same field holds *coins per Kei*
 * — and a bid at 0.0003 Kei each arrives as 3333.33.
 *
 * Rendered raw that is not a rounding error, it is a price wrong by six orders
 * of magnitude, sitting in a column headed "each" next to asks that are correct.
 * It would put a bid above every ask in a spread, invert the sort so the worst
 * bid led the book, and spike a chart of fractions with a single reading in the
 * thousands.
 *
 * So it is undone in exactly one place, and this file is why that place is
 * allowed to be the only one.
 */

import { expect, test } from 'bun:test'

import { coinAmount, keiAmount, unitPrice } from '../shared/listing.js'

const COIN = 'asset-carpet'
const KEI = '0'.repeat(64)

/** A seller giving 1,000 coins and wanting 0.5 Kei: 0.0005 Kei each. */
const ask = {
  give: { asset: COIN, amount: 1_000 },
  want: { asset: KEI, amount: 0.5 },
  price: 0.0005,
}

/** A bidder giving 0.3 Kei and wanting 1,000 coins: 0.0003 Kei each. */
const bid = {
  give: { asset: KEI, amount: 0.3 },
  want: { asset: COIN, amount: 1_000 },
  // What the SDK actually puts here: want per give, so coins per Kei.
  price: 1_000 / 0.3,
}

test('an ask reports the price the SDK already holds', () => {
  expect(unitPrice(ask, COIN)).toBeCloseTo(0.0005, 12)
})

test('a bid is inverted back into Kei per unit', () => {
  expect(bid.price).toBeGreaterThan(3_000)
  expect(unitPrice(bid, COIN)).toBeCloseTo(0.0003, 12)
})

test('the coin leg and the Kei leg are found whichever way up the offer is', () => {
  expect(coinAmount(ask, COIN)).toBe(1_000)
  expect(coinAmount(bid, COIN)).toBe(1_000)
  expect(keiAmount(ask, COIN)).toBeCloseTo(0.5, 12)
  expect(keiAmount(bid, COIN)).toBeCloseTo(0.3, 12)
})

test('a bid never outranks an ask it is actually below', () => {
  // The spread this produces raw is "3333.33 bid · 0.0005 ask", which reads as a
  // market anybody could take both sides of for free.
  expect(unitPrice(bid, COIN)).toBeLessThan(unitPrice(ask, COIN))
})

test('sorting a mixed book puts the best of each side first', () => {
  const cheaperAsk = { ...ask, want: { asset: KEI, amount: 0.4 }, price: 0.0004 }
  const betterBid = { give: { asset: KEI, amount: 0.45 }, want: { asset: COIN, amount: 1_000 }, price: 1_000 / 0.45 }

  const asks = [ask, cheaperAsk].sort((a, b) => unitPrice(a, COIN) - unitPrice(b, COIN))
  const bids = [bid, betterBid].sort((a, b) => unitPrice(b, COIN) - unitPrice(a, COIN))

  expect(unitPrice(asks[0]!, COIN)).toBeCloseTo(0.0004, 12)
  expect(unitPrice(bids[0]!, COIN)).toBeCloseTo(0.00045, 12)
})

test('a degenerate offer answers zero rather than infinity', () => {
  expect(unitPrice({ give: { asset: KEI, amount: 1 }, want: { asset: COIN, amount: 0 }, price: 0 }, COIN)).toBe(0)
})
