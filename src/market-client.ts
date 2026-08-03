/**
 * Every line of Kei in the client. If you are here to learn the SDK, this is the
 * file — the rest of `src/` is buttons and a chart.
 *
 * The shape worth noticing: the browser holds a wallet and signs with it. Buying
 * is not "tell the server I bought something", it is accepting an offer, which
 * is one block this key signs that moves both legs at once. Selling is not a
 * request, it is an offer this key writes and locks its own coins into. The
 * server cannot do either on a player's behalf, because it does not have the key
 * and never will (SPEC §6.3) — and in this version it could not even if it did,
 * because it is not a counterparty to anything.
 */

import { Kei, KeiError, type Offer, type Settlement } from 'kei-transaction'

import { formatKei } from '../shared/format.js'
import type { Book, LaunchQuote, MarketFacts, TransferPolicy } from '../shared/listing.js'

/** Resolves against the page, so the same bundle works at `/` and at a mount point. */
const at = (path: string): string => new URL(path, new URL('.', location.href)).toString()

export interface Trader {
  address: string
  network: string
  /**
   * Collect what has arrived.
   *
   * Coins are a *receivable* until this wallet signs for them (SPEC §5.6.3) —
   * they are owed, not held, and trying to sell them before receiving them is
   * refused by the ledger with "balance is 0", which is both correct and
   * confusing. Call this before reading balances, always.
   */
  sync(): Promise<void>
  /** Raw Kei this wallet holds. */
  keiBalance(): Promise<bigint>
  facts(): Promise<MarketFacts>
  /** The order book and trade history for one coin. */
  book(asset: string): Promise<Book>
  /** Whole coins held, by asset id, for the coins asked about. */
  holdings(assets: readonly string[]): Promise<Map<string, number>>
  launch(input: { symbol: string; name: string; blurb: string; transfer: TransferPolicy }): Promise<LaunchQuote>
  /**
   * List coins for sale: how many, and what to ask for the lot.
   *
   * Both numbers are the seller's, which is the whole difference from a bonding
   * curve. Selling a hundred thousand coins at once and selling a thousand of
   * them ten times are both available, and choosing the second is how somebody
   * unloads a position without printing what they are doing in one candle.
   */
  sell(asset: string, amount: number, unitPrice: number): Promise<Offer>
  /** Take somebody's offer. One block, both legs or neither (SPEC §9.2). */
  accept(offer: string): Promise<Settlement>
  /** Take back your own unaccepted offer, and the coins with it. */
  cancel(offer: string): Promise<void>
  /** This wallet's own open offers, across every coin. */
  mine(): Promise<Offer[]>
  /** Mock and testnet only, and allowed to fail. */
  topUp(): Promise<void>
}

export async function connect(): Promise<Trader> {
  // Created on first visit and persisted in this browser. No signup, no API key,
  // no dashboard, and no copy of it on the server.
  const kei = await Kei.start({ node: at('rpc'), network: 'mock' })

  // A visitor arriving at an empty wallet can do nothing at all, and this is a
  // chain where an empty wallet costs nothing to fill.
  if ((await kei.balance()) <= 0) await kei.faucet(25).catch(() => undefined)

  // The registry cannot see a settlement it was not part of, so a wallet that
  // intends to trade says so once. Everything it writes after this is readable
  // by anybody who asks the registry who to read — including this wallet, which
  // is how its own offers come back in the book.
  await post('market/watch', { address: kei.address }).catch(() => undefined)

  const facts = async (): Promise<MarketFacts> => get<MarketFacts>('market/facts')

  return {
    address: kei.address,
    network: kei.network,

    async sync() {
      await kei.sync()
    },

    async keiBalance() {
      // Read raw off the account rather than through `balance()`, which answers
      // in a JS number and cannot hold eighteen decimal places.
      return BigInt(await kei.client.node.accountInfo(kei.address).then((info) => info?.balance ?? '0'))
    },

    facts,

    book: (asset) => get<Book>(`market/book?asset=${encodeURIComponent(asset)}`),

    async holdings(assets) {
      const held = new Map<string, number>()
      await Promise.all(
        assets.map(async (asset) => {
          const token = await kei.token(asset)
          held.set(asset, await token.balance())
        }),
      )
      return held
    },

    /**
     * Ask for a listing, then pay for it.
     *
     * Two steps because a payment carries no memo: the registry has to be told
     * what the money is for before it arrives, or it cannot tell this from
     * anything else. Nothing is issued until the fee lands, and the fee is not
     * refundable because the burn it pays for is not reversible.
     */
    async launch(input) {
      const quote = await post<LaunchQuote>('market/launch', { address: kei.address, ...input })
      await kei.pay({ to: quote.to, amount: quote.fee })
      return quote
    },

    /**
     * One `swap_offer`, which locks the coins out of this wallet until somebody
     * accepts it or this wallet cancels it. Nobody can move them in the meantime,
     * including whoever issued them.
     *
     * `price` in the SDK is the total ask for the whole lot, so a per-unit price
     * gets multiplied here. Getting that backwards is an offer priced by a factor
     * of `amount`, which on a coin like this is several orders of magnitude.
     */
    async sell(asset, amount, unitPrice) {
      await kei.sync()
      return kei.market.sell({ asset, amount, price: amount * unitPrice })
    },

    accept: (offer) => kei.market.accept(offer),

    async cancel(offer) {
      await kei.market.cancel(offer)
    },

    mine: () => kei.market.mine({ state: 'open' }),

    async topUp() {
      await kei.faucet(25)
    },
  }
}

/**
 * An error as a sentence somebody can act on.
 *
 * `KeiError` messages already state their own fix (SPEC §6.1), so the SDK's are
 * passed straight through. It is the ledger's refusals that matter most here —
 * "this coin cannot be transferred" is the demo working, not the demo breaking.
 */
export function explain(error: unknown): string {
  if (error instanceof KeiError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

// ------------------------------------------------------------------- transport

async function get<T>(path: string): Promise<T> {
  return unwrap<T>(await fetch(at(path)))
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return unwrap<T>(
    await fetch(at(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

async function unwrap<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok) throw new Error(body.error ?? `The registry answered ${response.status}.`)
  return body as T
}

export { formatKei }
