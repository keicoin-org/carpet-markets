/**
 * Every line of Kei in the client. If you are here to learn the SDK, this is the
 * file — the rest of `app/` and `components/` is buttons and a chart.
 *
 * The shape worth noticing: the browser holds a wallet and signs with it. Buying
 * is not "tell the server I bought something", it is accepting an offer, which
 * is one block this key signs that moves both legs at once. Selling is not a
 * request, it is an offer this key writes and locks its own coins into. The
 * server cannot do either on a player's behalf, because it does not have the key
 * and never will (SPEC §6.3) — and in this version it could not even if it did,
 * because it is not a counterparty to anything.
 *
 * Framework note, since this is now a React app: nothing below imports React and
 * nothing below is a hook. The wallet is a module-level singleton created once,
 * because there is one wallet per browser and re-creating it per component would
 * be re-deriving a key on every render. `lib/use-market.ts` is where React finds
 * out that any of this happened.
 */

import { KEI_ASSET, keyPairFromSeed, signHash } from '@keicoin/core'
import {
  defaultSeedStore,
  Kei,
  KeiError,
  seedStoreKey,
  type Offer,
  type Settlement,
} from 'kei-transaction'

import type { Book, Holder, LaunchQuote, MarketFacts, TransferPolicy } from '../shared/listing'
import { cleanReply, replyHash, type Reply } from '../shared/social'

/**
 * Where the backend is, from the browser's point of view.
 *
 * Baked at build time rather than derived from `location`, which is what the
 * pre-React version did. Client-side routing broke that: resolving a relative
 * path against `/examples/carpet-markets/coin/` gives the coin directory, not
 * the mount, and every fetch 404s on exactly one route.
 */
const BASE = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/$/, '')

const at = (path: string): string => `${BASE}/${path}`

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
  /** Raw Kei this wallet holds. Confirmed: signed for, and spendable. */
  keiBalance(): Promise<bigint>
  /**
   * What has been sent to this wallet and not yet signed for.
   *
   * The other half of `sync()`, and the reason the balance above is not the
   * whole story. Read rather than inferred, so the page can say how much is on
   * its way without pretending it is already spendable.
   */
  incoming(): Promise<{ kei: bigint; arrivals: number }>
  facts(): Promise<MarketFacts>
  /** The order book and trade history for one coin. */
  book(asset: string): Promise<Book>
  /** Who holds it, of the accounts the registry knows to ask about. */
  holders(asset: string): Promise<Holder[]>
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
  /** The thread. Off-chain, unlike everything else here — see shared/social.ts. */
  replies(asset: string): Promise<Reply[]>
  /** Sign a reply with the wallet key and post it. */
  reply(asset: string, body: string): Promise<Reply>
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

    /**
     * Raw again, and for the same reason: this number is added to a balance and
     * shown beside it, so rounding it through a double would make the two
     * disagree by a dust amount on screen.
     *
     * Coin arrivals are counted but not summed. A count of assets is a number
     * that means something; a total across two different coins is not.
     */
    async incoming() {
      const waiting = await kei.client.node.receivables(kei.address)
      const raw = waiting.reduce(
        (total, arrival) => (arrival.asset === KEI_ASSET ? total + BigInt(arrival.amount) : total),
        0n,
      )
      return { kei: raw, arrivals: waiting.length }
    },

    facts: () => get<MarketFacts>('market/facts'),

    book: (asset) => get<Book>(`market/book?asset=${encodeURIComponent(asset)}`),

    holders: (asset) =>
      get<{ holders: Holder[] }>(`market/holders?asset=${encodeURIComponent(asset)}`).then((body) => body.holders),

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

    replies: (asset) =>
      get<{ replies: Reply[] }>(`market/replies?asset=${encodeURIComponent(asset)}`).then((body) => body.replies),

    /**
     * Sign the reply, then post it.
     *
     * The body is cleaned before it is hashed because the server cleans it
     * before checking the hash. Sign the raw text and a stray double space is an
     * invalid signature rather than a tidied reply.
     */
    async reply(asset, body) {
      const text = cleanReply(body)
      const at_ = Date.now()
      const hash = replyHash({ asset, body: text, at: at_ })
      const signature = await signHash(await privateKey(kei), hash)
      return post<Reply>('market/reply', { asset, author: kei.address, body: text, at: at_, signature })
    },

    async topUp() {
      await kei.faucet(25)
    },
  }
}

/**
 * The signing key for this browser's wallet.
 *
 * The seed is where SPEC §6.4 puts it — this browser's storage, never
 * transmitted — and the SDK exports the store and its key so an app can find it.
 * Deriving the pair is cheap but not free, so it is done once and kept.
 *
 * The address check is the part that matters. If a future SDK ever derives a
 * wallet at an index other than zero, signing blind would produce a valid
 * signature from the *wrong* account and the registry would reject every reply
 * with a message about impersonation. Failing here instead says the true thing.
 */
let keyed: Promise<string> | undefined

function privateKey(kei: Kei): Promise<string> {
  keyed ??= (async () => {
    const seed = defaultSeedStore().read(seedStoreKey(kei.network))
    if (!seed) throw new Error('This browser has no wallet seed to sign with.')

    const pair = await keyPairFromSeed(seed, 0)
    if (pair.address !== kei.address) {
      throw new Error('The wallet in this browser is not the account at index 0, so replies cannot be signed.')
    }
    return pair.privateKey
  })()
  return keyed
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
