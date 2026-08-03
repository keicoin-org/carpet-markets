/**
 * The registry. This file is the whole backend, and it is smaller than it was.
 *
 * It used to be a market: it held a bonding curve, minted on every buy, burned
 * on every sell, and paid people out of a reserve it custodied. That made it the
 * counterparty to every trade, which is the opposite of what this project is
 * for — a server that holds the float and sets the price is exactly the payment
 * infrastructure Kei exists to remove (SPEC §5.2).
 *
 * So it does not price anything now. Trades are `swap_offer`/`swap_accept`
 * between two players, written on their own chains and settled in one block by
 * consensus (SPEC §9.2). The registry never sees a coin, never holds a reserve,
 * and cannot move anybody's money.
 *
 * ## What is actually left for it to do
 *
 * Two things, and both are things a chain deliberately does not do.
 *
 * 1. **Issue.** A coin needs an issuing account, and issuance burns Kei
 *    (SPEC §5.6.5). See `launch` for why every coin gets its own account.
 * 2. **Be the list of who to read.** `market.offers()` requires a `from`: an
 *    offer lives on its author's chain, so "every offer on the network" is an
 *    indexer, and SPEC §9.4 says Kei does not ship one. Somebody has to remember
 *    which accounts have ever touched a coin. That is this, and it is honest
 *    about being an index rather than an oracle — everything it reports is read
 *    back off the chain and would be identical if you read it yourself.
 *
 * It holds a seed, so it cannot run in a browser (SPEC §6.3).
 */

import {
  Kei,
  issuanceBurn,
  type KeiNode,
  type NetworkName,
  type Offer,
  type Trade,
} from 'kei-transaction'

import { formatKei, KEI_RAW } from '../shared/format.js'
import {
  cleanIdentity,
  cleanTransfer,
  LAUNCH_SUPPLY,
  ListingError,
  type Book,
  type LaunchQuote,
  type Listing,
  type MarketFacts,
  type TransferPolicy,
} from '../shared/listing.js'

export interface RegistryOptions {
  seed: string
  node: KeiNode | string
  network?: NetworkName
  /** How long a quote waits for its payment before it is forgotten. */
  intentTtlMs?: number
}

export interface Registry {
  address: string
  facts(): Promise<MarketFacts>
  /** Quote a launch. Nothing is issued until the fee arrives. */
  quoteLaunch(creator: string, input: unknown): Promise<LaunchQuote>
  listing(asset: string): Listing | undefined
  /** The order book and the trade history, both read off the chain. */
  book(asset: string): Promise<Book>
  /**
   * Tell the registry an address is worth reading.
   *
   * A buyer who accepts an offer becomes somebody whose chain may hold the next
   * one, and the registry cannot discover that by itself — it never sees the
   * settlement. So the client says so. Being wrong is cheap in one direction
   * (an account with no offers contributes nothing) and invisible in the other
   * (an unknown account's offers are simply not listed, exactly as they would
   * not be by any other reader who had not heard of them either).
   */
  watch(address: string): void
  close(): void
}

export class RegistryError extends Error {}

const DEFAULT_INTENT_TTL_MS = 120_000

/**
 * What a launch costs, and why it is a constant.
 *
 * A launch issues one asset from a brand new account, so it pays that account's
 * *first* burn — 1 Kei — and nothing else. It does not matter whether it is the
 * first coin on the registry or the ten thousandth.
 *
 * This is the fix for a real bug. The escalating burn in SPEC §5.6.5 is charged
 * per *account*, and its stated purpose is that one account cannot cheaply
 * create a great many permanent asset records. An earlier version of this file
 * issued every coin from the registry's own account, which turned a per-account
 * anti-spam rule into a per-arrival tax: the fiftieth visitor paid for the
 * forty-nine launches before theirs, a newcomer's *first* coin was the most
 * expensive thing on the site, and the whole registry became unusable somewhere
 * around the thousandth coin. Its own comment called that the anti-spam
 * mechanism. It was not; it was the bug.
 *
 * A fresh account per coin restores the shape the spec intended, and costs
 * nothing to arrange: an account is a keypair, and `Kei.server({ seed, index })`
 * derives them from the one seed this process already holds.
 */
const LAUNCH_BURN_RAW = issuanceBurn(0)

/** On top of the burn, so the new issuer can still sign after paying it. */
const LAUNCH_MARGIN_RAW = KEI_RAW / 10n

export const LAUNCH_FEE_RAW = LAUNCH_BURN_RAW + LAUNCH_MARGIN_RAW

/** What the registry wants in hand before it will sign anything. */
const WORKING_CAPITAL_RAW = 25n * KEI_RAW

