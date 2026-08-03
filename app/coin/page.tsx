'use client'

/**
 * One coin, everything known about it.
 *
 * The coin is a query parameter rather than a path segment, which is a
 * deployment fact rather than a taste one: this ships as a static export, and a
 * dynamic route in a static export has to enumerate its pages at build time.
 * Coins are launched by visitors minutes after the build, so there is nothing to
 * enumerate. `/coin?asset=…` is one prerendered page that reads its argument in
 * the browser, which is exactly what this is.
 */

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

import { Holders } from '../../components/Holders'
import { CoinArt } from '../../components/CoinArt'
import { PolicyBadge } from '../../components/PolicyBadge'
import { PriceChart } from '../../components/PriceChart'
import { Replies } from '../../components/Replies'
import { SupplyMeter } from '../../components/SupplyMeter'
import { MyOffers, TradePanel } from '../../components/TradePanel'
import { formatAge, formatCoins, formatPrice, shortAddress } from '../../shared/format'
import type { Book, Listing, TransferPolicy } from '../../shared/listing'
import { useCoin, useListing, useMarket } from '../../lib/use-market'

export default function CoinPage() {
  // useSearchParams needs a boundary during prerender, and prerender is the
  // whole build here.
  return (
    <Suspense fallback={<p className="py-16 text-center text-sm text-fainter">Loading…</p>}>
      <Coin />
    </Suspense>
  )
}

function Coin() {
  const asset = useSearchParams().get('asset')
  const { trader, holdings, loading: boardLoading } = useMarket()
  const listing = useListing(asset)
  const { book, holders, replies, loading, reload } = useCoin(asset)

  // "Not listed" and "not read yet" are different sentences, and saying the
  // first while the second is true is how a working link reads as a dead one.
  if (!listing && boardLoading && asset) {
    return (
      <p className="py-16 text-center text-sm text-fainter" role="status">
        Reading the board…
      </p>
    )
  }

  if (!listing) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-fainter">
          {asset ? 'No coin by that id is listed here.' : 'No coin was named.'}
        </p>
        <Link href="/" className="mt-3 inline-block text-sm text-gold hover:underline">
          Back to the board
        </Link>
      </div>
    )
  }

  const held = holdings.get(listing.asset) ?? 0
  const price = book?.price

  return (
    <div className="space-y-4">
      <Link href="/" className="inline-block font-mono text-[11px] text-fainter hover:text-gold">
        ← board
      </Link>

      <header className="flex flex-wrap items-start gap-3">
        <CoinArt asset={listing.asset} symbol={listing.symbol} size={64} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h1 className="text-2xl font-bold tracking-tight">{listing.symbol}</h1>
            <span className="text-sm text-dim">{listing.name}</span>
            <span className="font-mono text-[10px] text-fainter">{formatAge(listing.launchedAt)} old</span>
          </div>
          <div className="mt-1.5">
            <PolicyBadge listing={listing} large />
          </div>
          {listing.blurb && <p className="mt-2 max-w-prose text-sm leading-snug text-dim">{listing.blurb}</p>}
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <PriceChart trades={book?.trades ?? []} />

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
            <Stat label="Last" value={price ? `${formatPrice(price.last)} Kei` : 'never traded'} />
            <Stat label="Median" value={price ? `${formatPrice(price.median)} Kei` : '—'} />
            <Stat
              label="Range"
              value={price ? `${formatPrice(price.low)} – ${formatPrice(price.high)}` : '—'}
            />
            <Stat label="Trades" value={price ? String(price.trades) : '0'} />
            <Stat label="Supply" value={formatCoins(listing.supply)} />
            <Stat label="You hold" value={formatCoins(held)} accent={held > 0} />
            <Stat label="Holders" value={String(holders.length)} />
            <Stat label="Open asks" value={String(book?.asks.length ?? 0)} />
          </dl>

          <TradePanel listing={listing} book={book} held={held} loading={loading} onTraded={() => void reload()} />
          <MyOffers listing={listing} onTraded={() => void reload()} />
          <Replies listing={listing} replies={replies} onPosted={() => void reload()} />
        </div>

        <div className="space-y-4">
          <SupplyMeter listing={listing} />
          <Holders listing={listing} holders={holders} you={trader?.address ?? null} />
          <RecentTrades book={book} listing={listing} loading={loading} you={trader?.address ?? null} />
          <Provenance listing={listing} />
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className={`mt-0.5 font-mono text-sm tabular ${accent ? 'text-gold' : 'text-ink'}`}>{value}</dd>
    </div>
  )
}

