/**
 * Every line of Kei in the client. If you are here to learn the SDK, this is the
 * file — the rest of `src/` is buttons and a chart.
 *
 * The shape worth noticing: the browser holds a wallet and signs with it. Buying
 * is not "tell the server I bought something", it is a payment this key makes.
 * Selling is not a request, it is a transfer. Rugging is not an admin endpoint,
 * it is sending an item. The server cannot do any of those on a player's behalf,
 * because it does not have the key and never will (SPEC §6.3).
 */

import { Kei, KeiError, type Item } from 'kei-transaction'

import { formatKei } from '../shared/curve.js'
import type { BuyQuote, LaunchQuote, MarketFacts, ReserveLock } from '../shared/listing.js'

/** Resolves against the page, so the same bundle works at `/` and at a mount point. */
const at = (path: string): string => new URL(path, new URL('.', location.href)).toString()

export interface Trader {
  address: string
  network: string
  /**
   * Collect what has arrived.
   *
   * Coins the market minted are a *receivable* until this wallet signs for them
   * (SPEC §5.6.1) — they are owed, not held, and trying to sell them before
   * receiving them is refused by the ledger with "balance is 0", which is both
   * correct and confusing. Call this before reading balances, always.
   */
  sync(): Promise<void>
  /** Raw Kei this wallet holds. */
  keiBalance(): Promise<bigint>
  facts(): Promise<MarketFacts>
  /** Whole coins held, by asset id, for the coins asked about. */
  holdings(assets: readonly string[]): Promise<Map<string, bigint>>
  /** Items this wallet owns. The deeds are in here, and so is every badge. */
  items(): Promise<Item[]>
  launch(input: { symbol: string; name: string; blurb: string; lock: ReserveLock }): Promise<LaunchQuote>
  buy(asset: string, budget: bigint): Promise<BuyQuote>
  sell(asset: string, count: bigint): Promise<void>
  /** Send a deed back to the market. Soulbound deeds refuse, on the chain. */
  rug(deed: string): Promise<void>
  /** Pick up any commit proofs waiting, and write the claims. */
  collect(): Promise<number>
  /** Mock and testnet only, and allowed to fail. */
  topUp(): Promise<void>
}

export async function connect(): Promise<Trader> {
  // Created on first visit and persisted in this browser. No signup, no API key,
  // no dashboard, and no copy of it on the server.
  const kei = await Kei.start({ node: at('rpc'), network: 'mock' })

  // A visitor arriving at an empty wallet can do nothing at all, and this is a
  // chain where an empty wallet costs nothing to fill. Failing is fine: on a
  // network without a faucet the page still loads and the balance is simply what
  // it is.
  if ((await kei.balance()) <= 0) await kei.faucet(25).catch(() => undefined)

  /** The market's address, read once from the market rather than hardcoded. */
  let market = ''

  const facts = async (): Promise<MarketFacts> => {
    const value = await get<MarketFacts>('market/facts')
    market = value.address
    return value
  }

  const to = async (): Promise<string> => market || (await facts()).address

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

    async holdings(assets) {
      const held = new Map<string, bigint>()
      await Promise.all(
        assets.map(async (asset) => {
          const token = await kei.token(asset)
          held.set(asset, BigInt(Math.round(await token.balance())))
        }),
      )
      return held
    },

    items: () => kei.items.ownedBy(),

    /**
     * Ask for a listing, then pay for it.
     *
     * Two steps because a payment carries no memo: the market has to be told what
     * the money is for before it arrives, or it cannot tell this from a purchase.
     * The order is not the launch — nothing is issued until the fee lands, and
     * the fee is not refundable because the burn it pays for is not reversible.
     */
    async launch(input) {
      const quote = await post<LaunchQuote>('market/launch', { address: kei.address, ...input })
      await kei.pay({ to: quote.to, amount: formatKei(BigInt(quote.fee), 18) })
      return quote
    },

    async buy(asset, budget) {
      const quote = await post<BuyQuote>('market/buy', {
        address: kei.address,
        asset,
        budget: budget.toString(),
      })
      await kei.pay({ to: quote.to, amount: formatKei(budget, 18) })
      return quote
    },

    /**
     * Selling is one signature and no order.
     *
     * The market can price an arriving coin without being told anything, because
     * the asset id says which coin it is and the curve says what it is worth. The
     * asymmetry with buying is not an oversight — it is what a memo would have
     * fixed on the other side.
     */
    async sell(asset, count) {
      await kei.sync()
      const token = await kei.token(asset)
      await token.transfer(await to(), count.toString())
    },

    /**
     * The rug, which is a transfer.
     *
     * If the deed was minted soulbound this throws before anything is sent, and
     * the message comes from the ledger's rules rather than from a policy the
     * market chose to keep today.
     */
    async rug(deed) {
      await kei.sync()
      await kei.items.transfer(deed, await to())
    },

    /**
     * Collect what a graduation owed this wallet.
     *
     * The market published one block covering every holder; this wallet writes
     * its own claim, from its own chain, against that root (SPEC §5.5). A mint
     * per holder would have put the whole market behind one account's chain.
     *
     * Claiming twice is not guarded here on purpose — the ledger's double-claim
     * index refuses the second one, so the client does not have to be careful.
     */
    async collect() {
      const { bundles } = await get<{ bundles: unknown[] }>(`market/claims?address=${kei.address}`)
      let written = 0
      for (const bundle of bundles) {
        try {
          await kei.claims.add(bundle as Parameters<typeof kei.claims.add>[0])
          written += 1
        } catch {
          // Already claimed. Which is the answer, not a failure.
        }
      }
      return written
    },

    async topUp() {
      await kei.faucet(25)
    },
  }
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
  if (!response.ok) throw new Error(body.error ?? `The market answered ${response.status}.`)
  return body as T
}

/** SDK errors already read as sentences; this keeps everything else from not. */
export function explain(error: unknown): string {
  if (error instanceof KeiError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}
