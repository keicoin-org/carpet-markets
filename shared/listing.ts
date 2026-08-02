/**
 * What the market says about a coin, and the rules for saying it.
 *
 * This is the wire shape between the two halves. Numbers cross it as decimal
 * **strings**, never as JSON numbers: a raw Kei amount is a `bigint` on both
 * sides, and `JSON.stringify` would quietly round it into a lie somewhere around
 * the ninth significant figure.
 */

/**
 * Whether the deed to a coin can leave the hand that holds it.
 *
 * This is the only thing in the game that matters, so it is the only setting the
 * launch form has. See `server/market.ts` for what the deed actually is.
 */
export type ReserveLock =
  /** The deed is transferable. Whoever holds it can send it back and take the reserve. */
  | 'carpet'
  /** The deed is soulbound. It cannot be sent anywhere, so the reserve cannot be taken. */
  | 'nailed-down'

export type CoinState = 'trading' | 'graduated' | 'rugged'

export interface Listing {
  /** The chain's id for the coin. Derived from the issuer and the symbol. */
  asset: string
  symbol: string
  name: string
  blurb: string
  /** Who launched it. An address, and the only thing the market knows about them. */
  creator: string
  lock: ReserveLock
  /** The deed's asset id — the thing a creator sends back to rug. */
  deed: string
  state: CoinState
  /** Coins sold off the curve. Raw, and raw here means whole coins. */
  sold: string
  /** Raw Kei backing them. Recomputed from `sold`, never accumulated. */
  reserve: string
  /** Raw Kei the next single coin costs. */
  price: string
  /** Milliseconds since the epoch, for sorting and for the chart. */
  launchedAt: number
  /** Every trade, oldest first. Trimmed; the chain has the real history. */
  history: Tick[]
}

export interface Tick {
  at: number
  /** Supply after the trade. The chart plots price, which is derived from it. */
  sold: string
  kind: 'launch' | 'buy' | 'sell' | 'graduate' | 'rug'
}

export interface MarketFacts {
  /** The market's own address. Every payment and every deed goes here. */
  address: string
  network: string
  /** Raw Kei the next launch costs, because the burn escalates (SPEC §5.6.5). */
  launchFee: string
  /** How many assets the market has issued. The reason the fee is what it is. */
  issued: number
  /** Raw Kei reserve at which a coin graduates. */
  graduation: string
  listings: Listing[]
}

/** A launch the market has quoted but not yet been paid for. */
export interface LaunchQuote {
  /** Echoed back so the client can show what it is about to pay for. */
  symbol: string
  name: string
  /** Where to send the fee. */
  to: string
  /** Raw Kei. Pay at least this. */
  fee: string
}

export interface BuyQuote {
  asset: string
  to: string
  /** Raw Kei to send. Sending more buys more; sending less buys less. */
  cost: string
  /** Coins that much Kei buys right now. Advisory — the curve may move first. */
  coins: string
}

// ------------------------------------------------------------------ validation

/** Symbols are what the chain derives an asset id from, so they are strict. */
const SYMBOL = /^[A-Z][A-Z0-9]{1,9}$/

export class ListingError extends Error {}

/**
 * A coin's name and symbol, cleaned, or an error a person can act on.
 *
 * Run on the server, because the client is not the one that has to live with the
 * result, and run before anybody is charged, because the fee is not refundable —
 * the burn it pays for is not refundable either.
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

export function cleanLock(input: unknown): ReserveLock {
  if (input === 'carpet' || input === 'nailed-down') return input
  throw new ListingError(`A coin's reserve is either "carpet" or "nailed-down"; "${String(input)}" is neither.`)
}
