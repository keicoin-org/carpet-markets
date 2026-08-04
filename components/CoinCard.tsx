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
    // An `<article>` with a stretched primary link rather than one giant `<a>`,
    // because the policy badge is now a link too (criterion 7) and an anchor
    // inside an anchor is invalid markup that browsers resolve by dropping one
    // of them. The symbol carries the card's own link and an `::after` covering
    // the card makes the whole tile clickable; the badge sits above that overlay
    // on `z-10`, so both are reachable by pointer and both are tab stops.
    <article className="group panel relative flex h-full gap-3 p-3 transition-colors hover:border-line-bright hover:bg-raised focus-within:border-line-bright">
      <CoinArt asset={listing.asset} symbol={listing.symbol} size={52} />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-baseline gap-2">
          <Link
            href={{ pathname: '/coin', query: { asset: listing.asset } }}
            className="shrink-0 truncate font-semibold tracking-tight after:absolute after:inset-0 after:content-[''] group-hover:text-gold"
          >
            {listing.symbol}
            <span className="sr-only"> — open this coin’s trade screen</span>
          </Link>
          <span className="min-w-0 flex-1 truncate text-xs text-dim">{listing.name}</span>
          <span className="shrink-0 font-mono text-[10px] text-fainter tabular">{formatAge(listing.launchedAt)}</span>
        </div>

        <div className="mt-1.5">
          <PolicyBadge listing={listing} target="card" />
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
              {/* The percentage is already text on the line above, and this
                  sits inside the card's stretched link — labelling it puts the
                  same sentence into the link's name twice. */}
              <div aria-hidden className="mt-1 h-1 overflow-hidden rounded-full bg-line">
                <div className="h-full rounded-full bg-gold/80" style={{ width: `${share * 100}%` }} />
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  )
}
