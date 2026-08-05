'use client'

/**
 * The buy tab, as the five steps of `lib/funnel.ts` rather than as a book with a
 * button on it.
 *
 * The panel renders exactly one step at a time and can only move through them in
 * order, because the transitions are the state machine's and not this file's. A
 * row cannot sign; it can only choose. That is the difference between a funnel
 * the layout affords and a funnel the page enforces, and it is what stops the
 * confirmation being quietly deleted later by somebody tidying up a click.
 *
 * `pending` is a step rather than a spinner inside the confirm button, for the
 * reason `lib/tx.ts` gives: a block that is out and has not been read is neither
 * done nor failed, and on a launchpad that moment is exactly the one people
 * misread. It stays on screen until the poll that follows the action returns.
 *
 * The terms rendered at `intent` are the terms this panel read off the book, and
 * they travel with the quote as an `Expectation` taken from that same row. The
 * SDK re-reads the offer from the chain and checks both legs against them before
 * it signs anything (#6), so a book that went stale between the poll and the
 * click cannot change what the key agrees to. A mismatch arrives here as an
 * ordinary refusal, which `refused` puts back on the book with the sentence the
 * check produced — and the offer is still open, because nothing was signed.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { expectationFrom, type Offer } from 'kei-transaction'

import { formatCoins, formatPrice, rawOfKei, shortAddress } from '../shared/format'
import { coinAmount, keiAmount, unitPrice, type Listing } from '../shared/listing'
import {
  FUNNEL,
  FUNNEL_OPENING,
  chose,
  confirmed,
  dropped,
  landed,
  position,
  quoted,
  refused,
  reopened,
  says,
  unsigned,
  type Funnel,
  type Quote,
} from '../lib/funnel'
import { buyBlocker } from '../lib/refusals'
import { useMarket } from '../lib/use-market'
import { Ladder } from './OrderBook'

export function BuyFunnel({
  listing,
  asks,
  held,
  loading,
  onTraded,
  children,
}: {
  listing: Listing
  asks: readonly Offer[]
  held: number
  loading: boolean
  onTraded: () => void
  /** The bid form, shown wherever the book itself is. */
  children: React.ReactNode
}) {
  const { trader, funds, busy, act } = useMarket()
  const [funnel, setFunnel] = useState<Funnel>(FUNNEL_OPENING)
  const confirm = useRef<HTMLButtonElement>(null)
  const noteId = useId()

  // The book polls every two seconds. `quoted` only ever moves between the first
  // two steps, so an ask filled by somebody else cannot rewind a confirmation, a
  // block in flight, or a settled trade under the person reading it.
  useEffect(() => {
    if (loading && asks.length === 0) return
    setFunnel((current) => quoted(current, asks.length))
  }, [asks.length, loading])

  // The confirmation replaces the book inside the panel, so a keyboard visitor
  // who pressed Enter on a row would otherwise be left focused on nothing.
  useEffect(() => {
    if (funnel.step === 'intent') confirm.current?.focus()
  }, [funnel.step])

  const quote = funnel.quote
  const blocked = quote
    ? buyBlocker({
        listing,
        funds,
        total: rawOfKei(quote.kei),
        from: quote.from,
        you: trader?.address ?? null,
        busy,
      })
    : null

  const take = async (): Promise<void> => {
    if (!quote || blocked) return
    setFunnel(confirmed)
    const outcome = await act(
      'buy',
      `Buying ${formatCoins(quote.coins)} ${listing.symbol}`,
      async () => {
        await trader?.accept(quote.offer, quote.expect)
        onTraded()
      },
      { kei: -rawOfKei(quote.kei), coins: [[listing.asset, quote.coins]] },
    )
    setFunnel((current) =>
      !outcome.signed
        ? unsigned(current)
        : outcome.problem === null
          ? landed(current)
          : refused(current, outcome.problem),
    )
  }

  return (
    <div className="space-y-3">
      <Track funnel={funnel} listing={listing} noteId={noteId} />

      {funnel.step === 'intent' || funnel.step === 'pending' ? (
        <Terms
          funnel={funnel}
          listing={listing}
          blocked={blocked?.sentence ?? null}
          fix={blocked?.fix ?? null}
          confirmRef={confirm}
          onConfirm={() => void take()}
          onBack={() => setFunnel(dropped)}
        />
      ) : funnel.step === 'settled' ? (
        <Done funnel={funnel} listing={listing} onAgain={() => setFunnel(reopened)} />
      ) : (
        <>
          {funnel.problem && (
            <p className="rounded border border-down/50 bg-down/5 px-2.5 py-2 text-[11px] leading-relaxed text-down" role="alert">
              {funnel.problem}
            </p>
          )}
          <Ladder
            side="ask"
            listing={listing}
            offers={asks}
            held={held}
            loading={loading}
            onTraded={onTraded}
            choose={(offer) => setFunnel((current) => chose(current, quoteOf(offer, listing)))}
          />
          {children}
        </>
      )}
    </div>
  )
}

