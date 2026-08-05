'use client'

/**
 * Buy and Sell, as tabs, over a real order book.
 *
 * The tabs are the shape a launchpad trades in, but only one half of them is
 * what those sites mean by it. There, Buy and Sell are the same call to a curve
 * in opposite directions and there is always a counterparty because the contract
 * is the counterparty. Here both tabs open with somebody else's blocks: Buy is
 * the asks and Sell is the bids, and either can be empty because a market with
 * no market maker is sometimes one-sided.
 *
 * What each tab offers when its ladder is empty is the honest answer rather than
 * a greyed-out price field — write your own order, and wait. A bid locks Kei, an
 * ask locks coins, both are one `swap_offer` block with the legs the other way
 * up (SPEC §9.2), and neither is a promise that anybody will take it.
 *
 * Every reason a button will not work is worked out before the click and shown
 * beside it (SPEC §9.6, criterion 2). `lib/refusals.ts` holds those, so the
 * sentence somebody reads is the same one a test asserts.
 *
 * The Buy half is `components/BuyFunnel.tsx` and moves through the five steps in
 * `lib/funnel.ts`. Selling is one form and one signature, so it is still one
 * form and one signature.
 */

import { useEffect, useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Offer } from 'kei-transaction'

import { formatCoins, formatKei, formatPrice, rawOfKei } from '../shared/format'
import { coinAmount, keiAmount, unitPrice, type Book, type Listing } from '../shared/listing'
import { spendable, spendableCoins } from '../lib/balance'
import { bidBlocker, sellBlocker, type Blocker } from '../lib/refusals'
import { useMarket, useMyOffers } from '../lib/use-market'
import { BuyFunnel } from './BuyFunnel'
import { Ladder, spread } from './OrderBook'
import { Tabs } from './Tabs'

type Tab = 'buy' | 'sell'

