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
 *
 * Every row names its seller, its unit price, its size and its total, because
 * an order book with a price and no counterparty is a quote, and this is not a
 * place that quotes.
 */

import { useId, useState } from 'react'
import type { Offer } from 'kei-transaction'

import { formatCoins, formatKei, formatPrice, rawOfKei, shortAddress } from '../shared/format'
import type { Book, Listing } from '../shared/listing'
import { canSpend, spendable, spendableCoins } from '../lib/balance'
import { useMarket } from '../lib/use-market'

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
  const [tab, setTab] = useState<'buy' | 'sell'>('buy')

  if (listing.transfer !== 'open') return <NoMarket listing={listing} />

  const asks = book?.asks.length ?? 0

  return (
    <section className="panel overflow-hidden" aria-label={`Trade ${listing.symbol}`}>
      <div className="grid grid-cols-2 border-b border-line" role="tablist" aria-label="Buy or sell">
        {(['buy', 'sell'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`panel-${key}`}
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
            {key === 'buy' && asks > 0 && <span className="ml-1.5 font-mono text-[10px] tabular">{asks}</span>}
          </button>
        ))}
      </div>

      <div className="p-3" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'buy' ? (
          <Asks listing={listing} book={book} loading={loading} onTraded={onTraded} />
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
 *
 * Whose offer a row is gets worked out here rather than read off `offer.mine`,
 * which looks like it answers this and does not: the SDK sets it to
 * `from === client.address` for whichever client did the reading, and these
 * offers were read by the registry's wallet. It is therefore false on every row
 * in this table, including yours — so the old filter on it never removed
 * anything and the page offered people their own coins back.
 */
function Asks({
  listing,
  book,
  loading,
  onTraded,
}: {
  listing: Listing
  book: Book | null
  loading: boolean
  onTraded: () => void
}) {
  const { trader, funds, busy, act } = useMarket()
  const asks = book?.asks ?? []
  const yours = (offer: Offer): boolean => offer.from === trader?.address

  if (loading && !book) return <Waiting label="Reading the book…" />

  if (asks.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-xs leading-relaxed text-fainter">
        Nobody is selling. Whoever holds this can list some at a price of their choosing.
      </p>
    )
  }

  return (
    <table className="w-full text-sm">
      <caption className="sr-only">
        Open offers to sell {listing.symbol}, cheapest first. {asks.length} of them.
      </caption>
      <thead>
        <tr className="eyebrow text-left">
          <th scope="col" className="pb-1.5 font-normal">
            Amount
          </th>
          <th scope="col" className="pb-1.5 text-right font-normal">
            Each
          </th>
          <th scope="col" className="pb-1.5 text-right font-normal">
            Total
          </th>
          <th scope="col" className="sr-only">
            Action
          </th>
        </tr>
      </thead>
      <tbody className="font-mono tabular">
        {asks.map((offer) => {
          const mine = yours(offer)
          const total = rawOfKei(offer.want.amount)
          const affordable = canSpend(funds, total)
          const blocked = mine ? 'This is your own offer. Somebody else has to take it.' : null
          const short = !affordable
            ? `That costs ${formatPrice(offer.want.amount)} Kei and ${formatKei(spendable(funds), 4)} is spendable.`
            : null

          return (
            <tr key={offer.hash} className="border-t border-line/70">
              <td className="py-1.5 align-top">
                <span className="text-ink">
                  {formatCoins(offer.give.amount)} {listing.symbol}
                </span>
                <span className="mt-0.5 block text-[10px] text-fainter">
                  <span className="sr-only">Seller: </span>
                  <span title={offer.from}>{shortAddress(offer.from, 4)}</span>
                  {mine && <span className="ml-1 text-gold">you</span>}
                  {offer.expired && <span className="ml-1 text-down">stale</span>}
                </span>
              </td>
              <td className="py-1.5 text-right align-top">{formatPrice(offer.price)}</td>
              <td className="py-1.5 text-right align-top text-dim">{formatPrice(offer.want.amount)}</td>
              <td className="py-1.5 pl-2 text-right align-top">
                <button
                  type="button"
                  disabled={busy || !trader || mine || !affordable}
                  title={blocked ?? short ?? undefined}
                  aria-label={`Buy ${formatCoins(offer.give.amount)} ${listing.symbol} for ${formatPrice(
                    offer.want.amount,
                  )} Kei`}
                  className="rounded border border-up/60 bg-up/10 px-2 py-1 text-xs font-medium text-up transition-colors hover:bg-up/20 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() =>
                    void act(
                      `Buying ${formatCoins(offer.give.amount)} ${listing.symbol}`,
                      async () => {
                        await trader?.accept(offer.hash)
                        onTraded()
                      },
                      { kei: -total, coins: [[listing.asset, offer.give.amount]] },
                    )
                  }
                >
                  Buy
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
 * List some for sale: how many, and what to ask for each.
 *
 * Both numbers belong to the seller, which is the entire difference from the
 * bonding curve this used to have. Somebody holding the supply can put out a
 * thousand at a time and keep the price up, or all of it at once and not — and
 * the point of the example is that a buyer can watch them choose.
 */
function SellForm({ listing, held, onTraded }: { listing: Listing; held: number; onTraded: () => void }) {
  const { trader, funds, busy, act } = useMarket()
  const [amount, setAmount] = useState('1000')
  const [each, setEach] = useState('0.0002')
  const amountId = useId()
  const priceId = useId()
  const noteId = useId()

  const available = spendableCoins(funds, listing.asset, held)
  const count = Math.trunc(Number(amount.replace(/[^\d]/g, '') || '0'))
  const unit = Number(each)
  const priced = Number.isFinite(unit) && unit > 0
  const tooMany = count > available

  const problem = !priced
    ? 'Set a price above zero.'
    : count <= 0
      ? 'Set a whole number of coins above zero.'
      : tooMany
        ? `You hold ${formatCoins(available)}, so you cannot list ${formatCoins(count)}.`
        : null

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
            aria-invalid={count <= 0 || tooMany}
            onChange={(event) => setAmount(event.target.value)}
            className="mt-1 w-full rounded-md border border-line bg-floor px-2.5 py-2 font-mono text-sm focus:border-line-bright"
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
            aria-invalid={!priced}
            onChange={(event) => setEach(event.target.value)}
            className="mt-1 w-full rounded-md border border-line bg-floor px-2.5 py-2 font-mono text-sm focus:border-line-bright"
          />
        </label>
      </div>

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
            onClick={() => setAmount(String(Math.floor(available * share)))}
            className="rounded border border-line bg-raised px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-fainter transition-colors hover:border-line-bright hover:text-dim disabled:cursor-not-allowed disabled:opacity-40"
          >
            {label}
          </button>
        ))}
      </div>

      <p id={noteId} className="font-mono text-[11px] tabular" aria-live="polite">
        {problem ? (
          <span className="text-down">{problem}</span>
        ) : (
          <span className="text-fainter">
            Asking <span className="text-ink">{formatPrice(count * unit)} Kei</span> for the lot.
          </span>
        )}
        <span className="ml-1 text-fainter">
          You hold {formatCoins(available)}
          {available !== held && ` of ${formatCoins(held)}, the rest still settling`}.
        </span>
      </p>

      <button
        type="button"
        disabled={busy || !trader || problem !== null}
        className="w-full rounded-md border border-down/60 bg-down/10 px-3 py-2 text-sm font-medium text-down transition-colors hover:bg-down/20 disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() =>
          void act(
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
        List them for sale
      </button>
    </div>
  )
}

function Waiting({ label }: { label: string }) {
  return (
    <p className="px-1 py-6 text-center text-xs text-fainter" role="status">
      {label}
    </p>
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
              <span className="ml-1.5 text-fainter">· {formatPrice(offer.want.amount)} Kei the lot</span>
            </span>
            <button
              type="button"
              disabled={busy}
              aria-label={`Cancel your offer of ${formatCoins(offer.give.amount)} ${listing.symbol}`}
              className="rounded border border-line px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-fainter transition-colors hover:border-line-bright hover:text-dim disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() =>
                void act(
                  'Cancelling',
                  async () => {
                    await trader?.cancel(offer.hash)
                    onTraded()
                  },
                  { coins: [[listing.asset, offer.give.amount]] },
                )
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
