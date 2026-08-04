'use client'

/**
 * The book, on both sides, with a button on every row.
 *
 * There is no market maker here, so a row is not a quote — it is one specific
 * account offering one specific quantity, and the only way to trade is to take
 * something somebody wrote. That is why every row names its author and why the
 * empty state says "nobody is selling" rather than showing a price with nothing
 * behind it.
 *
 * The two sides are the same block type with its legs the other way up
 * (SPEC §9.2): an ask locks coins and wants Kei, a bid locks Kei and wants
 * coins. Filling either is one `swap_accept`. So the ladder is one component
 * used twice rather than two components pretending to be symmetrical.
 *
 * The bar behind each row is cumulative size, which is the only depth reading
 * that means anything on a book this shallow: it says how much you would have to
 * take to clear everything down to that price.
 */

import type { Offer } from 'kei-transaction'

import { formatCoins, formatPrice, rawOfKei, shortAddress } from '../shared/format'
import { coinAmount, keiAmount, unitPrice, type Listing } from '../shared/listing'
import { buyBlocker, fillBidBlocker, type Blocker } from '../lib/refusals'
import { useMarket } from '../lib/use-market'

export type Side = 'ask' | 'bid'

/**
 * One side of the book, cheapest-first for asks and best-first for bids.
 *
 * `mine` is worked out here rather than read off `offer.mine`, which looks like
 * it answers this and does not: the SDK sets it to `from === client.address` for
 * whichever client did the reading, and these offers were read by the registry's
 * wallet. It is therefore false on every row in this table, including yours — so
 * the old filter on it never removed anything and the page offered people their
 * own coins back.
 */
