/**
 * The board's controls, as arithmetic.
 *
 * A filter that silently drops a coin is indistinguishable from a coin that
 * never launched, which on this site is the most damaging bug available: the
 * whole page is an argument about what you can and cannot see. So every chip is
 * tested against the field it claims to read, and the two the genre does not
 * offer — "most sold off" and "cheapest ask" — are tested hardest, because they
 * are the two somebody would most reasonably suspect of being decorative.
 */

import { expect, test } from 'bun:test'

import { arrange, creatorShare, FILTERS, matches, narrowed, passesFilter, pulse, SORTS } from '../lib/board.js'
import type { Listing, ListingStats } from '../shared/listing.js'

const SUPPLY = 1_000_000

function coin(over: Partial<Listing> & { symbol: string }, stats: Partial<ListingStats> = {}): Listing {
  return {
    asset: `asset-${over.symbol}`,
    name: `${over.symbol} Coin`,
    blurb: '',
    issuer: `kei_issuer_${over.symbol}`,
    creator: `kei_creator_${over.symbol}`,
    transfer: 'open',
    supply: SUPPLY,
    launchedAt: 1_000,
    ...over,
    stats: {
      last: null,
      trades: 0,
      holders: 0,
      replies: 0,
      asks: 0,
      bestAsk: null,
      creatorHolds: SUPPLY,
      ...stats,
    },
  }
}

const none = new Map<string, number>()
const query = (over: Partial<Parameters<typeof arrange>[1]> = {}) => ({
  text: '',
  sort: 'new' as const,
  filter: 'all' as const,
  ...over,
})

// ------------------------------------------------------------------ what matches

test('search reads the fields somebody would actually type', () => {
  const listing = coin({ symbol: 'CARPET', name: 'Woven Regret', blurb: 'It goes under you.' })

  expect(matches(listing, '')).toBe(true)
  expect(matches(listing, 'carp')).toBe(true)
  expect(matches(listing, 'REGRET')).toBe(true)
  expect(matches(listing, 'under')).toBe(true)
  expect(matches(listing, 'asset-CAR')).toBe(true)
  expect(matches(listing, listing.creator)).toBe(true)
  expect(matches(listing, listing.issuer)).toBe(true)
  expect(matches(listing, 'nothing like it')).toBe(false)
})

test('a search for an address matches it whole and not by prefix', () => {
  // Half an address is not a search anybody performs deliberately, and matching
  // it would put unrelated coins under a paste of somebody's account.
  const listing = coin({ symbol: 'RUG', creator: 'kei_3abcdef' })
  expect(matches(listing, 'kei_3abcdef')).toBe(true)
  expect(matches(listing, 'kei_3abc')).toBe(false)
})

// ------------------------------------------------------------------ what filters

test('every filter chip reads a field the registry actually sends', () => {
  const quiet = coin({ symbol: 'QUIET' })
  const live = coin({ symbol: 'LIVE' }, { asks: 2, bestAsk: 0.001 })
  const traded = coin({ symbol: 'TRADED' }, { trades: 4, last: 0.002 })
  const bound = coin({ symbol: 'BOUND', transfer: 'none' })
  const closed = coin({ symbol: 'CLOSED', transfer: 'issuer-only' })

  expect(passesFilter(quiet, 'all', 0)).toBe(true)

  expect(passesFilter(live, 'buyable', 0)).toBe(true)
  expect(passesFilter(quiet, 'buyable', 0)).toBe(false)

  expect(passesFilter(traded, 'traded', 0)).toBe(true)
  expect(passesFilter(quiet, 'traded', 0)).toBe(false)

  expect(passesFilter(quiet, 'held', 5)).toBe(true)
  expect(passesFilter(quiet, 'held', 0)).toBe(false)

  expect(passesFilter(bound, 'none', 0)).toBe(true)
  expect(passesFilter(bound, 'open', 0)).toBe(false)
  expect(passesFilter(closed, 'issuer-only', 0)).toBe(true)
})

test('the filter list has no chip without a field behind it', () => {
  // The rule this page holds itself to. Adding a "volume, 24h" chip over a
  // number nobody computes is the same lie as a market cap, so the set of keys
  // is pinned here and a new one has to arrive with its field.
  expect(FILTERS.map((option) => String(option.key)).sort()).toEqual([
    'all',
    'buyable',
    'held',
    'issuer-only',
    'none',
    'open',
    'traded',
  ])
  expect(SORTS.map((option) => String(option.key)).sort()).toEqual([
    'active',
    'cheap',
    'dumped',
    'holders',
    'new',
    'price',
    'traded',
  ])
  for (const option of [...FILTERS, ...SORTS]) expect(option.hint.length).toBeGreaterThan(10)
})

