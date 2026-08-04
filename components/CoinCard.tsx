'use client'

/**
 * One coin on the board.
 *
 * The reading order is the argument: mark, ticker, then the policy badge, and
 * only then any number. Somebody scanning this board should learn whether a coin
 * can be dumped on them before they learn what it last traded for, because the
 * first fact is enforced by consensus and the second is a rumour about the past.
 *
 * Three numbers earn their place under that, and each one answers a question a
 * launchpad usually leaves to a market cap:
 *
 *   best ask       what somebody would have to pay to own some, right now. It is
 *                  an offer with a name on it, not a quote, so it can be absent —
 *                  and when it is, the card says nobody is selling rather than
 *                  drawing a price from the last trade and implying availability.
 *   creator holds  a bar, not a figure, because it is a proportion and it only
 *                  moves one way. Full is the launch state and everybody starts
 *                  there; empty is a creator who has sold everything.
 *   trades         the only activity here that took two people.
 */

import Link from 'next/link'

import { creatorShare } from '../lib/board'
import { formatAge, formatCoins, formatPrice } from '../shared/format'
import type { Listing } from '../shared/listing'
import { CoinArt } from './CoinArt'
import { PolicyBadge } from './PolicyBadge'

/** "1 holder", "2 holders". A board of "1 holders" reads as a placeholder. */
function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** Two significant figures near the ends, none in the middle. */
function percentLabel(share: number): string {
  const percent = share * 100
  if (percent > 0 && percent < 1) return `${percent.toFixed(1)}%`
  return `${percent.toFixed(percent > 99 && percent < 100 ? 1 : 0)}%`
}

export function CoinCard({ listing, held = 0 }: { listing: Listing; held?: number }) {
  const stats = listing.stats
  const share = creatorShare(listing)
  const tradable = listing.transfer === 'open'

  return (
    <Link
      href={{ pathname: '/coin', query: { asset: listing.asset } }}
      className="group panel flex h-full gap-3 p-3 transition-colors hover:border-line-bright hover:bg-raised"
    >
      <CoinArt asset={listing.asset} symbol={listing.symbol} size={52} />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 truncate font-semibold tracking-tight group-hover:text-gold">{listing.symbol}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-dim">{listing.name}</span>
          <span className="shrink-0 font-mono text-[10px] text-fainter tabular">{formatAge(listing.launchedAt)}</span>
        </div>

        <div className="mt-1.5">
          <PolicyBadge listing={listing} />
        </div>

        {listing.blurb && <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-dim">{listing.blurb}</p>}

        <div className="mt-auto pt-2">
          {/* The one number somebody could act on, given its own line, because
              "you can buy this now" and "somebody bought this once" are
              different facts and only the first is a decision. */}
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-[11px] tabular">
            {stats?.bestAsk != null ? (
              <span className="text-up">
                {formatPrice(stats.bestAsk)} <span className="text-fainter">Kei ask</span>
              </span>
            ) : stats?.last != null ? (
              <span className="text-dim">
                {formatPrice(stats.last)} <span className="text-fainter">Kei last</span>
              </span>
            ) : (
              <span className="text-fainter">never traded</span>
            )}
            {(stats?.asks ?? 0) > 0 && <span className="text-fainter">{plural(stats?.asks ?? 0, 'offer')}</span>}
            {held > 0 && <span className="ml-auto text-gold">you hold {formatCoins(held)}</span>}
          </div>

          <p className="mt-1 font-mono text-[10px] leading-relaxed text-fainter tabular">
            {plural(stats?.trades ?? 0, 'trade')} · {plural(stats?.holders ?? 0, 'holder')}
            {(stats?.replies ?? 0) > 0 && ` · ${plural(stats?.replies ?? 0, 'reply', 'replies')}`}
            {!tradable && ' · nothing to trade, by consensus'}
          </p>

          {tradable && (
            <div className="mt-1.5">
              <div className="flex items-baseline justify-between font-mono text-[10px] text-fainter tabular">
                <span>creator holds</span>
                <span className={share < 0.9 ? 'text-dim' : ''}>{percentLabel(share)}</span>
              </div>
              <div
                className="mt-1 h-1 overflow-hidden rounded-full bg-line"
                role="img"
                aria-label={`The launcher is still holding ${percentLabel(share)} of the supply`}
              >
                <div className="h-full rounded-full bg-gold/80" style={{ width: `${share * 100}%` }} />
              </div>
            </div>
          )}
        </div>
      </div>
    </Link>
  )
}
