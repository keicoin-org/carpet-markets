/**
 * Sorting and filtering the board, as arithmetic rather than as JSX.
 *
 * It lives out here for two reasons. The first is that a filter that silently
 * drops a coin is indistinguishable from a coin that never launched, so this is
 * the code most worth testing on a page whose whole subject is what you can and
 * cannot see. The second is that every control on the board has to answer for
 * itself: a chip is only allowed to exist if the registry actually sends the
 * field it sorts on, and keeping the sorts and the field they read in one table
 * is what stops a "volume, 24h" appearing over a number nobody computes.
 *
 * Nothing here touches React, the network, or the clock unless it is handed one.
 */

import type { Listing, TransferPolicy } from '../shared/listing'

export type SortKey = 'new' | 'active' | 'traded' | 'holders' | 'price' | 'dumped' | 'cheap'
export type FilterKey = 'all' | 'buyable' | 'traded' | 'held' | TransferPolicy

export interface SortOption {
  key: SortKey
  label: string
  /** What the column means, for the title attribute and the tests. */
  hint: string
  /** Higher sorts first. Every sort here is descending on its own scale. */
  rank(listing: Listing): number
}

export interface FilterOption {
  key: FilterKey
  label: string
  hint: string
}

/**
 * The sorts, and the field each one reads.
 *
 * `dumped` and `cheap` are the two this genre does not offer. The first ranks by
 * how much of the supply has left the creator's hands, which is the number that
 * says what has already happened to everybody who bought earlier; the second
 * ranks by the cheapest thing anybody is actually willing to sell, which is the
 * only price on the board somebody can act on right now.
 */
export const SORTS: readonly SortOption[] = [
  {
    key: 'new',
    label: 'newest',
    hint: 'Most recently launched first.',
    rank: (listing) => listing.launchedAt,
  },
  {
    key: 'active',
    label: 'live now',
    hint: 'Coins with somebody actually selling, most offers first.',
    rank: (listing) => listing.stats?.asks ?? 0,
  },
  {
    key: 'traded',
    label: 'most traded',
    hint: 'Settled trades, ever. The only activity here that took two people.',
    rank: (listing) => listing.stats?.trades ?? 0,
  },
  {
    key: 'holders',
    label: 'most holders',
    hint: 'Accounts holding a non-zero balance, of those the registry can read.',
    rank: (listing) => listing.stats?.holders ?? 0,
  },
  {
    key: 'price',
    label: 'highest price',
    hint: 'Last settled trade, in Kei per unit. Never-traded coins sort last.',
    rank: (listing) => listing.stats?.last ?? -1,
  },
  {
    key: 'cheap',
    label: 'cheapest ask',
    hint: 'The lowest price anybody is currently asking. Coins with no ask sort last.',
    // Negated, because this table is descending and a cheap ask is a high rank.
    // Coins with nothing for sale go to the bottom rather than to the top, which
    // is where a plain `-Infinity` would put a missing number after negation.
    rank: (listing) => (listing.stats?.bestAsk == null ? -Infinity : -listing.stats.bestAsk),
  },
  {
    key: 'dumped',
    label: 'most sold off',
    hint: 'How much of the supply has left the creator. The sort no launchpad in this shape offers.',
    rank: (listing) => 1 - creatorShare(listing),
  },
]

export const FILTERS: readonly FilterOption[] = [
  { key: 'all', label: 'everything', hint: 'Every coin this registry has been told about.' },
  { key: 'buyable', label: 'buyable now', hint: 'Somebody has written an offer you could accept this second.' },
  { key: 'traded', label: 'has traded', hint: 'At least one settled trade, so it has a real price.' },
  { key: 'open', label: 'tradable', hint: 'transfer: open — a peer-to-peer market exists and cannot be switched off.' },
  { key: 'issuer-only', label: 'issuer only', hint: 'transfer: issuer-only — no market between two holders is possible.' },
  { key: 'none', label: 'soulbound', hint: 'transfer: none — nothing moves, ever.' },
  { key: 'held', label: 'you hold', hint: 'Coins with a balance in this browser’s wallet.' },
]

