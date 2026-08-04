/**
 * Every figure the coin page states, as a table rather than as JSX.
 *
 * The board already has this discipline for its sorts — `lib/board.ts` keeps a
 * chip and the field behind it in one entry, so a control cannot exist over a
 * number nobody computes. This is the same rule for the numbers themselves, and
 * it exists because the page had grown two ways of being wrong that a reviewer
 * cannot catch by reading a grid of components:
 *
 *   1. A figure was rendered as `0` on a coin that had never traded. Trades and
 *      holders both did it. On a page whose argument is that it does not invent
 *      numbers, an invented zero is the worst available bug (SPEC §9.6, 4).
 *   2. `PriceSummary.volume` — a number the SDK computes off settled blocks and
 *      hands over for free — was not rendered anywhere, while criterion 4 names
 *      volume explicitly.
 *
 * Both are structural, so the fix is structural. A metric declares what it reads
 * and returns a `Reading` (`lib/readings.ts`), which is pending, absent-with-a-
 * sentence, or known. There is no path through the type by which "no trades yet"
 * arrives on screen as a zero, and adding the next figure is one entry in a list
 * rather than one more grid cell nobody tests.
 *
 * Nothing here imports React. The registry is data, `components/Readout.tsx`
 * renders it, and `test/metrics.test.ts` asserts every absent case by id.
 */

import { formatCoins, formatPrice } from '../shared/format'
import { unitPrice, type Book, type Holder, type Listing } from '../shared/listing'
import { absent, known, pending, type Reading } from './readings'

export interface MetricContext {
  listing: Listing
  /** Null until the first book read for this coin lands. */
  book: Book | null
  holders: readonly Holder[]
  /** Whole units this browser's wallet holds. */
  held: number
  /** True until the first read comes back, which is how pending is told from absent. */
  loading: boolean
  /** Set when a read failed and there is nothing cached to show instead. */
  problem?: string | null
}

/**
 * Which question a figure answers, which is also where it belongs on screen.
 *
 *   price     what it has traded for. Read off settled `swap_accept` blocks.
 *   depth     what somebody could do about it now. Read off open `swap_offer`s.
 *   position  who is holding what, including this browser.
 */
export type MetricGroup = 'price' | 'depth' | 'position'

export interface Metric {
  id: string
  /** The label above the figure. Short, because these sit four to a row. */
  label: string
  /** What it means and where it came from. Rendered, not just a tooltip. */
  hint: string
  group: MetricGroup
  read(context: MetricContext): Reading<string>
  /** True when the figure is about this wallet rather than about the coin. */
  personal?: boolean
}

/**
 * The one sentence a coin that has never traded gets, everywhere.
 *
 * Written once because five panels say it and five wordings would read as five
 * different conditions. A coin with no settled `swap_accept` block has no price,
 * no median, no range, no volume and no trade count — one absence, five figures.
 */
const NEVER_TRADED = 'never traded'

/** Open offers are a different absence from settled ones, and say so. */
const NOBODY_SELLING = 'nobody is selling'
const NOBODY_BIDDING = 'nobody is bidding'

/**
 * A read that failed against one that came back empty.
 *
 * These are not interchangeable and the page must not print the second when the
 * first happened: "never traded" about a coin whose book could not be read is a
 * claim the client is in no position to make.
 */
function chainState<T>(context: MetricContext): Reading<T> | null {
  if (context.book) return null
  if (context.problem) return absent('unread')
  return pending()
}

