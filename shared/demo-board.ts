/**
 * The six-coin demo board: which coins exist on a fresh chain and what is quoted
 * on each of them.
 *
 * There were two copies of this, one in `scripts/seed.ts` for a local `bun run
 * dev` and one in `server/demo.ts` for the Worker's replay, and they had already
 * drifted apart on UNDERLAY's bids. Worse, neither of them knew what the faucet
 * pays, so the cheapest lot left open on the first coin the board called
 * "buyable now" cost 66 Kei against a 25 Kei grant and the page's leading
 * affordance took a new visitor to a refusal (#18). There is one copy now, and
 * `test/first-buy.test.ts` checks it against `shared/faucet.ts`.
 *
 * Nothing here is a fixture. It is a list of ordinary wallet operations: real
 * launch fees, real `swap_offer` blocks, real accepts. The registry cannot tell
 * them from a visitor's, which is the point — if it could, the board would be
 * showing something other than what it claims to show.
 */

import type { TransferPolicy } from './listing.js'

export interface Ask {
  units: number
  /** Kei per unit. The lot costs `units * each`. */
  each: number
}

export interface BoardPlan {
  symbol: string
  name: string
  blurb: string
  transfer: TransferPolicy
  /** Fractions of the supply the creator lists, in order, each at its own price. */
  asks: Ask[]
  /** How many of those asks the seeded counterparty takes, from the front. */
  filled: number
  bids: Ask[]
  replies: string[]
}

/**
 * Six coins that between them cover every state the board can be in.
 *
 * Chosen for coverage rather than for jokes: one never traded, one mid-dump, one
 * with both sides quoted, one soulbound, one issuer-only, one with nothing for
 * sale but a price in its history. A board where every card looks the same
 * proves nothing about the cards.
 *
 * Every coin with an ask left open also has one a single faucet press covers —
 * asserted in `test/first-buy.test.ts`, because a book whose smallest clip costs
 * more than any new wallet holds is a book only the seeded counterparty can
 * trade in, and a launchpad demonstrating a peer-to-peer order book that no peer
 * can reach is demonstrating the wrong thing.
 */
export const DEMO_BOARD: readonly BoardPlan[] = [
  {
    symbol: 'KILIM',
    name: 'Kilim',
    blurb: 'Flat-woven, reversible, and so is the position.',
    transfer: 'open',
    asks: [
      { units: 40_000, each: 0.0004 },
      { units: 25_000, each: 0.0006 },
      // 7.2 Kei, so a wallet that has pressed the faucet once can take it. A
      // small clip alongside a large one is what an order book looks like
      // anyway; the version of this board that had only the 66 Kei lot left
      // open was a book only the seeded counterparty could trade in.
      { units: 8_000, each: 0.0009 },
      { units: 60_000, each: 0.0011 },
    ],
    filled: 2,
    bids: [{ units: 20_000, each: 0.0003 }],
    replies: ['weaving, not selling', 'the creator has moved 65k units. it is on the chart.'],
  },
  {
    symbol: 'UNDERLAY',
    name: 'Underlay',
    blurb: 'Nobody thinks about it until they are standing on nothing.',
    transfer: 'open',
    asks: [{ units: 300_000, each: 0.00008 }],
    filled: 1,
    bids: [
      { units: 50_000, each: 0.00005 },
      { units: 120_000, each: 0.00003 },
    ],
    replies: ['300k in one clip. that is a third of the supply.'],
  },
  {
    symbol: 'FRINGE',
    name: 'Fringe',
    blurb: 'The part that frays first.',
    transfer: 'open',
    asks: [{ units: 5_000, each: 0.002 }],
    filled: 0,
    bids: [],
    replies: [],
  },
  {
    symbol: 'WARP',
    name: 'Warp',
    blurb: 'Traded once, and nobody is offering since.',
    transfer: 'open',
    asks: [{ units: 10_000, each: 0.00035 }],
    filled: 1,
    bids: [],
    replies: [],
  },
  {
    symbol: 'HEIRLOOM',
    name: 'Heirloom',
    blurb: 'Soulbound. It cannot be sold, by anybody, including whoever made it.',
    transfer: 'none',
    asks: [],
    filled: 0,
    bids: [],
    replies: ['this one genuinely cannot be dumped on you. the ledger says so.'],
  },
  {
    symbol: 'BAZAAR',
    name: 'Bazaar Credit',
    blurb: 'Issuer-only. Whatever market it has, the issuer is the whole of it.',
    transfer: 'issuer-only',
    asks: [],
    filled: 0,
    bids: [],
    replies: [],
  },
]

/** What a lot costs the buyer, in Kei. This is the number that has to clear a wallet. */
export function lotCost(ask: Ask): number {
  return ask.units * ask.each
}

/**
 * The asks still on the book after the seeded counterparty has taken its fill.
 *
 * From the front, because that is the order `filled` consumes them in — not the
 * cheapest, which is the order the book displays them in.
 */
export function openAsks(plan: BoardPlan): Ask[] {
  return plan.asks.slice(plan.filled)
}
