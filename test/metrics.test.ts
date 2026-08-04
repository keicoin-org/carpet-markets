/**
 * Criterion 4, as assertions.
 *
 * *Price, volume and holder panels render an explicit "no trades yet" rather
 * than a zero or an empty chart, because a coin nobody has traded has no price.*
 * The page failed that twice — Trades and Holders both printed a bare `0` — and
 * volume was not rendered at all, which is worse than printing it wrong.
 *
 * The interesting test in here is not any single metric. It is `every metric`:
 * a loop over the whole registry asserting that on an untraded coin, no figure
 * comes back as a number. That one holds for metrics nobody has written yet,
 * which is the reason the registry exists.
 */

import { expect, test } from 'bun:test'

import { METRICS, metric, metricsIn, type MetricContext } from '../lib/metrics.js'
import type { Reading } from '../lib/readings.js'
import type { Book, Holder, Listing } from '../shared/listing.js'
import type { Offer, PriceSummary, Trade } from 'kei-transaction'

const SUPPLY = 1_000_000
const ASSET = 'asset-CARPET'

const LISTING: Listing = {
  asset: ASSET,
  symbol: 'CARPET',
  name: 'Carpet',
  blurb: '',
  issuer: 'kei_issuer',
  creator: 'kei_creator',
  transfer: 'open',
  supply: SUPPLY,
  launchedAt: 1_000,
}

const EMPTY_BOOK: Book = { asset: ASSET, asks: [], bids: [], trades: [], price: null }

function context(over: Partial<MetricContext> = {}): MetricContext {
  return { listing: LISTING, book: EMPTY_BOOK, holders: [], held: 0, loading: false, problem: null, ...over }
}

function read(id: string, over: Partial<MetricContext> = {}): Reading<string> {
  return metric(id).read(context(over))
}

/** Enough of an offer for the registry to price and count. */
function offer(over: { give?: number; want?: number; giveAsset?: string }): Offer {
  const give = over.give ?? 1_000
  const want = over.want ?? 0.5
  const giveAsset = over.giveAsset ?? ASSET
  return {
    hash: `offer-${give}-${want}-${giveAsset}`,
    from: 'kei_someone',
    give: { asset: giveAsset, symbol: 'X', name: 'X', decimals: 0, amount: give },
    want: { asset: giveAsset === ASSET ? 'kei' : ASSET, symbol: 'Y', name: 'Y', decimals: 0, amount: want },
    price: want / give,
    to: null,
    expiresAt: null,
    expired: false,
    state: 'open',
    mine: false,
    acceptedBy: null,
    settledBy: null,
    seenAt: 1,
    settledAt: null,
  } as Offer
}

const PRICED: PriceSummary = {
  asset: ASSET,
  quote: 'kei',
  median: 0.0005,
  last: 0.0006,
  low: 0.0004,
  high: 0.0008,
  trades: 3,
  volume: 4_500,
}

// ------------------------------------------------------- the criterion itself

test('an untraded coin reports no figure as a number, for every metric in the registry', () => {
  const readings = METRICS.map((entry) => [entry.id, entry.read(context())] as const)

  for (const [id, reading] of readings) {
    if (reading.state !== 'known') continue
    // Supply is minted at launch and is a fact about a coin nobody has traded,
    // so it is the one figure that is allowed to be a number here.
    expect([id, reading.value]).toEqual([id, expect.any(String)])
    expect(id).toBe('supply')
  }
})

test('nothing in the registry renders a bare zero for an absence', () => {
  for (const entry of METRICS) {
    const reading = entry.read(context())
    if (reading.state === 'known') continue
    if (reading.state === 'pending') continue
    expect(reading.why).not.toBe('0')
    expect(reading.why).not.toBe('—')
    expect(reading.why.length).toBeGreaterThan(2)
  }
})

test('price, volume and trades all say "never traded" rather than nothing', () => {
  for (const id of ['last', 'median', 'range', 'volume', 'trades']) {
    const reading = read(id)
    expect([id, reading.state]).toEqual([id, 'absent'])
    if (reading.state === 'absent') expect([id, reading.why]).toEqual([id, 'never traded'])
  }
})

test('trades reads the count once there is one, and it is the ledger figure', () => {
  const reading = read('trades', { book: { ...EMPTY_BOOK, price: PRICED } })
  expect(reading).toEqual({ state: 'known', value: '3' })
})

test('volume is units changed hands, which is the figure the page did not have', () => {
  const reading = read('volume', { book: { ...EMPTY_BOOK, price: PRICED } })
  expect(reading).toEqual({ state: 'known', value: '4,500 CARPET' })
})