/**
 * How far under a quote a payment may land and still count. 0.00000001 Kei.
 *
 * `PaymentEvent.amount` is a JS `number`, and a double cannot hold eighteen
 * decimal places: a fee of exactly 1.1 Kei is reported as 1.0999999999999999.
 * An exact-equality check on an arriving amount quietly rejects real payments,
 * which is worth knowing before you write the same check in your own
 * integration.
 */
const DUST_RAW = 10_000_000_000n

interface Coin extends Listing {
  /** Kept so the coin could ever be minted again. It never is, today. */
  issuerWallet: Kei
}

interface Intent {
  at: number
  symbol: string
  name: string
  blurb: string
  transfer: TransferPolicy
}

export async function startRegistry(options: RegistryOptions): Promise<Registry> {
  const kei = await Kei.server({
    seed: options.seed,
    node: options.node,
    ...(options.network === undefined ? {} : { network: options.network }),
  })

  const ttl = options.intentTtlMs ?? DEFAULT_INTENT_TTL_MS

  const coins = new Map<string, Coin>()
  const intents = new Map<string, Intent>()
  /**
   * Every account whose chain might carry an offer.
   *
   * Creators are in here because they were minted the supply; buyers add
   * themselves through `watch`. This set is the entire reason the registry
   * exists, and it is the one piece of state that is not on the chain.
   */
  const traders = new Set<string>([kei.address])
  /** The next seed index to derive an issuer at. 0 is the registry itself. */
  let nextIndex = 1
  const writes = new Queue()

  // Working capital. Launch fees cover their own burns, but an account with an
  // empty balance cannot fund the first issuer it derives, and on a real network
  // somebody funds this address once instead. A faucet that is not there is not
  // an error.
  if ((await rawBalance(kei.address)) < WORKING_CAPITAL_RAW) {
    await kei.faucet(formatKei(WORKING_CAPITAL_RAW, 18)).catch(() => undefined)
  }

  async function rawBalance(address: string): Promise<bigint> {
    const info = await kei.client.node.accountInfo(address)
    return info ? BigInt(info.balance) : 0n
  }

  // ------------------------------------------------------------------ payments

  const stopPayments = kei.onPayment((payment) => {
    const intent = take(payment.from)
    // Kei answering no quote stays here. An unmatched arrival is
    // indistinguishable from the faucet topping this account up, and a registry
    // that reflexively returned money to whoever sent it would return its own
    // working capital on startup.
    if (!intent) return

    const paid = rawOf(payment.amount)
    void writes.run(() =>
      paid + DUST_RAW < LAUNCH_FEE_RAW
        ? refund(payment.from, paid, 'that is less than the launch fee')
        : launch(payment.from, intent, paid),
    )
  })

  // ------------------------------------------------------------------- actions

  /**
   * Issue the coin from an account of its own, and hand the creator all of it.
   *
   * The creator receives the entire supply, which is the honest starting state
   * for a launchpad and the one this example is about: whoever launched it holds
   * everything, and every coin anybody else ends up with came out of that pile
   * through an offer somebody accepted. Whether that pile can move at all is
   * `transfer`, and the node decides it, not this file.
   */
  async function launch(creator: string, intent: Intent, paid: bigint): Promise<void> {
    const index = nextIndex++
    const issuer = await Kei.server({
      seed: options.seed,
      index,
      node: options.node,
      ...(options.network === undefined ? {} : { network: options.network }),
    })

    // The burn comes out of the issuer's own balance, so it has to be there
    // before the issue block is signed.
    await kei.send(issuer.address, formatKei(LAUNCH_BURN_RAW + LAUNCH_MARGIN_RAW, 18))
    await issuer.sync()

    const token = await issuer.token.issue({
      name: intent.name,
      symbol: intent.symbol,
      decimals: 0,
      maxSupply: LAUNCH_SUPPLY,
      transfer: intent.transfer,
      description: intent.blurb,
    })
    await token.mint(creator, LAUNCH_SUPPLY)

    coins.set(token.id, {
      asset: token.id,
      symbol: intent.symbol,
      name: intent.name,
      blurb: intent.blurb,
      issuer: issuer.address,
      creator,
      transfer: intent.transfer,
      supply: LAUNCH_SUPPLY,
      launchedAt: Date.now(),
      issuerWallet: issuer,
    })
    traders.add(creator)

    const change = paid - LAUNCH_FEE_RAW
    if (change > 0n) await pay(creator, change)
  }

  // ------------------------------------------------------------- reading back

  /**
   * The book, assembled out of the chains of everybody we know about.
   *
   * Nothing here is the registry's opinion. `market.offers` reads `swap_offer`
   * blocks; `market.trades` reads the `swap_accept` blocks that consumed them.
   * A reader with the same list of accounts gets the same answer without asking
   * this server anything, which is the property worth having.
   */
  async function book(asset: string): Promise<Book> {
    const coin = coins.get(asset)
    if (!coin) throw new ListingError('That coin is not listed here.')

    const from = [...traders]
    const [giving, wanting, trades, price] = await Promise.all([
      kei.market.offers({ from, asset, state: 'open' }),
      kei.market.offers({ from, want: asset, state: 'open' }),
      kei.market.trades({ from, asset }),
      // `from` matters: without it the SDK summarises *this wallet's* trades,
      // and this wallet has never traded anything. It is the registry, not a
      // participant.
      kei.market.price(asset, { from }).catch(() => null),
    ])

    return {
      asset,
      asks: [...giving].sort(byPrice),
      bids: [...wanting].sort(byPrice).reverse(),
      trades: [...trades].sort((a, b) => (a.settledAt ?? a.seenAt) - (b.settledAt ?? b.seenAt)),
      price,
    }
  }

  // -------------------------------------------------------------------- plumbing

  async function pay(to: string, raw: bigint): Promise<void> {
    if (raw <= 0n) return
    await kei.send(to, formatKei(raw, 18))
  }

  /** Called from inside the write queue, never through it. */
  async function refund(to: string, raw: bigint, why: string): Promise<void> {
    console.warn(`  refund ${formatKei(raw, 8)} Kei to ${to.slice(0, 16)}… — ${why}`)
    await pay(to, raw)
  }

  function take(address: string): Intent | undefined {
    const now = Date.now()
    for (const [who, intent] of intents) if (now - intent.at > ttl) intents.delete(who)
    const intent = intents.get(address)
    intents.delete(address)
    return intent
  }

  function describe(coin: Coin): Listing {
    const { issuerWallet: _issuerWallet, ...listing } = coin
    return listing
  }

  return {
    address: kei.address,

    async facts() {
      return {
        address: kei.address,
        network: kei.network,
        launchFee: formatKei(LAUNCH_FEE_RAW, 18),
        listings: [...coins.values()].map(describe),
      }
    },

    async quoteLaunch(creator, input) {
      const raw = (input ?? {}) as Record<string, unknown>
      const { symbol, name, blurb } = cleanIdentity(raw)
      const transfer = cleanTransfer(raw.transfer)

      // A registry rule, not a chain one. Asset ids are derived from the issuer
      // and the symbol (SPEC §5.6.1), and every coin here has its own issuer, so
      // two DOGEs would be two distinct assets and the chain would be perfectly
      // happy. A launchpad where the ticker in the listing does not identify the
      // coin is a launchpad for impersonating the coin above you.
      for (const coin of coins.values()) {
        if (coin.symbol === symbol) {
          throw new ListingError(`${symbol} is already listed here. Pick another symbol.`)
        }
      }

      if ((await rawBalance(kei.address)) < LAUNCH_FEE_RAW + LAUNCH_MARGIN_RAW) {
        throw new RegistryError('The registry is out of working capital and cannot list anything right now.')
      }

      intents.set(creator, { at: Date.now(), symbol, name, blurb, transfer })
      traders.add(creator)
      return { symbol, name, to: kei.address, fee: formatKei(LAUNCH_FEE_RAW, 18) }
    },

    listing(asset) {
      const coin = coins.get(asset)
      return coin ? describe(coin) : undefined
    },

    book,

    watch(address) {
      if (typeof address === 'string' && address.startsWith('kei_')) traders.add(address)
    },

    close() {
      stopPayments()
      for (const coin of coins.values()) coin.issuerWallet.close()
      kei.close()
    },
  }
}

/** Cheapest first. `price` is `want` per one unit of `give` (SPEC §9.3). */
function byPrice(a: Offer, b: Offer): number {
  return a.price - b.price
}

/** A JS number of Kei, floored to raw. See the note at the payment handler. */
function rawOf(kei: number): bigint {
  if (!Number.isFinite(kei) || kei <= 0) return 0n
  const [whole = '0', fraction = ''] = kei.toFixed(18).split('.')
  return BigInt(whole) * KEI_RAW + BigInt(fraction.padEnd(18, '0').slice(0, 18))
}

/**
 * One writer at a time.
 *
 * An account has one chain (SPEC §5.6.1), so two of the registry's writes racing
 * each other means one of them is building on a block that is about to stop
 * being the head. Everything this account signs goes through here, in order.
 */
class Queue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job)
    this.tail = next.catch((error: unknown) => {
      console.error('  registry write failed:', error instanceof Error ? error.message : error)
    })
    return next
  }
}

export type { Trade }
