/**
 * The five states a first buy passes through, and the order they come in.
 *
 * A layout can afford a buy in a few clicks and still collapse the states that
 * make it comprehensible: the row a stranger clicked is the last time the terms
 * are on screen, the block goes out, and the next thing they see is a number
 * that changed. Criterion 1 of SPEC §9.6 is a buy in five interactions, and the
 * failure it does not catch is a buy in one interaction that nobody understood.
 *
 * So the path is a state machine rather than a set of conditions the panel
 * happens to render. Each step is reachable only from the one before it:
 *
 *   empty    Nothing is for sale. No trades yet, no reserve, and no button —
 *            somebody holding the coin has to write an offer first.
 *   quote    The book. Every row is one account's offer at its own price, and
 *            picking one is choosing a counterparty rather than hitting a curve.
 *   intent   The exact terms of the chosen offer, before anything is signed.
 *   pending  The block is out and no read has seen it. Visible on its own, not
 *            as a flicker inside the confirm button.
 *   settled  A read has seen it. The only step in which a buy is a fact.
 *
 * `chose` is the only way into `intent` and `confirmed` is the only way into
 * `pending`, so there is no path from a row straight to a signature. That is the
 * enforcement — a panel that forgot to render the confirmation cannot sign
 * either, and `test/funnel.test.ts` fails rather than the demo quietly losing a
 * step.
 *
 * Nothing here imports React, touches the network, or reads a clock.
 */

import type { Expectation } from 'kei-transaction'

import { formatCoins, formatPrice, shortAddress } from '../shared/format'

export type FunnelStep = 'empty' | 'quote' | 'intent' | 'pending' | 'settled'

/** In order. The indicator counts through this and so do the tests. */
export const FUNNEL: readonly FunnelStep[] = ['empty', 'quote', 'intent', 'pending', 'settled']

/** One offer, as the terms a person is agreeing to rather than as a block. */
export interface Quote {
  /** The `swap_offer` block being taken. */
  offer: string
  /** Whole units it hands over. */
  coins: number
  /** What the lot costs, in Kei. */
  kei: number
  /** Kei per unit, which is the number two rows are compared on. */
  unitPrice: number
  /** The account that wrote it. A counterparty, not a venue. */
  from: string
  /**
   * Both legs of the row that was rendered, as the SDK checks them.
   *
   * The figures above are formatted for a person and are lossy; this is not. It
   * is derived from the same `Offer` the ladder drew, at the moment it was
   * drawn, and it travels with the quote so that the terms `accept` asserts
   * against the chain are the terms that were on screen when somebody agreed —
   * not a later read of a book that is polled every two seconds (#6).
   */
  expect: Expectation
}

export interface Funnel {
  step: FunnelStep
  /** The offer being taken, from `intent` onward. Null everywhere else. */
  quote: Quote | null
  /** The ledger's own words when the last attempt did not settle. */
  problem: string | null
}

export const FUNNEL_OPENING: Funnel = { step: 'empty', quote: null, problem: null }

/** Whether the funnel has got at least as far as some step. */
export function reached(funnel: Funnel, step: FunnelStep): boolean {
  return FUNNEL.indexOf(funnel.step) >= FUNNEL.indexOf(step)
}

/** 1-based, for "step 3 of 5". */
export function position(step: FunnelStep): number {
  return FUNNEL.indexOf(step) + 1
}

/**
 * The book answered.
 *
 * Only ever moves between the first two steps. The book polls every two seconds
 * and an ask being filled by somebody else must not drag a confirmation, a block
 * in flight, or a settled trade backwards under the person looking at it.
 */
export function quoted(funnel: Funnel, offers: number): Funnel {
  if (funnel.step !== 'empty' && funnel.step !== 'quote') return funnel
  const step: FunnelStep = offers > 0 ? 'quote' : 'empty'
  return step === funnel.step ? funnel : { ...funnel, step, quote: null }
}

/** A row was picked. The only way into `intent`. */
export function chose(funnel: Funnel, quote: Quote): Funnel {
  if (funnel.step !== 'quote') return funnel
  return { step: 'intent', quote, problem: null }
}

/** Back to the book without signing. Nothing has left the browser. */
export function dropped(funnel: Funnel): Funnel {
  if (funnel.step !== 'intent') return funnel
  return { step: 'quote', quote: null, problem: null }
}

/** Confirmed. The only way into `pending`, and it needs terms to confirm. */
export function confirmed(funnel: Funnel): Funnel {
  if (funnel.step !== 'intent' || !funnel.quote) return funnel
  return { ...funnel, step: 'pending' }
}

/** A read has seen it. */
export function landed(funnel: Funnel): Funnel {
  if (funnel.step !== 'pending') return funnel
  return { ...funnel, step: 'settled' }
}

/**
 * It did not settle, and the ledger said why.
 *
 * Back to the book rather than back to the terms, because the two refusals that
 * actually happen here — somebody else took the offer, and the terms are no
 * longer the ones that were rendered — are both answered by reading the book
 * again rather than by pressing confirm harder.
 */
export function refused(funnel: Funnel, problem: string): Funnel {
  if (funnel.step !== 'pending') return funnel
  return { step: 'quote', quote: null, problem }
}

/** Nothing was signed, because the wallet was already busy. The terms stand. */
export function unsigned(funnel: Funnel): Funnel {
  if (funnel.step !== 'pending') return funnel
  return { ...funnel, step: 'intent' }
}

/** Buy again. */
export function reopened(funnel: Funnel): Funnel {
  if (funnel.step !== 'settled') return funnel
  return FUNNEL_OPENING
}

export interface Says {
  /** The step's name, as the indicator prints it. */
  label: string
  /** What is true at this step, in one sentence. */
  sentence: string
}

/**
 * What each step says on screen.
 *
 * Here rather than in the panel for the same reason `lib/refusals.ts` is: the
 * sentence somebody reads is the one a test asserts, and a step whose copy lived
 * in JSX could be reworded into meaning nothing without a single test noticing.
 */
export function says(funnel: Funnel, symbol: string): Says {
  const quote = funnel.quote
  switch (funnel.step) {
    case 'empty':
      return {
        label: 'nothing for sale',
        sentence: `No trades yet and nobody is selling ${symbol}. There is no reserve to buy from, so a holder has to write an offer before there is anything here to take.`,
      }
    case 'quote':
      return {
        label: 'pick a quote',
        sentence: `Every row is one account's offer, at its price, for its quantity. Picking one shows the exact terms before anything is signed.`,
      }
    case 'intent':
      return {
        label: 'confirm the terms',
        sentence: quote
          ? `${formatCoins(quote.coins)} ${symbol} for ${formatPrice(quote.kei)} Kei, ${formatPrice(quote.unitPrice)} each, from ${shortAddress(quote.from, 4)}. Nothing has been signed yet.`
          : 'No offer is chosen.',
      }
    case 'pending':
      return {
        label: 'settling',
        sentence: `The block is out. It is not a trade until a read has seen it, so this says settling rather than done.`,
      }
    case 'settled':
      return {
        label: 'settled',
        sentence: quote
          ? `${formatCoins(quote.coins)} ${symbol} are on your own chain, paid for in one block that moved both legs at once.`
          : 'The trade settled.',
      }
  }
}