export function TradePanel({
  listing,
  book,
  held,
  loading,
  onTraded,
}: {
  listing: Listing
  book: Book | null
  held: number
  loading: boolean
  onTraded: () => void
}) {
  const [tab, setTab] = useState<Tab>('buy')

  if (listing.transfer !== 'open') return <NoMarket listing={listing} />

  const asks = book?.asks ?? []
  const bids = book?.bids ?? []
  const counts: Record<Tab, number> = { buy: asks.length, sell: bids.length }

  return (
    <section className="panel overflow-hidden" aria-label={`Trade ${listing.symbol}`}>
      <Tabs
        label="Buy or sell"
        className="border-b border-line"
        tabClassName="flex-1 px-3 py-2.5 text-sm font-medium capitalize"
        active={tab}
        onPick={setTab}
        tabs={[
          {
            key: 'buy',
            label: (
              <>
                buy
                {counts.buy > 0 && <span className="ml-1.5 font-mono text-[10px] tabular">{counts.buy}</span>}
              </>
            ),
            name: `Buy — ${counts.buy} open ${counts.buy === 1 ? 'offer' : 'offers'}`,
            // A bottom border as well as a colour: selection signalled by hue
            // alone is unreadable to a third of the reasons somebody has a
            // preference about hue.
            selectedClassName: 'border-b-2 border-up bg-up/10 text-up',
          },
          {
            key: 'sell',
            label: (
              <>
                sell
                {counts.sell > 0 && <span className="ml-1.5 font-mono text-[10px] tabular">{counts.sell}</span>}
              </>
            ),
            name: `Sell — ${counts.sell} open ${counts.sell === 1 ? 'bid' : 'bids'}`,
            selectedClassName: 'border-b-2 border-down bg-down/10 text-down',
          },
        ]}
      >
        <p className="border-b border-line px-3 py-1.5 font-mono text-[10px] text-fainter tabular">
          {spread(asks, bids, listing.asset)}
        </p>

        <div className="p-3">
          {tab === 'buy' ? (
            <BuyFunnel listing={listing} asks={asks} held={held} loading={loading} onTraded={onTraded}>
              <BidForm listing={listing} startOpen={asks.length === 0} onTraded={onTraded} />
            </BuyFunnel>
          ) : (
            <>
              <SellForm listing={listing} held={held} onTraded={onTraded} />
              {bids.length > 0 && (
                <div className="mt-4 border-t border-line pt-3">
                  <h3 className="eyebrow mb-1.5">Or fill a bid now</h3>
                  <Ladder side="bid" listing={listing} offers={bids} held={held} loading={loading} onTraded={onTraded} />
                </div>
              )}
            </>
          )}
        </div>
      </Tabs>
    </section>
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
  const { trader, funds, busy, act } = useMarket()
  const { locked } = useMyOffers(listing.asset)
  const [amount, setAmount] = useState('1000')
  const [each, setEach] = useState('0.0002')
  const amountId = useId()
  const priceId = useId()
  const noteId = useId()

  const available = spendableCoins(funds, listing.asset, held)
  const count = wholeCoins(amount)
  const unit = Number(each)

  const blocked = sellBlocker({
    listing,
    funds,
    held,
    amount: count,
    unitPrice: unit,
    locked,
    you: trader?.address ?? null,
    busy,
  })

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block" htmlFor={amountId}>
          <span className="eyebrow">Amount ({listing.symbol})</span>
          <input
            id={amountId}
            type="text"
            inputMode="numeric"
            value={amount}
            aria-describedby={noteId}
            aria-invalid={blocked?.code === 'no-amount' || blocked?.code === 'over-held'}
            onChange={(event) => setAmount(event.target.value)}
            className="mt-1 w-full field px-2.5 py-2 font-mono text-sm"
          />
        </label>
        <label className="block" htmlFor={priceId}>
          <span className="eyebrow">Price each (Kei)</span>
          <input
            id={priceId}
            type="text"
            inputMode="decimal"
            value={each}
            aria-describedby={noteId}
            aria-invalid={blocked?.code === 'no-price'}
            onChange={(event) => setEach(event.target.value)}
            className="mt-1 w-full field px-2.5 py-2 font-mono text-sm"
          />
        </label>
      </div>

      <Shares available={available} onPick={(value) => setAmount(String(value))} />

      <Note id={noteId} blocked={blocked}>
        <span className="text-fainter">
          Asking <span className="text-ink">{formatPrice(count * unit)} Kei</span> for the lot. You can move{' '}
          {formatCoins(available)}
          {available !== held && ` of ${formatCoins(held)}, the rest locked in your own orders`}.
        </span>
      </Note>

      <button
        type="button"
        aria-disabled={blocked !== null}
        aria-describedby={noteId}
        className={`w-full rounded-md border border-down/60 bg-down/10 px-3 py-2 text-sm font-medium text-down transition-colors hover:bg-down/20 ${
          blocked ? 'cursor-not-allowed opacity-40' : ''
        }`}
        onClick={() =>
          blocked ||
          void act(
            'sell',
            `Listing ${formatCoins(count)} ${listing.symbol}`,
            async () => {
              // Checked again here, against the same spendable number, because
              // the poll can land between the render that enabled this button
              // and the click that used it.
              if (count > spendableCoins(funds, listing.asset, held)) {
                throw new Error(`You hold ${formatCoins(available)}, so you cannot list ${formatCoins(count)}.`)
              }
              await trader?.sell(listing.asset, count, unit)
              onTraded()
            },
            { coins: [[listing.asset, -count]] },
          )
        }
      >
        Lock them into an offer
      </button>
    </div>
  )
}

/**
 * Wanting to buy, written down.
 *
 * Folded away when there are asks to take, because taking one is the common case
 * and the one a first-time visitor should fall into. It opens on its own when
 * the ladder above is empty, since at that moment it is the only thing a buyer
 * can actually do — and doing it locks real Kei, which is what makes a bid worth
 * more than a watchlist entry.
 */
