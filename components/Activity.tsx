'use client'

/**
 * What has actually happened here lately, across every coin.
 *
 * The launchpads this page is shaped like run a ticker of *launches*, because a
 * launch is one person clicking a button and there is always another one. This
 * one runs settlements, because a settlement took two people who agreed on a
 * number and is therefore the only event on the site that is evidence of
 * anything. A quiet strip is the honest reading of a quiet market.
 *
 * Each row is one `swap_accept` block: who sold, who bought, how many, at what.
 * It is a `<ul>` rather than a marquee — a row somebody might want to click on
 * should not be moving, and a screen reader should not be read a scrolling list
 * on a loop.
 */

import Link from 'next/link'

import { formatAge, formatCoins, formatPrice, shortAddress } from '../shared/format'
import { coinAmount, unitPrice, type Listing } from '../shared/listing'
import type { Trade } from 'kei-transaction'

export function Activity({
  trades,
  listings,
  you,
  limit = 8,
}: {
  trades: readonly Trade[]
  listings: readonly Listing[]
  you: string | null
  limit?: number
}) {
  const bySymbol = new Map(listings.map((listing) => [listing.asset, listing]))
  const rows = trades.slice(0, limit)

  return (
    <section className="panel p-3" aria-label="Recent settlements">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="eyebrow">Settled lately</h2>
        <span className="font-mono text-[10px] text-fainter tabular">
          {trades.length === 0 ? 'nothing yet' : `${trades.length} on the board`}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="py-4 text-center text-xs leading-relaxed text-fainter">
          Nothing has settled. A trade here needs somebody to write an offer and somebody else to take it — there is no
          curve on the other side of the button.
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {rows.map((trade) => {
            // `trades` matches either leg, so the coin is whichever side of this
            // one it is on. Reading `give` blind prints the Kei amount as a coin
            // count — and `price` blind prints units per Kei — on every trade
            // that settled a bid rather than an ask.
            const listing = bySymbol.get(trade.give.asset) ?? bySymbol.get(trade.want.asset)
            if (!listing) return null
            const coins = coinAmount(trade, listing.asset)
            const mine = trade.seller === you || trade.buyer === you

            return (
              <li key={trade.hash}>
                <Link
                  href={{ pathname: '/coin', query: { asset: listing.asset } }}
                  className="flex items-baseline gap-2 rounded px-1 py-0.5 font-mono text-[11px] tabular hover:bg-raised"
                >
                  <span className={`w-16 shrink-0 truncate font-semibold ${mine ? 'text-gold' : 'text-ink'}`}>
                    {listing.symbol}
                  </span>
                  <span className="shrink-0 text-dim">{formatCoins(coins)}</span>
                  <span className="shrink-0 text-fainter">at</span>
                  <span className="shrink-0 text-ink">{formatPrice(unitPrice(trade, listing.asset))}</span>
                  <span className="hidden min-w-0 flex-1 truncate text-fainter sm:inline">
                    {shortAddress(trade.seller, 3)} → {shortAddress(trade.buyer, 3)}
                  </span>
                  <span className="ml-auto shrink-0 text-fainter">{formatAge(trade.settledAt ?? trade.seenAt)}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}

      <p className="mt-2 border-t border-line pt-2 text-[10px] leading-relaxed text-fainter">
        Read off the chains of the accounts this registry has been told to read. A trade between two wallets that never
        announced themselves settled perfectly well and is not on this list — Kei ships no indexer (SPEC §9.4).
      </p>
    </section>
  )
}
