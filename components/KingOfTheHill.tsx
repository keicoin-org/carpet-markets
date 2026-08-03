'use client'

/**
 * The feature slot, and an honest version of the one it is copied from.
 *
 * pump.fun crowns whichever coin is closest to graduating off its bonding curve.
 * There is no curve here and nothing to graduate to, so crowning by "market cap"
 * would mean multiplying a supply nobody has bought by a price one person paid
 * once — a number that says a coin with a single 0.01 Kei trade is worth ten
 * thousand Kei. That is the number those sites put in their biggest type.
 *
 * So the crown goes to whatever has been traded the most, which is the only
 * activity here that took two people to produce, and the creator's remaining
 * share is set right beside it because that is the number that says what is
 * likely to happen next.
 */

import Link from 'next/link'

import { formatCoins, formatPrice } from '../shared/format'
import type { Listing } from '../shared/listing'
import { CoinArt } from './CoinArt'
import { PolicyBadge } from './PolicyBadge'
import { SupplyMeter } from './SupplyMeter'

/** Most traded, then most held, then newest. Null if nothing has traded at all. */
export function crown(listings: readonly Listing[]): Listing | null {
  const traded = listings.filter((listing) => (listing.stats?.trades ?? 0) > 0)
  if (traded.length === 0) return null
  return [...traded].sort(
    (a, b) =>
      (b.stats?.trades ?? 0) - (a.stats?.trades ?? 0) ||
      (b.stats?.holders ?? 0) - (a.stats?.holders ?? 0) ||
      b.launchedAt - a.launchedAt,
  )[0] as Listing
}

export function KingOfTheHill({ listing }: { listing: Listing }) {
  const stats = listing.stats

  return (
    <Link
      href={{ pathname: '/coin', query: { asset: listing.asset } }}
      className="group panel block overflow-hidden border-gold/35 bg-gradient-to-b from-gold/[0.07] to-transparent p-4 transition-colors hover:border-gold/60"
    >
      <div className="flex items-center gap-2">
        <span className="eyebrow text-gold/80">Most traded</span>
        <span className="h-px flex-1 bg-gradient-to-r from-gold/30 to-transparent" />
        <span className="font-mono text-[10px] text-fainter tabular">{stats?.trades ?? 0} trades</span>
      </div>

      <div className="mt-3 flex flex-wrap items-start gap-4">
        <CoinArt asset={listing.asset} symbol={listing.symbol} size={80} />

        <div className="min-w-[12rem] flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h2 className="text-2xl font-bold tracking-tight group-hover:text-gold">{listing.symbol}</h2>
            <span className="text-sm text-dim">{listing.name}</span>
          </div>
          <div className="mt-2">
            <PolicyBadge listing={listing} large />
          </div>
          {listing.blurb && <p className="mt-2 max-w-prose text-sm leading-snug text-dim">{listing.blurb}</p>}
        </div>

        <div className="w-full sm:w-56">
          <div className="flex items-baseline justify-between">
            <span className="eyebrow">Last</span>
            <span className="font-mono text-lg tabular">
              {stats?.last != null ? `${formatPrice(stats.last)} Kei` : '—'}
            </span>
          </div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="eyebrow">Holders</span>
            <span className="font-mono text-sm text-dim tabular">{formatCoins(stats?.holders ?? 0)}</span>
          </div>
          <div className="mt-3">
            <SupplyMeter listing={listing} compact />
          </div>
        </div>
      </div>
    </Link>
  )
}
