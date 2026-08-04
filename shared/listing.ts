/**
 * What the registry says about a coin, and the rules for saying it.
 *
 * This is the wire shape between the two halves, and it is deliberately thin.
 * The registry knows which coins exist and who to read; it does not know what
 * anything is worth. Prices, order books, and trade history are read from the
 * chain by `@keicoin/market`, on whichever side is asking.
 *
 * Amounts here are plain decimal numbers, matching the SDK's own posture
 * (SPEC §6.1) and the `@keicoin/market` API these values are handed to. That
 * costs precision at the far end of a double, which is fine for a price and
 * would not be for a balance — so no balance crosses this file. Balances come
 * from `balanceOf`, on the chain, in one call.
 */

import type { Offer, PriceSummary, Trade } from 'kei-transaction'

import type { NetworkFacts } from './network.js'

/**
 * Who may move a coin's units, chosen at issuance and immutable after
 * (SPEC §5.4). This is the whole argument of this example.
 *
 * It is not a label the registry applies and could edit. It is a protocol flag
 * the node validates every transfer against, which is why the three options
 * below are three different *markets* rather than three different promises:
 *
 *   open        Units move between any two accounts, so a peer-to-peer order
 *               book exists and cannot be switched off. Including by the
 *               creator, who holds the supply at launch and can sell it into
 *               that book at whatever pace they like. There is no version of
 *               this where the market is real and that risk is not.
 *   issuer-only Units move only to or from the issuer. No order book can exist,
 *               because a `swap_offer` between two holders is an invalid block.
 *               The issuer is the only counterparty there will ever be.
 *   none        Soulbound. Nothing moves, so nothing trades, ever.
 */
export type TransferPolicy = 'open' | 'issuer-only' | 'none'

export interface Listing {
  /** The chain's id for the coin, derived from its issuer and its symbol. */
  asset: string
  symbol: string
  name: string
  blurb: string
  /**
   * The account that issued this coin, and the only one that could ever mint
   * more. One per coin — see `server/registry.ts` for why.
   */
  issuer: string
  /** Who paid for the launch and received the whole supply. */
  creator: string
  transfer: TransferPolicy
  /** Whole units minted at launch. Coins have no decimals. */
  supply: number
  /** Milliseconds since the epoch. For sorting, and for the age column. */
  launchedAt: number
  /** Absent until the registry has managed to read them once. */
  stats?: ListingStats
}

/**
 * A coin's order book and what it has actually traded for.
 *
 * Both halves are read from the chains of the accounts the registry knows about
 * (`ListOptions.from` is required, and SPEC §9.4 explains why: an offer lives on
 * its author's chain, so "every offer on the network" is an indexer and Kei does
 * not ship one). The registry's real job is being the list of accounts to read.
 */
export interface Book {
  asset: string
  /** Open offers giving this coin, cheapest first. */
  asks: Offer[]
  /** Open offers wanting this coin, best price first. */
  bids: Offer[]
  /** Settled offers, newest last. This is the price history — it is the trades. */
  trades: Trade[]
  /** Null until the coin has traded once. */
  price: PriceSummary | null
}

/**
 * The handful of numbers a coin card shows, so the board is worth looking at.
 *
 * These ride along with the listing because the alternative is what the first
 * version of this page did: fetch a full book per coin to fill in one line of
 * card text, or show nothing. It showed nothing, and a launchpad where every
 * tile reads "1,000,000 supply" and stops is not a board, it is a list.
 *
 * The registry caches these — see `SUMMARY_TTL_MS` — because they cost a chain
 * read per coin and every open tab asks for them on the same two-second beat.
 */
export interface ListingStats {
  /** Kei per unit, from the last settled trade. Null until it has traded once. */
  last: number | null
  /** Settled trades, ever. */
  trades: number
  /** Accounts holding a non-zero balance, of those the registry can see. */
  holders: number
  replies: number
  /**
   * Open offers somebody could accept this second.
   *
   * On the board rather than one click in, because "is anybody selling" is a
   * different question from "has anybody sold" and a launchpad that only answers
   * the second sends people to a page with an empty book. It is also the honest
   * asymmetry of a market with no market maker: there is always something to
   * sell into a curve and there is not always somebody to buy from here.
   */
  asks: number
  /** The cheapest open ask, in Kei per unit. Null when nobody is selling. */
  bestAsk: number | null
  /**
   * Whole units the launcher is still sitting on.
   *
   * The single most predictive number on the board and the reason it is computed
   * for every card rather than on demand. A creator was minted the entire supply
   * at launch, so this starts at 100% and only falls when they sell — which
   * means a coin whose chart is climbing while this stays at 100% has a rally
   * nobody has taken profit into yet, and one where it is falling fast is a
   * distribution in progress with the price still up.
   *
   * On an `issuer-only` or soulbound coin it never moves, because nothing can.
   */
  creatorHolds: number
}

/**
 * One account's stake in a coin, read off the chain with `balanceOf`.
 *
 * The list is only as complete as the registry's set of accounts to read, which
 * is the same limit the order book has and for the same reason (SPEC §9.4). A
 * holder who has never announced themselves is missing from this and present on
 * the chain — so the percentages below are of the supply, never of the rows,
 * and a total under 100% is the honest answer rather than a rounding bug.
 */
export interface Holder {
  address: string
  /** Whole units. Coins have no decimals. */
  amount: number
  /** True for the account that was minted the entire supply at launch. */
  creator: boolean
  /** True for the coin's own issuing account, which holds nothing after mint. */
  issuer: boolean
}

