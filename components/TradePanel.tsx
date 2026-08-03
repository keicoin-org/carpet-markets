'use client'

/**
 * Buy and Sell, as tabs, over a real order book.
 *
 * The tabs are the shape a launchpad trades in, but only one half of them is
 * what those sites mean by it. There, Buy and Sell are the same call to a curve
 * in opposite directions and there is always a counterparty because the contract
 * is the counterparty. Here, Buy is a list of offers other people have signed —
 * it is empty when nobody is selling, and no amount of wanting to buy will
 * conjure a row into it. Sell writes an offer of your own and locks your coins
 * into it until somebody takes it.
 *
 * That asymmetry is not a gap in the UI. It is what a market without a market
 * maker looks like, and hiding it behind a "Buy" field that always accepts input
 * would be the one dishonest thing on the page.
 */

import { useState } from 'react'
import type { Offer } from 'kei-transaction'

import { formatCoins, formatPrice } from '../shared/format'
import type { Book, Listing } from '../shared/listing'
import { useMarket } from '../lib/use-market'

export function TradePanel({
  listing,
  book,
  held,
  onTraded,
}: {
  listing: Listing
  book: Book | null
  held: number
  onTraded: () => void
}) {
  const [tab, setTab] = useState<'buy' | 'sell'>('buy')

  if (listing.transfer !== 'open') return <NoMarket listing={listing} />

  return (
    <section className="panel overflow-hidden">
      <div className="grid grid-cols-2 border-b border-line">
        {(['buy', 'sell'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`px-3 py-2.5 text-sm font-medium capitalize transition-colors ${
              tab === key
                ? key === 'buy'
                  ? 'bg-up/10 text-up'
                  : 'bg-down/10 text-down'
                : 'text-fainter hover:text-dim'
            }`}
          >
            {key}
          </button>
        ))}
      </div>

      <div className="p-3">
        {tab === 'buy' ? (
          <Asks listing={listing} book={book} onTraded={onTraded} />
        ) : (
          <SellForm listing={listing} held={held} onTraded={onTraded} />
        )}
      </div>
    </section>
  )
}

/**
 * The offers, cheapest first, each one a button that settles it.
 *
 * Accepting is one block that moves both legs (SPEC §9.2). There is no window in
 * which this wallet has paid and not been paid — the ledger has no state in
 * which half of it happened.
 */
