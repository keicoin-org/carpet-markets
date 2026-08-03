'use client'

/**
 * One coin on the board.
 *
 * The reading order is the argument: mark, ticker, then the policy badge, and
 * only then any number. Somebody scanning this board should learn whether a coin
 * can be dumped on them before they learn what it last traded for, because the
 * first fact is enforced by consensus and the second is a rumour about the past.
 */

import Link from 'next/link'

import { formatAge, formatCoins, formatPrice } from '../shared/format'
import type { Listing } from '../shared/listing'
import { CoinArt } from './CoinArt'
import { PolicyBadge } from './PolicyBadge'

/** Two figures near the top, none in the middle — the same rule the meter uses. */
function creatorShare(listing: Listing): string {
  const holds = listing.stats?.creatorHolds ?? listing.supply
  const percent = listing.supply > 0 ? Math.min(100, Math.max(0, (holds / listing.supply) * 100)) : 0
  if (percent > 0 && percent < 1) return `${percent.toFixed(1)}%`
  return `${percent.toFixed(percent > 99 && percent < 100 ? 1 : 0)}%`
}

export function CoinCard({ listing, held = 0 }: { listing: Listing; held?: number }) {
  const stats = listing.stats

  return (
    <Link
      href={{ pathname: '/coin', query: { asset: listing.asset } }}
      className="group panel flex gap-3 p-3 transition-colors hover:border-line-bright hover:bg-raised"
    >
      <CoinArt asset={listing.asset} symbol={listing.symbol} size={56} />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-semibold tracking-tight group-hover:text-gold">{listing.symbol}</span>
          <span className="truncate text-xs text-dim">{listing.name}</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-fainter tabular">
            {formatAge(listing.launchedAt)}
          </span>
        </div>

        <div className="mt-1.5">
          <PolicyBadge listing={listing} />
        </div>

        {listing.blurb && <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-dim">{listing.blurb}</p>}

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-fainter tabular">
          <span>
            {stats?.last != null ? (
              <span className="text-ink">{formatPrice(stats.last)} Kei</span>
            ) : (
              'never traded'
            )}
          </span>
          <span>{stats?.trades ?? 0} trades</span>
          <span>{stats?.holders ?? 0} holders</span>
          {/* The number that says what is likely to happen next, on the card
              rather than one click in. It starts at 100% for everybody. */}
          {listing.transfer === 'open' && <span title="Share of the supply the launcher is still holding">{creatorShare(listing)} left with the creator</span>}
          {(stats?.replies ?? 0) > 0 && <span>{stats?.replies} replies</span>}
          {held > 0 && <span className="ml-auto text-gold">you hold {formatCoins(held)}</span>}
        </div>
      </div>
    </Link>
  )
}