/** Newest first here, unlike the chart, because a log is read from the top. */
function RecentTrades({
  book,
  listing,
  loading,
  you,
}: {
  book: Book | null
  listing: Listing
  loading: boolean
  you: string | null
}) {
  const trades = [...(book?.trades ?? [])].reverse().slice(0, 12)

  return (
    <section className="panel p-3">
      <h3 className="eyebrow">Trades</h3>
      {loading && !book ? (
        <p className="py-4 text-center text-xs text-fainter" role="status">
          Reading the chain…
        </p>
      ) : trades.length === 0 ? (
        <p className="py-4 text-center text-xs text-fainter">Nothing has settled yet.</p>
      ) : (
        <ul className="mt-2 space-y-1.5 font-mono text-[11px] tabular">
          {trades.map((trade) => {
            // `trades({ asset })` matches either leg, so the coin is whichever
            // side of this one it is on. Reading `give` blind would print the
            // Kei amount as a coin count on any trade written the other way up.
            const coins = trade.give.asset === listing.asset ? trade.give.amount : trade.want.amount
            const mine = trade.seller === you || trade.buyer === you
            return (
              <li key={trade.hash}>
                <span className="flex items-baseline justify-between gap-2">
                  <span className={mine ? 'text-gold' : 'text-dim'}>
                    {formatCoins(coins)} {listing.symbol}
                  </span>
                  <span className="text-ink">{formatPrice(trade.price)} Kei</span>
                  <span className="text-fainter">{formatAge(trade.settledAt ?? trade.seenAt)}</span>
                </span>
                <span className="mt-0.5 block text-[10px] text-fainter">
                  <span title={trade.seller}>{shortAddress(trade.seller, 4)}</span>
                  <span aria-label=" sold to "> → </span>
                  <span title={trade.buyer}>{shortAddress(trade.buyer, 4)}</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

const POLICY: Record<TransferPolicy, string> = {
  open: 'open — anybody can send it to anybody, including all of it to you',
  'issuer-only': 'issuer-only — units move only to or from the issuing account',
  none: 'none — soulbound, nothing moves',
}

function Provenance({ listing }: { listing: Listing }) {
  return (
    <details className="panel p-3 text-xs text-dim">
      <summary className="cursor-pointer select-none text-ink">What the chain says</summary>
      <dl className="mt-2.5 space-y-2">
        <Fact label="Coin asset" value={listing.asset} />
        <Fact label="Issued by" value={listing.issuer} />
        <Fact label="Transfer policy" value={POLICY[listing.transfer]} mono={false} />
        <Fact label="Launched by" value={listing.creator} />
      </dl>
      <p className="mt-3 leading-relaxed text-fainter">
        The transfer policy is fixed at issuance and enforced by consensus, not by this site. It is the reason the badge
        above is a fact rather than a promise. Every coin here is issued by an account of its own, so the burn one
        launch pays is its own first one and never anybody else’s.
      </p>
    </details>
  )
}

function Fact({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className={`mt-0.5 break-all ${mono ? 'font-mono text-[10px] text-dim' : 'text-xs text-dim'}`}>
        {mono ? <span title={value}>{shortAddress(value, 10)}</span> : value}
      </dd>
    </div>
  )
}