export function Ladder({
  side,
  listing,
  offers,
  held,
  loading,
  onTraded,
}: {
  side: Side
  listing: Listing
  offers: readonly Offer[]
  held: number
  loading: boolean
  onTraded: () => void
}) {
  const { trader, funds, busy, act } = useMarket()
  const you = trader?.address ?? null

  if (loading && offers.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-xs text-fainter" role="status">
        Reading the book…
      </p>
    )
  }

  if (offers.length === 0) return <EmptySide side={side} listing={listing} />

  // Cumulative coin size down the ladder, for the depth bar. Coins on both
  // sides: an ask gives them, a bid wants them.
  const sizes = offers.map((offer) => coinAmount(offer, listing.asset))
  const deepest = sizes.reduce((total, size) => total + size, 0) || 1
  let running = 0

  return (
    <table className="w-full text-sm">
      <caption className="sr-only">
        {side === 'ask'
          ? `Open offers to sell ${listing.symbol}, cheapest first.`
          : `Open bids for ${listing.symbol}, best price first.`}{' '}
        {offers.length} of them.
      </caption>
      <thead>
        <tr className="eyebrow text-left">
          <th scope="col" className="pb-1.5 font-normal">
            {side === 'ask' ? 'For sale' : 'Wanted'}
          </th>
          <th scope="col" className="pb-1.5 text-right font-normal">
            Each
          </th>
          <th scope="col" className="hidden pb-1.5 text-right font-normal sm:table-cell">
            Total
          </th>
          <th scope="col" className="sr-only">
            Action
          </th>
        </tr>
      </thead>
      <tbody className="font-mono tabular">
        {offers.map((offer, index) => {
          running += sizes[index] ?? 0
          const depth = Math.min(100, (running / deepest) * 100)
          const size = sizes[index] ?? 0

          const blocked: Blocker | null =
            side === 'ask'
              ? buyBlocker({
                  listing,
                  funds,
                  total: rawOfKei(keiAmount(offer, listing.asset)),
                  from: offer.from,
                  you,
                  busy,
                })
              : fillBidBlocker({ listing, funds, held, want: size, from: offer.from, you, busy })

          return (
            <tr key={offer.hash} className="relative border-t border-line/70">
              <td className="relative py-1.5 align-top">
                {/* Depth, drawn behind the row rather than as a column, so the
                    numbers stay in a straight line at 360 px. */}
                <span
                  aria-hidden
                  className={`pointer-events-none absolute inset-y-0 left-0 -z-10 ${
                    side === 'ask' ? 'bg-down/[0.07]' : 'bg-up/[0.07]'
                  }`}
                  style={{ width: `${depth}%` }}
                />
                <span className="text-ink">
                  {formatCoins(size)} <span className="text-fainter">{listing.symbol}</span>
                </span>
                <span className="mt-0.5 block text-[10px] text-fainter">
                  <span className="sr-only">{side === 'ask' ? 'Seller' : 'Bidder'}: </span>
                  <span title={offer.from}>{shortAddress(offer.from, 4)}</span>
                  {offer.from === you && <span className="ml-1 text-gold">you</span>}
                  {offer.expired && (
                    <span className="ml-1 text-down" title="Its advisory expiry has passed. The chain has no clock, so it still settles if anybody takes it (SPEC §9.3).">
                      stale
                    </span>
                  )}
                </span>
              </td>
              {/* Kei per unit, both sides. `offer.price` is only that on an ask
                  — on a bid the SDK's number is units per Kei. See `unitPrice`. */}
              <td className="py-1.5 text-right align-top">{formatPrice(unitPrice(offer, listing.asset))}</td>
              <td className="hidden py-1.5 text-right align-top text-dim sm:table-cell">
                {formatPrice(keiAmount(offer, listing.asset))}
              </td>
              <td className="py-1.5 pl-2 text-right align-top">
                {/* `aria-disabled` rather than `disabled`, and the refusal in
                    the accessible name rather than in a `title`. A disabled
                    button leaves the tab order, so a keyboard visitor never
                    reaches the row and never hears why — and a `title` fires on
                    hover only, which is the one input this page cannot assume.
                    Criterion 2 says the reason is named *before* the action;
                    an unreachable tooltip does not name it at all. */}
                <button
                  type="button"
                  aria-disabled={blocked !== null}
                  aria-label={`${side === 'ask' ? 'Buy' : 'Sell'} ${formatCoins(size)} ${listing.symbol} for ${formatPrice(
                    keiAmount(offer, listing.asset),
                  )} Kei${blocked ? ` — unavailable: ${blocked.sentence}${blocked.fix ? ` ${blocked.fix}` : ''}` : ''}`}
                  className={`rounded border px-2 py-1 text-xs font-medium transition-colors ${
                    blocked ? 'cursor-not-allowed opacity-40' : ''
                  } ${
                    side === 'ask'
                      ? 'border-up/60 bg-up/10 text-up hover:bg-up/20'
                      : 'border-down/60 bg-down/10 text-down hover:bg-down/20'
                  }`}
                  onClick={() =>
                    blocked ||
                    void act(
                      side === 'ask' ? 'buy' : 'sell',
                      side === 'ask'
                        ? `Buying ${formatCoins(size)} ${listing.symbol}`
                        : `Selling ${formatCoins(size)} ${listing.symbol}`,
                      async () => {
                        await trader?.accept(offer.hash)
                        onTraded()
                      },
                      side === 'ask'
                        ? { kei: -rawOfKei(keiAmount(offer, listing.asset)), coins: [[listing.asset, size]] }
                        : { kei: rawOfKei(keiAmount(offer, listing.asset)), coins: [[listing.asset, -size]] },
                    )
                  }
                >
                  {side === 'ask' ? 'Buy' : 'Sell'}
                </button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/**
 * The row that is not there, explained.
 *
 * A launchpad on a curve never has this state, because the contract is always
 * the counterparty. Here it is the normal condition of a coin nobody is trading,
 * and pretending otherwise with a greyed-out price field would be the one
 * dishonest thing on the page.
 */
function EmptySide({ side, listing }: { side: Side; listing: Listing }) {
  return (
    <p className="px-1 py-6 text-center text-xs leading-relaxed text-fainter">
      {side === 'ask'
        ? `Nobody is selling ${listing.symbol}. There is no reserve to buy from — somebody who holds it has to write an offer first, or you can bid below and wait for one of them to take it.`
        : `Nobody is bidding for ${listing.symbol}. A bid locks the bidder's Kei until a holder fills it, so the ones here are real money waiting.`}
    </p>
  )
}

/**
 * What the whole book says in one line, for the header above it.
 *
 * Both sides in Kei per unit, which on the bid side is not what the SDK's
 * `price` holds — an uncorrected bid renders as thousands next to an ask of
 * fractions and makes the spread look like an arbitrage. Both ends assume their
 * list is already sorted best-first, which `registry.book` does.
 */
export function spread(asks: readonly Offer[], bids: readonly Offer[], asset: string): string {
  const bestAsk = asks[0] ? unitPrice(asks[0], asset) : null
  const bestBid = bids[0] ? unitPrice(bids[0], asset) : null
  if (bestAsk === null && bestBid === null) return 'no open orders'
  if (bestAsk === null) return `${formatPrice(bestBid!)} bid, nothing offered`
  if (bestBid === null) return `${formatPrice(bestAsk)} ask, nobody bidding`
  return `${formatPrice(bestBid)} bid · ${formatPrice(bestAsk)} ask`
}