function BidForm({
  listing,
  startOpen,
  onTraded,
}: {
  listing: Listing
  startOpen: boolean
  onTraded: () => void
}) {
  const { trader, funds, busy, act } = useMarket()
  // Opened *by* `startOpen` rather than controlled by it. The book polls, so a
  // controlled `open` slams this shut under somebody typing in it the moment an
  // ask appears — and forces it open again when the last one is filled.
  const [open, setOpen] = useState(startOpen)
  useEffect(() => {
    if (startOpen) setOpen(true)
  }, [startOpen])
  const [amount, setAmount] = useState('1000')
  const [each, setEach] = useState('0.0001')
  const amountId = useId()
  const priceId = useId()
  const noteId = useId()

  const count = wholeCoins(amount)
  const unit = Number(each)
  const total = useMemo(() => rawOfKei(count * unit), [count, unit])

  const blocked = bidBlocker({
    listing,
    funds,
    amount: count,
    unitPrice: unit,
    total,
    you: trader?.address ?? null,
    busy,
  })

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="mt-3 border-t border-line pt-3"
    >
      <summary className="cursor-pointer select-none text-xs text-dim hover:text-ink">
        Bid for it — lock Kei until a holder fills it
      </summary>

      <div className="mt-3 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block" htmlFor={amountId}>
            <span className="eyebrow">Amount ({listing.symbol})</span>
            <input
              id={amountId}
              type="text"
              inputMode="numeric"
              value={amount}
              aria-describedby={noteId}
              aria-invalid={blocked?.code === 'no-amount'}
              onChange={(event) => setAmount(event.target.value)}
              className="mt-1 w-full field px-2.5 py-2 font-mono text-sm"
            />
          </label>
          <label className="block" htmlFor={priceId}>
            <span className="eyebrow">Price each (Kei)</span>
            <input
              id={priceId}
              type="text"
              inputMode="decimal"
              value={each}
              aria-describedby={noteId}
              aria-invalid={blocked?.code === 'no-price'}
              onChange={(event) => setEach(event.target.value)}
              className="mt-1 w-full field px-2.5 py-2 font-mono text-sm"
            />
          </label>
        </div>

        <Note id={noteId} blocked={blocked}>
          <span className="text-fainter">
            Locking <span className="text-ink">{formatKei(total, 4)} Kei</span> until somebody fills it or you cancel.{' '}
            {formatKei(spendable(funds), 4)} is spendable.
          </span>
        </Note>

        <button
          type="button"
          aria-disabled={blocked !== null}
          aria-describedby={noteId}
          className={`w-full rounded-md border border-up/60 bg-up/10 px-3 py-2 text-sm font-medium text-up transition-colors hover:bg-up/20 ${
            blocked ? 'cursor-not-allowed opacity-40' : ''
          }`}
          onClick={() =>
            blocked ||
            void act(
              'buy',
              `Bidding for ${formatCoins(count)} ${listing.symbol}`,
              async () => {
                await trader?.bid(listing.asset, count, unit)
                onTraded()
              },
              { kei: -total },
            )
          }
        >
          Lock the Kei into a bid
        </button>
      </div>
    </details>
  )
}