test('narrowed is true whenever an empty result needs explaining', () => {
  expect(narrowed(query())).toBe(false)
  expect(narrowed(query({ text: '  ' }))).toBe(false)
  expect(narrowed(query({ text: 'rug' }))).toBe(true)
  expect(narrowed(query({ filter: 'buyable' }))).toBe(true)
  // Sorting an empty board differently does not explain why it is empty.
  expect(narrowed(query({ sort: 'dumped' }))).toBe(false)
})

// -------------------------------------------------------------------- what sorts

test('"most sold off" ranks by how much has left the creator, not by price', () => {
  const untouched = coin({ symbol: 'FULL' }, { creatorHolds: SUPPLY, last: 99 })
  const halfGone = coin({ symbol: 'HALF' }, { creatorHolds: SUPPLY / 2 })
  const gone = coin({ symbol: 'GONE' }, { creatorHolds: 0 })

  const order = arrange([untouched, halfGone, gone], query({ sort: 'dumped' }), none)
  expect(order.map((listing) => listing.symbol)).toEqual(['GONE', 'HALF', 'FULL'])

  expect(creatorShare(untouched)).toBe(1)
  expect(creatorShare(gone)).toBe(0)
})

test('"cheapest ask" sorts by the lowest live offer and puts unsellable coins last', () => {
  const cheap = coin({ symbol: 'CHEAP' }, { asks: 1, bestAsk: 0.0001 })
  const dear = coin({ symbol: 'DEAR' }, { asks: 1, bestAsk: 0.01 })
  // A coin with a high last price and nothing for sale must not lead a list
  // whose whole claim is "this is what you could buy right now".
  const unavailable = coin({ symbol: 'NONE' }, { asks: 0, bestAsk: null, last: 500 })

  const order = arrange([dear, unavailable, cheap], query({ sort: 'cheap' }), none)
  expect(order.map((listing) => listing.symbol)).toEqual(['CHEAP', 'DEAR', 'NONE'])
})

test('a tie is broken by age, so the list does not reshuffle under the cursor', () => {
  const older = coin({ symbol: 'OLD', launchedAt: 1 }, { trades: 3 })
  const newer = coin({ symbol: 'NEW', launchedAt: 2 }, { trades: 3 })

  expect(arrange([older, newer], query({ sort: 'traded' }), none).map((l) => l.symbol)).toEqual(['NEW', 'OLD'])
  expect(arrange([newer, older], query({ sort: 'traded' }), none).map((l) => l.symbol)).toEqual(['NEW', 'OLD'])
})

test('arrange applies the filter and the search together', () => {
  const held = coin({ symbol: 'MINE' }, { trades: 1 })
  const other = coin({ symbol: 'THEIRS' }, { trades: 1 })
  const holdings = new Map([[held.asset, 12]])

  expect(arrange([held, other], query({ filter: 'held' }), holdings).map((l) => l.symbol)).toEqual(['MINE'])
  expect(arrange([held, other], query({ filter: 'held', text: 'theirs' }), holdings)).toHaveLength(0)
})

// ------------------------------------------------------------------- the summary

test('the pulse counts things that exist and never values them', () => {
  const counts = pulse([
    coin({ symbol: 'A' }, { asks: 2, bestAsk: 0.1, trades: 3, creatorHolds: SUPPLY / 2 }),
    coin({ symbol: 'B' }, { asks: 0, trades: 1, creatorHolds: SUPPLY }),
    coin({ symbol: 'C' }),
  ])

  expect(counts).toEqual({ listed: 3, buyable: 1, traded: 2, trades: 4, distributing: 1 })
  // There is deliberately no market cap on this object. If one ever appears,
  // this assertion is where the argument has to be had.
  expect(Object.keys(counts).sort()).toEqual(['buyable', 'distributing', 'listed', 'traded', 'trades'])
})

test('a coin with no supply does not divide by zero', () => {
  expect(creatorShare(coin({ symbol: 'ZERO', supply: 0 }))).toBe(0)
})