function Asks({ listing, book, onTraded }: { listing: Listing; book: Book | null; onTraded: () => void }) {
  const { trader, busy, act } = useMarket()
  const asks = book?.asks ?? []
  const theirs = asks.filter((offer) => !offer.mine)
  const mine = asks.filter((offer) => offer.mine)

  if (theirs.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-xs leading-relaxed text-fainter">
        {mine.length > 0
          ? 'Only your own offers are open. Somebody else has to take them.'
          : 'Nobody is selling. Whoever holds this can list some at a price of their choosing.'}
      </p>
    )
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="eyebrow text-left">
          <th className="pb-1.5 font-normal">Amount</th>
          <th className="pb-1.5 text-right font-normal">Each</th>
          <th className="pb-1.5 text-right font-normal">Total</th>
          <th />
        </tr>
      </thead>
      <tbody className="font-mono tabular">
        {theirs.map((offer) => (
          <tr key={offer.hash} className="border-t border-line/70">
            <td className="py-1.5">{formatCoins(offer.give.amount)}</td>
            <td className="py-1.5 text-right">{formatPrice(offer.price)}</td>
            <td className="py-1.5 text-right text-dim">{formatPrice(offer.want.amount)}</td>
            <td className="py-1.5 pl-2 text-right">
              <button
                type="button"
                disabled={busy || !trader}
                className="rounded border border-up/60 bg-up/10 px-2 py-1 text-xs font-medium text-up transition-colors hover:bg-up/20 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() =>
                  void act(`Buying ${formatCoins(offer.give.amount)} ${listing.symbol}`, async () => {
                    await trader?.accept(offer.hash)
                    onTraded()
                  })
                }
              >
                Buy
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * List some for sale: how many, and what to ask for each.
 *
 * Both numbers belong to the seller, which is the entire difference from the
 * bonding curve this used to have. Somebody holding the supply can put out a
 * thousand at a time and keep the price up, or all of it at once and not — and
 * the point of the example is that a buyer can watch them choose.
 */
function SellForm({ listing, held, onTraded }: { listing: Listing; held: number; onTraded: () => void }) {
  const { trader, busy, act } = useMarket()
  const [amount, setAmount] = useState('1000')
  const [each, setEach] = useState('0.0002')

  const count = Number(amount.replace(/[^\d]/g, '') || '0')
  const unit = Number(each)
  const priced = count > 0 && Number.isFinite(unit) && unit > 0

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="eyebrow">Amount ({listing.symbol})</span>
          <input
            type="text"
            inputMode="numeric"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="mt-1 w-full rounded-md border border-line bg-floor px-2.5 py-2 font-mono text-sm focus:border-line-bright focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="eyebrow">Price each (Kei)</span>
          <input
            type="text"
            inputMode="decimal"
            value={each}
            onChange={(event) => setEach(event.target.value)}
            className="mt-1 w-full rounded-md border border-line bg-floor px-2.5 py-2 font-mono text-sm focus:border-line-bright focus:outline-none"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {([
          ['10%', 0.1],
          ['25%', 0.25],
          ['half', 0.5],
          ['all of it', 1],
        ] as const).map(([label, share]) => (
          <button
            key={label}
            type="button"
            disabled={held <= 0}
            onClick={() => setAmount(String(Math.floor(held * share)))}
            className="rounded border border-line bg-raised px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-fainter transition-colors hover:border-line-bright hover:text-dim disabled:opacity-40"
          >
            {label}
          </button>
        ))}
      </div>

      <p className="font-mono text-[11px] text-fainter tabular">
        {priced
          ? `Asking ${formatPrice(count * unit)} Kei for the lot. You hold ${formatCoins(held)}.`
          : `Pick a whole number of coins and a price above zero. You hold ${formatCoins(held)}.`}
      </p>

      <button
        type="button"
        disabled={busy || held <= 0 || !priced || !trader}
        className="w-full rounded-md border border-down/60 bg-down/10 px-3 py-2 text-sm font-medium text-down transition-colors hover:bg-down/20 disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() =>
          void act(`Listing ${listing.symbol}`, async () => {
            if (count > held) {
              throw new Error(`You hold ${formatCoins(held)}, so you cannot list ${formatCoins(count)}.`)
            }
            await trader?.sell(listing.asset, count, unit)
            onTraded()
          })
        }
      >
        List them for sale
      </button>
    </div>
  )
}

function NoMarket({ listing }: { listing: Listing }) {
  return (
    <section className="panel border-l-2 border-l-line-bright p-4">
      <p className="text-xs leading-relaxed text-dim">
        {listing.transfer === 'none'
          ? 'Soulbound. These units cannot move, so there is no offer anybody could write and no market that could exist. That is not this site declining to host one — it is an invalid block.'
          : 'Issuer-only. Units move only to or from the issuing account, so no offer between two holders is valid. Whatever market this coin has, the issuer is the whole of it.'}
      </p>
    </section>
  )
}

/**
 * This wallet's own open offers.
 *
 * Worth showing because the coins in them are gone from the spendable balance
 * until the offer settles or is cancelled — locked by the `swap_offer` block,
 * not by bookkeeping here. A holder who cannot find their coins is looking at
 * this list.
 */
export function MyOffers({ listing, onTraded }: { listing: Listing; onTraded: () => void }) {
  const { trader, mine, busy, act } = useMarket()
  const ours = mine.filter((offer: Offer) => offer.give.asset === listing.asset)
  if (ours.length === 0) return null

  return (
    <section className="panel p-3">
      <h3 className="eyebrow">Your open offers</h3>
      <ul className="mt-2 space-y-1.5">
        {ours.map((offer) => (
          <li key={offer.hash} className="flex items-center justify-between gap-2 font-mono text-xs tabular">
            <span className="text-dim">
              {formatCoins(offer.give.amount)} at {formatPrice(offer.price)} Kei each
            </span>
            <button
              type="button"
              disabled={busy}
              className="rounded border border-line px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-fainter transition-colors hover:border-line-bright hover:text-dim disabled:opacity-40"
              onClick={() =>
                void act('Cancelling', async () => {
                  await trader?.cancel(offer.hash)
                  onTraded()
                })
              }
            >
              Cancel
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