/** Fractions of what is actually movable, which is not the same as what is held. */
function Shares({ available, onPick }: { available: number; onPick: (amount: number) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {(
        [
          ['10%', 0.1],
          ['25%', 0.25],
          ['half', 0.5],
          ['all of it', 1],
        ] as const
      ).map(([label, share]) => (
        <button
          key={label}
          type="button"
          disabled={available <= 0}
          onClick={() => onPick(Math.floor(available * share))}
          className="rounded border border-line bg-raised px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-fainter transition-colors hover:border-line-bright hover:text-dim disabled:cursor-not-allowed disabled:opacity-40"
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/**
 * The line under a form: what will happen, or why it will not.
 *
 * One region rather than two, so a screen reader hears the current state rather
 * than a summary and a contradiction of it. It is polite, because it changes on
 * every keystroke and an assertive one would talk over the typing.
 */
function Note({ id, blocked, children }: { id: string; blocked: Blocker | null; children: ReactNode }) {
  return (
    <p id={id} className="font-mono text-[11px] leading-relaxed tabular" aria-live="polite">
      {blocked ? (
        <>
          <span className="text-down">{blocked.sentence}</span>
          {blocked.fix && <span className="ml-1 text-fainter">{blocked.fix}</span>}
        </>
      ) : (
        children
      )}
    </p>
  )
}

/** Whatever was typed, as a whole number of coins. Coins have no decimals. */
function wholeCoins(text: string): number {
  return Math.trunc(Number(text.replace(/[^\d]/g, '') || '0'))
}

function NoMarket({ listing }: { listing: Listing }) {
  return (
    <section className="panel border-l-2 border-l-line-bright p-4" aria-label={`Trade ${listing.symbol}`}>
      <h3 className="text-sm font-semibold text-ink">
        {listing.transfer === 'none' ? 'Nothing to trade' : 'No market between holders'}
      </h3>
      <p className="mt-1.5 text-xs leading-relaxed text-dim">
        {listing.transfer === 'none'
          ? 'Soulbound. These units cannot move, so there is no offer anybody could write and no market that could exist. That is not this site declining to host one — it is an invalid block.'
          : 'Issuer-only. Units move only to or from the issuing account, so no offer between two holders is valid. Whatever market this coin has, the issuer is the whole of it.'}
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-fainter">
        Chosen at issuance and immutable afterwards (SPEC §5.4). The panel is absent rather than disabled because there
        is no state of this page in which it would work.
      </p>
    </section>
  )
}

/**
 * This wallet's own open orders on this coin, both sides.
 *
 * Worth showing because whatever is in them is gone from the spendable balance
 * until the order settles or is cancelled — locked by the `swap_offer` block,
 * not by bookkeeping here. A holder who cannot find their coins is looking at
 * this list, and so is a buyer wondering where their Kei went.
 */
export function MyOffers({ listing, onTraded }: { listing: Listing; onTraded: () => void }) {
  const { trader, mine, busy, act } = useMarket()
  const ours = mine.filter((offer: Offer) => offer.give.asset === listing.asset || offer.want.asset === listing.asset)
  if (ours.length === 0) return null

  return (
    <section className="panel p-3">
      <h3 className="eyebrow">Your open orders</h3>
      <ul className="mt-2 space-y-1.5">
        {ours.map((offer) => {
          const selling = offer.give.asset === listing.asset
          const coins = coinAmount(offer, listing.asset)
          const kei = keiAmount(offer, listing.asset)
          return (
            <li key={offer.hash} className="flex items-center justify-between gap-2 font-mono text-xs tabular">
              <span className="min-w-0 truncate text-dim">
                <span className={selling ? 'text-down' : 'text-up'}>{selling ? 'ask' : 'bid'}</span>{' '}
                {formatCoins(coins)} at {formatPrice(unitPrice(offer, listing.asset))}
                <span className="ml-1.5 text-fainter">· {formatPrice(kei)} Kei the lot</span>
              </span>
              <button
                type="button"
                disabled={busy}
                aria-label={`Cancel your ${selling ? 'offer' : 'bid'} of ${formatCoins(coins)} ${listing.symbol}`}
                className="shrink-0 rounded border border-line px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-fainter transition-colors hover:border-line-bright hover:text-dim disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() =>
                  void act(
                    'cancel',
                    'Cancelling',
                    async () => {
                      await trader?.cancel(offer.hash)
                      onTraded()
                    },
                    selling ? { coins: [[listing.asset, coins]] } : { kei: rawOfKei(kei) },
                  )
                }
              >
                Cancel
              </button>
            </li>
          )
        })}
      </ul>
      <p className="mt-2 border-t border-line pt-2 text-[10px] leading-relaxed text-fainter">
        What is in these is locked on the chain, not held aside here. A cancel is a block, and the lock comes back the
        moment it cements.
      </p>
    </section>
  )
}