export const METRICS: readonly Metric[] = [
  {
    id: 'last',
    label: 'Last',
    hint: 'The most recent settled trade, in Kei per unit. One `swap_accept` block, not a quote.',
    group: 'price',
    read: (context) =>
      chainState<string>(context) ??
      (context.book!.price ? known(`${formatPrice(context.book!.price.last)} Kei`) : absent(NEVER_TRADED)),
  },
  {
    id: 'median',
    label: 'Median',
    hint: 'The middle of every settled trade — the SPEC §9.1 query, read off the chain rather than a time-series database.',
    group: 'price',
    read: (context) =>
      chainState<string>(context) ??
      (context.book!.price ? known(`${formatPrice(context.book!.price.median)} Kei`) : absent(NEVER_TRADED)),
  },
  {
    id: 'range',
    label: 'Range',
    hint: 'Lowest and highest settled price, ever. Not a window — the block-lattice has no clock (SPEC §5.5).',
    group: 'price',
    read: (context) => {
      const state = chainState<string>(context)
      if (state) return state
      const price = context.book!.price
      if (!price) return absent(NEVER_TRADED)
      return known(`${formatPrice(price.low)} – ${formatPrice(price.high)}`)
    },
  },
  {
    /**
     * The figure criterion 4 names and the page did not have.
     *
     * `PriceSummary.volume` is units of the coin that actually changed hands,
     * summed off the settled blocks by the SDK. It is the one size figure here
     * that took two people to produce — supply is a mint, holders is a balance
     * read, open orders is somebody's intention, and only this is agreement.
     */
    id: 'volume',
    label: 'Volume',
    hint: 'Units that have changed hands across every settled trade. Summed off `swap_accept` blocks by the SDK, not counted here.',
    group: 'price',
    read: (context) => {
      const state = chainState<string>(context)
      if (state) return state
      const price = context.book!.price
      if (!price) return absent(NEVER_TRADED)
      return known(`${formatCoins(price.volume)} ${context.listing.symbol}`)
    },
  },
  {
    id: 'trades',
    label: 'Trades',
    hint: 'Settled trades, ever. The only activity on this page that took two people to make.',
    group: 'price',
    read: (context) =>
      chainState<string>(context) ??
      (context.book!.price ? known(String(context.book!.price.trades)) : absent(NEVER_TRADED)),
  },
  {
    id: 'best-ask',
    label: 'Best ask',
    hint: 'The cheapest open offer anybody has written. There is no reserve to quote against, so this is absent whenever nobody is selling.',
    group: 'depth',
    read: (context) => {
      const state = chainState<string>(context)
      if (state) return state
      const best = context.book!.asks[0]
      if (!best) return absent(NOBODY_SELLING)
      return known(`${formatPrice(unitPrice(best, context.listing.asset))} Kei`)
    },
  },
  {
    id: 'best-bid',
    label: 'Best bid',
    hint: 'The most anybody has locked Kei to pay. A bid is real money waiting, not a watchlist entry.',
    group: 'depth',
    read: (context) => {
      const state = chainState<string>(context)
      if (state) return state
      const best = context.book!.bids[0]
      if (!best) return absent(NOBODY_BIDDING)
      return known(`${formatPrice(unitPrice(best, context.listing.asset))} Kei`)
    },
  },
  {
    id: 'orders',
    label: 'Open orders',
    hint: 'Unaccepted `swap_offer` blocks on both sides, each locking its author’s own asset until it settles or is cancelled.',
    group: 'depth',
    read: (context) => {
      const state = chainState<string>(context)
      if (state) return state
      const open = context.book!.asks.length + context.book!.bids.length
      return open > 0 ? known(String(open)) : absent('no open orders')
    },
  },
  {
    /**
     * A count of accounts, and never a census.
     *
     * Zero here is not "nobody holds it" — a coin always has at least its
     * creator holding the supply. It is "nobody the registry has been told to
     * read", which is a fact about this page rather than about the chain, and
     * the two must not share a rendering.
     */
    id: 'holders',
    label: 'Holders',
    hint: 'Accounts with a non-zero balance, of those the registry knows to ask about. A holder who never announced themselves is on the chain and not in this number.',
    group: 'position',
    read: (context) =>
      context.holders.length > 0 ? known(String(context.holders.length)) : absent('none we can read'),
  },
  {
    id: 'supply',
    label: 'Supply',
    hint: 'Units minted to the creator at launch. Fixed — this demo mints once and never again.',
    group: 'position',
    read: (context) => known(formatCoins(context.listing.supply)),
  },
  {
    id: 'held',
    label: 'You hold',
    hint: 'Confirmed units on this browser’s own chain. Anything locked into your own open offer already left this number.',
    group: 'position',
    personal: true,
    read: (context) => (context.held > 0 ? known(formatCoins(context.held)) : absent('none')),
  },
]

const BY_ID = new Map(METRICS.map((metric) => [metric.id, metric]))

export function metric(id: string): Metric {
  const found = BY_ID.get(id)
  if (!found) throw new Error(`No metric is registered as "${id}".`)
  return found
}

/** The registry, in the order a panel should render it. */
export function metricsIn(group: MetricGroup): readonly Metric[] {
  return METRICS.filter((entry) => entry.group === group)
}