export interface BoardQuery {
  text: string
  sort: SortKey
  filter: FilterKey
}

export const DEFAULT_QUERY: BoardQuery = { text: '', sort: 'new', filter: 'all' }

/** Whether anything has been narrowed, which is what an empty result has to explain. */
export function narrowed(query: BoardQuery): boolean {
  return query.text.trim().length > 0 || query.filter !== 'all'
}

/** Share of the supply the launcher is still sitting on, 0 to 1. */
export function creatorShare(listing: Listing): number {
  if (listing.supply <= 0) return 0
  const holds = listing.stats?.creatorHolds ?? listing.supply
  return Math.min(1, Math.max(0, holds / listing.supply))
}

/**
 * Does this coin match what was typed?
 *
 * Matched against the fields somebody would actually type: the ticker, the name,
 * the blurb, and both addresses. Addresses are in because "show me everything
 * this account launched" is a real question on a launchpad and pasting the
 * address is how somebody asks it — and because it is answerable off data the
 * registry already sent, which is the bar every control on this page has to
 * clear.
 */
export function matches(listing: Listing, needle: string): boolean {
  const text = needle.trim().toLowerCase()
  if (!text) return true
  return (
    listing.symbol.toLowerCase().includes(text) ||
    listing.name.toLowerCase().includes(text) ||
    listing.blurb.toLowerCase().includes(text) ||
    listing.asset.toLowerCase().startsWith(text) ||
    listing.creator.toLowerCase() === text ||
    listing.issuer.toLowerCase() === text
  )
}

export function passesFilter(listing: Listing, filter: FilterKey, held: number): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'held':
      return held > 0
    case 'buyable':
      return (listing.stats?.asks ?? 0) > 0
    case 'traded':
      return (listing.stats?.trades ?? 0) > 0
    default:
      return listing.transfer === filter
  }
}

/**
 * The board, narrowed and ordered.
 *
 * Sorting is stable on the newest-first tiebreak rather than on input order,
 * because the registry's order is a `Map` iteration and two coins with the same
 * trade count would otherwise swap places every poll — a list that reshuffles
 * under the cursor is worse than a list in the wrong order.
 */
export function arrange(
  listings: readonly Listing[],
  query: BoardQuery,
  holdings: ReadonlyMap<string, number>,
): Listing[] {
  const by = SORTS.find((option) => option.key === query.sort) ?? SORTS[0]!
  return listings
    .filter(
      (listing) =>
        passesFilter(listing, query.filter, holdings.get(listing.asset) ?? 0) && matches(listing, query.text),
    )
    .sort((a, b) => by.rank(b) - by.rank(a) || b.launchedAt - a.launchedAt)
}

/**
 * What the board is worth looking at, summarised for the strip above it.
 *
 * Every number here is a count of something the registry sent. There is no
 * market cap, because a market cap is the supply multiplied by the last price
 * one person paid once, and on a coin with a single 0.01 Kei trade that says ten
 * thousand Kei. That number is the biggest type on every launchpad in this
 * shape, and inventing it is the one thing this page will not do.
 */
export interface BoardPulse {
  listed: number
  /** Coins with at least one open offer somebody could accept right now. */
  buyable: number
  /** Coins that have ever settled a trade. */
  traded: number
  /** Settled trades across everything listed. */
  trades: number
  /** Coins whose creator has sold at least a tenth of the supply. */
  distributing: number
}

export function pulse(listings: readonly Listing[]): BoardPulse {
  return listings.reduce<BoardPulse>(
    (total, listing) => ({
      listed: total.listed + 1,
      buyable: total.buyable + ((listing.stats?.asks ?? 0) > 0 ? 1 : 0),
      traded: total.traded + ((listing.stats?.trades ?? 0) > 0 ? 1 : 0),
      trades: total.trades + (listing.stats?.trades ?? 0),
      distributing: total.distributing + (creatorShare(listing) < 0.9 ? 1 : 0),
    }),
    { listed: 0, buyable: 0, traded: 0, trades: 0, distributing: 0 },
  )
}