export interface MarketFacts {
  /** The registry's own address. Launch fees go here; nothing else does. */
  address: string
  /**
   * Which chain is underneath, reported rather than compiled in.
   *
   * The client renders this in the bar and on the network panel, and it is the
   * one fact on the page that must never be guessed: a badge derived from a
   * build-time constant would still say "mock" the first time somebody served
   * the same bundle against a real node. See `shared/network.ts`.
   */
  chain: NetworkFacts
  /**
   * Raw Kei a launch costs, as a decimal string.
   *
   * Flat, and it stays flat however many coins the registry has listed. The
   * escalating issuance burn (SPEC §5.6.5) is charged per issuing account, and
   * every coin here gets its own — so a launch always pays that account's first
   * and second burn, and never anybody else's.
   */
  launchFee: string
  /**
   * What the fee is made of, from the constants that charge it.
   *
   * The launch screen used to print "1 Kei" and "0.1 Kei" as literal strings
   * beside a total it computed, so the breakdown was a caption rather than a
   * statement — it would have kept saying 1 Kei if `issuanceBurn` ever answered
   * something else, and nothing would have failed. These are the same two
   * bigints the registry actually sends, serialised.
   */
  launchFeeParts: {
    /** The burn, which is destroyed rather than collected (SPEC §5.6.5). */
    burn: string
    /** Left on the new issuing account so it can still sign after paying it. */
    margin: string
  }
  listings: Listing[]
}

/** A launch the registry has quoted and not yet been paid for. */
export interface LaunchQuote {
  symbol: string
  name: string
  /** Where to send the fee. */
  to: string
  /** Decimal Kei. Pay at least this; change comes back. */
  fee: string
}

// ------------------------------------------------------------- reading an offer

/** The two amounts in an offer, whichever way up it was written. */
interface TwoSided {
  give: { asset: string; amount: number }
  want: { asset: string; amount: number }
  price: number
}

/**
 * Kei per one unit of a coin, whichever leg the coin is on.
 *
 * `Offer.price` is `want.amount` per one unit of `give`, which is the price
 * everybody means on an ask — the seller gives coins and wants Kei. On a **bid**
 * the legs are the other way up: the bidder gives Kei and wants coins, so the
 * SDK's `price` is *coins per Kei*, and rendering it in a column headed "each"
 * puts 3,333 next to 0.0003 and reads as a coin worth three thousand times its
 * asking price.
 *
 * This is the single place that inversion is undone. Every ladder row, spread,
 * card figure, sort and history line goes through it, because the one thing
 * worse than an inverted price is two of them disagreeing.
 *
 * Note that `PriceSummary` from the SDK needs no correction — `summarise` already
 * normalises both directions. It is the raw `price` on an `Offer` or a `Trade`
 * that is direction-dependent.
 */
export function unitPrice(offer: TwoSided, asset: string): number {
  if (offer.give.asset === asset) return offer.price
  if (offer.want.amount <= 0) return 0
  return offer.give.amount / offer.want.amount
}

/** Units of the coin in an offer, on whichever leg it sits. */
export function coinAmount(offer: TwoSided, asset: string): number {
  return offer.give.asset === asset ? offer.give.amount : offer.want.amount
}

/** The Kei leg: what a buyer hands over on an ask, what a seller collects on a bid. */
export function keiAmount(offer: TwoSided, asset: string): number {
  return offer.give.asset === asset ? offer.want.amount : offer.give.amount
}

// ------------------------------------------------------------------ validation

/** Symbols are what the chain derives an asset id from, so they are strict. */
const SYMBOL = /^[A-Z][A-Z0-9]{1,9}$/

/**
 * Units minted at launch, all of them to the creator.
 *
 * One number rather than a form field, because a launchpad where the creator
 * chooses their own allocation is a launchpad where the interesting number is
 * hidden in a field nobody reads. Here everyone starts holding everything, and
 * what happens next is visible in the book.
 */
export const LAUNCH_SUPPLY = 1_000_000

export class ListingError extends Error {}

/**
 * A coin's name and symbol, cleaned, or an error a person can act on.
 *
 * Run on the server, because the client is not the one that has to live with the
 * result, and run before anybody is charged, because the fee pays for a burn and
 * a burn is not refundable.
 */
export function cleanIdentity(input: { symbol?: unknown; name?: unknown; blurb?: unknown }): {
  symbol: string
  name: string
  blurb: string
} {
  const symbol = String(input.symbol ?? '')
    .trim()
    .toUpperCase()
  if (!SYMBOL.test(symbol)) {
    throw new ListingError(
      `"${symbol}" is not a symbol. Two to ten characters, letters and digits, starting with a letter — like DOGE or WAGMI9.`,
    )
  }

  const name = String(input.name ?? '').trim()
  if (name.length < 2 || name.length > 40) {
    throw new ListingError(`A coin's name is 2 to 40 characters; "${name}" is ${name.length}.`)
  }

  const blurb = String(input.blurb ?? '').trim()
  if (blurb.length > 140) {
    throw new ListingError(`The blurb is 140 characters at most; that one is ${blurb.length}.`)
  }

  return { symbol, name, blurb }
}

export function cleanTransfer(input: unknown): TransferPolicy {
  if (input === 'open' || input === 'issuer-only' || input === 'none') return input
  throw new ListingError(
    `A coin's transfer policy is "open", "issuer-only", or "none"; "${String(input)}" is none of them.`,
  )
}