/** One offer as the terms somebody is agreeing to. */
function quoteOf(offer: Offer, listing: Listing): Quote {
  return {
    offer: offer.hash,
    coins: coinAmount(offer, listing.asset),
    kei: keiAmount(offer, listing.asset),
    unitPrice: unitPrice(offer, listing.asset),
    from: offer.from,
    expect: expectationFrom(offer),
  }
}

/**
 * Where the buy is, in order, in words.
 *
 * An ordered list rather than five styled divs, because the claim being made is
 * that these are steps with a sequence — and `aria-current="step"` is how that
 * claim is announced rather than implied by a colour. The sentence underneath is
 * one polite live region: it changes on every transition and an assertive one
 * would interrupt somebody mid-row.
 */
function Track({ funnel, listing, noteId }: { funnel: Funnel; listing: Listing; noteId: string }) {
  const said = says(funnel, listing.symbol)
  return (
    <div>
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-[9px] uppercase tracking-[0.08em]">
        {FUNNEL.map((step) => {
          const current = step === funnel.step
          const passed = position(step) < position(funnel.step)
          return (
            <li
              key={step}
              aria-current={current ? 'step' : undefined}
              className={
                current ? 'text-gold' : passed ? 'text-dim' : 'text-fainter/60'
              }
            >
              {position(step)}. {says({ ...funnel, step }, listing.symbol).label}
            </li>
          )
        })}
      </ol>
      <p id={noteId} aria-live="polite" className="mt-1.5 text-[11px] leading-relaxed text-dim">
        <span className="sr-only">
          Step {position(funnel.step)} of {FUNNEL.length}, {said.label}.{' '}
        </span>
        {said.sentence}
      </p>
    </div>
  )
}

/**
 * The terms, and the last moment before a signature.
 *
 * Every figure here is the one the confirmation will spend, printed rather than
 * summarised, because "confirm" over a total nobody restated is the shape every
 * mis-sold trade has.
 */
function Terms({
  funnel,
  listing,
  blocked,
  fix,
  confirmRef,
  onConfirm,
  onBack,
}: {
  funnel: Funnel
  listing: Listing
  blocked: string | null
  fix: string | null
  confirmRef: React.RefObject<HTMLButtonElement | null>
  onConfirm: () => void
  onBack: () => void
}) {
  const quote = funnel.quote
  if (!quote) return null
  const flight = funnel.step === 'pending'

  return (
    <div className="rounded-md border border-line-bright bg-raised p-3">
      <h3 className="text-sm font-semibold text-ink">
        {flight ? `Settling ${formatCoins(quote.coins)} ${listing.symbol}` : `Take this offer?`}
      </h3>

      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-[11px] tabular">
        <dt className="text-fainter">You get</dt>
        <dd className="text-right text-ink">
          {formatCoins(quote.coins)} {listing.symbol}
        </dd>
        <dt className="text-fainter">You pay</dt>
        <dd className="text-right text-ink">{formatPrice(quote.kei)} Kei</dd>
        <dt className="text-fainter">Each</dt>
        <dd className="text-right text-dim">{formatPrice(quote.unitPrice)} Kei</dd>
        <dt className="text-fainter">From</dt>
        <dd className="text-right text-dim" title={quote.from}>
          {shortAddress(quote.from, 4)}
        </dd>
      </dl>

      {blocked && !flight && (
        <p className="mt-2 font-mono text-[11px] leading-relaxed text-down" role="alert">
          {blocked}
          {fix && <span className="ml-1 text-fainter">{fix}</span>}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          ref={confirmRef}
          type="button"
          aria-disabled={blocked !== null || flight}
          className={`flex-1 rounded-md border border-up/60 bg-up/10 px-3 py-2 text-sm font-medium text-up transition-colors hover:bg-up/20 ${
            blocked || flight ? 'cursor-not-allowed opacity-40' : ''
          }`}
          onClick={() => (blocked || flight ? undefined : onConfirm())}
        >
          {flight ? 'Signed — waiting for a read' : 'Confirm the buy'}
        </button>
        <button
          type="button"
          disabled={flight}
          onClick={onBack}
          className="btn-quiet px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40"
        >
          Back
        </button>
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-fainter">
        {flight
          ? 'One `swap_accept` block moves both legs or neither (SPEC §9.2). Until a read returns it, this is settling and not a trade.'
          : 'Confirming signs one `swap_accept` block in this browser. Nothing has left it yet.'}
      </p>
    </div>
  )
}

/** The only step in which a buy is a fact, said as one. */
function Done({ funnel, listing, onAgain }: { funnel: Funnel; listing: Listing; onAgain: () => void }) {
  const said = says(funnel, listing.symbol)
  return (
    <div className="rounded-md border border-up/50 bg-up/5 p-3" role="status">
      <h3 className="text-sm font-semibold text-up">Settled</h3>
      <p className="mt-1.5 text-xs leading-relaxed text-dim">{said.sentence}</p>
      <button type="button" onClick={onAgain} className="btn-quiet mt-3 px-2.5 py-1 text-xs">
        Back to the book
      </button>
    </div>
  )
}