test('holders says none we can read rather than zero, because zero is a claim about the chain', () => {
  expect(read('holders')).toEqual({ state: 'absent', why: 'none we can read' })

  const holder: Holder = { address: 'kei_a', amount: 10, creator: false, issuer: false }
  expect(read('holders', { holders: [holder] })).toEqual({ state: 'known', value: '1' })
})

// ------------------------------------------------------------ the other states

test('a book that has not come back yet is pending, not absent', () => {
  for (const entry of metricsIn('price')) {
    expect([entry.id, entry.read(context({ book: null, loading: true })).state]).toEqual([entry.id, 'pending'])
  }
})

test('a book that could not be read says unread rather than never traded', () => {
  // The distinction is the whole point: "this coin has never traded" is a claim
  // about the chain, and a client whose read failed is in no position to make it.
  for (const entry of metricsIn('price')) {
    const reading = entry.read(context({ book: null, loading: false, problem: 'the node refused' }))
    expect([entry.id, reading]).toEqual([entry.id, { state: 'absent', why: 'unread' }])
  }
})

test('holders never goes pending, because it does not come from the book', () => {
  expect(read('holders', { book: null, loading: true }).state).toBe('absent')
})

// ------------------------------------------------------------------- the depth

test('the depth metrics name which side is empty', () => {
  expect(read('best-ask')).toEqual({ state: 'absent', why: 'nobody is selling' })
  expect(read('best-bid')).toEqual({ state: 'absent', why: 'nobody is bidding' })
  expect(read('orders')).toEqual({ state: 'absent', why: 'no open orders' })
})

test('best ask is Kei per unit on an ask and on a bid alike', () => {
  const ask = offer({ give: 1_000, want: 0.5 })
  // A bid has the legs the other way up, so the SDK's `price` is coins per Kei.
  const bid = offer({ give: 0.4, want: 1_000, giveAsset: 'kei' })

  expect(read('best-ask', { book: { ...EMPTY_BOOK, asks: [ask] } })).toEqual({
    state: 'known',
    value: '0.0005 Kei',
  })
  expect(read('best-bid', { book: { ...EMPTY_BOOK, bids: [bid] } })).toEqual({
    state: 'known',
    value: '0.0004 Kei',
  })
})

test('open orders counts both sides', () => {
  const book = { ...EMPTY_BOOK, asks: [offer({})], bids: [offer({ giveAsset: 'kei', give: 0.4, want: 1_000 })] }
  expect(read('orders', { book })).toEqual({ state: 'known', value: '2' })
})

// ---------------------------------------------------------------- the position

test('a wallet holding none is told so in words', () => {
  expect(read('held')).toEqual({ state: 'absent', why: 'none' })
  expect(read('held', { held: 12_345 })).toEqual({ state: 'known', value: '12,345' })
})

test('supply is always known, because it was minted at launch', () => {
  expect(read('supply')).toEqual({ state: 'known', value: '1,000,000' })
})

// ------------------------------------------------------------------- the shape

test('every metric has a hint long enough to say where its number came from', () => {
  for (const entry of METRICS) {
    expect([entry.id, entry.hint.length > 40]).toEqual([entry.id, true])
    expect([entry.id, entry.hint.trim().endsWith('.')]).toEqual([entry.id, true])
  }
})

test('metric ids are unique, since the registry is keyed by them', () => {
  expect(new Set(METRICS.map((entry) => entry.id)).size).toBe(METRICS.length)
})

test('asking for a metric that is not registered fails loudly', () => {
  expect(() => metric('market-cap')).toThrow('No metric is registered as "market-cap".')
})

test('the registry covers all three groups', () => {
  for (const group of ['price', 'depth', 'position'] as const) {
    expect([group, metricsIn(group).length > 0]).toEqual([group, true])
  }
})

/**
 * Trades on a `Trade[]` are not what the summary counts.
 *
 * `PriceSummary` is computed by the SDK off the settled blocks; `book.trades` is
 * the list of them. They agree, and the metric reads the summary — so a coin
 * whose history read succeeded and whose summary is null is not a state the
 * registry can produce. This pins that the metric does not quietly fall back to
 * the array length, which would report a count for a coin with no price.
 */
test('the trade count comes from the summary, not from the length of the list', () => {
  const settled = [offer({})] as unknown as Trade[]
  const reading = read('trades', { book: { ...EMPTY_BOOK, trades: settled, price: null } })
  expect(reading).toEqual({ state: 'absent', why: 'never traded' })
})
