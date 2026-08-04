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
 *
 * The layout is the argument again. On a narrow screen the trade panel is
 * *first*, above the chart, because somebody who arrived from the board already
 * decided to look at this coin and the next thing they want is the button — and
 * because criterion 1 of SPEC §9.6 is a buy in five interactions, which a page
 * that puts a chart between the decision and the action cannot hit. On a wide
 * screen it moves to a rail that stays put while the history scrolls.
 */

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'

import { Holders } from '../../components/Holders'
import { CoinArt } from '../../components/CoinArt'
import { PolicyBadge } from '../../components/PolicyBadge'
import { PriceChart } from '../../components/PriceChart'
import { Replies } from '../../components/Replies'
import { SupplyMeter } from '../../components/SupplyMeter'
import { MyOffers, TradePanel } from '../../components/TradePanel'
import { formatAge, formatCoins, formatPrice, shortAddress } from '../../shared/format'
import { coinAmount, unitPrice, type Book, type Listing, type TransferPolicy } from '../../shared/listing'
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
  const { book, holders, replies, loading, problem, reload } = useCoin(asset)

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
        <p className="text-sm text-fainter">{asset ? 'No coin by that id is listed here.' : 'No coin was named.'}</p>
        <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-fainter">
          The registry lists the coins it has been told about, and on the mock chain it forgets them when the process
          restarts. A coin that existed an hour ago and does not now was not deleted — the ledger it lived on was.
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
            <span className="min-w-0 truncate text-sm text-dim">{listing.name}</span>
            <span className="font-mono text-[10px] text-fainter">{formatAge(listing.launchedAt)} old</span>
          </div>
          <div className="mt-1.5">
            <PolicyBadge listing={listing} large />
          </div>
          {listing.blurb && <p className="mt-2 max-w-prose text-sm leading-snug text-dim">{listing.blurb}</p>}
        </div>
      </header>

      {problem && !book && (
        <p className="panel border-down/40 p-3 text-xs leading-relaxed text-[#ffd9d9]" role="alert">
          The book could not be read: {problem} The page keeps trying every couple of seconds; nothing you have signed
          is affected by a failed read.
        </p>
      )}

      {/* Three blocks, two columns, and an order that differs between them.
          On a phone: trade, then the chart and the record, then the context
          panels — the button first, and nothing between the decision and it.
          From `lg`: the chart and the record run down the left across both
          rows, with the trade panel above the context panels on the right. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,22rem)] lg:items-start">
        <div className="order-1 min-w-0 space-y-4 lg:col-start-2 lg:row-start-1 lg:sticky lg:top-16">
          <TradePanel listing={listing} book={book} held={held} loading={loading} onTraded={() => void reload()} />
          <MyOffers listing={listing} onTraded={() => void reload()} />
        </div>

        <div className="order-2 min-w-0 space-y-4 lg:col-start-1 lg:row-start-1 lg:row-span-2">
          <PriceChart trades={book?.trades ?? []} asset={listing.asset} />

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
            <Stat label="Last" value={price ? `${formatPrice(price.last)} Kei` : 'never traded'} />
            <Stat label="Median" value={price ? `${formatPrice(price.median)} Kei` : '—'} />
            <Stat label="Range" value={price ? `${formatPrice(price.low)} – ${formatPrice(price.high)}` : '—'} />
            <Stat label="Trades" value={price ? String(price.trades) : '0'} />
            <Stat label="Supply" value={formatCoins(listing.supply)} />
            <Stat label="You hold" value={formatCoins(held)} accent={held > 0} />
            <Stat label="Holders" value={String(holders.length)} />
            <Stat label="Open orders" value={String((book?.asks.length ?? 0) + (book?.bids.length ?? 0))} />
          </dl>

          <Ledger book={book} listing={listing} replies={replies} loading={loading} you={trader?.address ?? null} />
        </div>

        <div className="order-3 min-w-0 space-y-4 lg:col-start-2 lg:row-start-2">
          <SupplyMeter listing={listing} />
          <Holders listing={listing} holders={holders} you={trader?.address ?? null} />
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

/**
 * The record: what has settled, and what people have said about it.
 *
 * Tabs rather than two stacked panels, because one of them is consensus and the
 * other is a comment box, and putting them side by side at equal weight is how a
 * reply gets read as a fact. The trades tab is first and is the default for the
 * same reason.
 */
function Ledger({
  book,
  listing,
  replies,
  loading,
  you,
}: {
  book: Book | null
  listing: Listing
  replies: Parameters<typeof Replies>[0]['replies']
  loading: boolean
  you: string | null
}) {
  const [tab, setTab] = useState<'trades' | 'replies'>('trades')

  return (
    <section className="panel overflow-hidden">
      <div className="flex border-b border-line" role="tablist" aria-label="Trades or replies">
        {(
          [
            ['trades', `Trades${book?.trades.length ? ` (${book.trades.length})` : ''}`],
            ['replies', `Replies${replies.length ? ` (${replies.length})` : ''}`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`ledger-${key}`}
            aria-selected={tab === key}
            aria-controls={`ledger-panel-${key}`}
            onClick={() => setTab(key)}
            className={`px-3 py-2 text-sm transition-colors ${
              tab === key ? 'border-b-2 border-gold text-ink' : 'text-fainter hover:text-dim'
            }`}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto self-center px-3 font-mono text-[9px] uppercase tracking-[0.1em] text-fainter">
          {tab === 'trades' ? 'on the chain' : 'off the chain'}
        </span>
      </div>

      <div role="tabpanel" id={`ledger-panel-${tab}`} aria-labelledby={`ledger-${tab}`}>
        {tab === 'trades' ? (
          <RecentTrades book={book} listing={listing} loading={loading} you={you} />
        ) : (
          <Replies listing={listing} replies={replies} />
        )}
      </div>
    </section>
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
  const trades = [...(book?.trades ?? [])].reverse().slice(0, 20)

  if (loading && !book) {
    return (
      <p className="py-6 text-center text-xs text-fainter" role="status">
        Reading the chain…
      </p>
    )
  }

  if (trades.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-xs leading-relaxed text-fainter">
        Nothing has settled yet, so this coin has no price. Every point on the chart above is one `swap_accept` block —
        two people who agreed on a number — and there have not been any.
      </p>
    )
  }

  return (
    <ul className="divide-y divide-line/70 font-mono text-[11px] tabular">
      {trades.map((trade) => {
        // `trades({ asset })` matches either leg, so the coin is whichever
        // side of this one it is on. Reading `give` or `price` blind prints
        // the Kei amount as a coin count and the price upside down on any
        // trade that settled a bid rather than an ask.
        const coins = coinAmount(trade, listing.asset)
        const mine = trade.seller === you || trade.buyer === you
        return (
          <li key={trade.hash} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5">
            <span className={mine ? 'text-gold' : 'text-dim'}>
              {formatCoins(coins)} {listing.symbol}
            </span>
            <span className="text-ink">{formatPrice(unitPrice(trade, listing.asset))} Kei</span>
            <span className="text-fainter">
              <span title={trade.seller}>{shortAddress(trade.seller, 4)}</span>
              <span aria-label=" sold to "> → </span>
              <span title={trade.buyer}>{shortAddress(trade.buyer, 4)}</span>
            </span>
            <span className="ml-auto text-fainter">{formatAge(trade.settledAt ?? trade.seenAt)}</span>
          </li>
        )
      })}
    </ul>
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
