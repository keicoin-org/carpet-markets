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
import type { NetworkFacts } from '../shared/network.js'
import {
  cleanIdentity,
  cleanTransfer,
  LAUNCH_SUPPLY,
  ListingError,
  unitPrice,
  type Book,
  type Holder,
  type LaunchQuote,
  type Listing,
  type ListingStats,
  type MarketFacts,
  type TransferPolicy,
} from '../shared/listing.js'

export interface RegistryOptions {
  seed: string
  node: KeiNode | string
  network?: NetworkName
  /**
   * What to tell the client about the chain underneath.
   *
   * Passed in rather than inferred from `network`, because the SDK's name for a
   * network and the sentence a visitor needs are different things — "mock" is
   * accurate and says nothing about whether the coins survive a restart.
   */
  chain?: NetworkFacts
  /** How long a quote waits for its payment before it is forgotten. */
  intentTtlMs?: number
  /**
   * How many replies a coin has, if anybody is counting.
   *
   * Injected rather than imported because replies are not the registry's
   * business — they are not on the chain and this file's whole claim is that
   * everything it reports came off one. It passes the number through for a card
   * to render and never reads the text.
   */
  replyCount?(asset: string): number
  /** Injectable clock used while a Durable Object replays persisted events. */
  now?(): number
}

export interface Registry {
  address: string
  facts(): Promise<MarketFacts>
  /** Quote a launch. Nothing is issued until the fee arrives. */
  quoteLaunch(creator: string, input: unknown): Promise<LaunchQuote>
  listing(asset: string): Listing | undefined
  /** The order book and the trade history, both read off the chain. */
  book(asset: string): Promise<Book>
  /** Who holds it, of the accounts this registry knows to ask about. */
  holders(asset: string): Promise<Holder[]>
  /** Settled trades across every listed coin, newest first. */
  activity(limit?: number): Promise<Trade[]>
  /** Drain receives and registry writes before a mutating request is acknowledged. */
  flush(): Promise<void>
  /** Drop derived read caches after a deterministic bootstrap finishes. */
  invalidate(): void
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

/** How long a coin's card numbers are reused before they are read again. */
const SUMMARY_TTL_MS = 4_000

/** How deep the cross-coin ticker reads. Beyond this nobody is scrolling. */
const ACTIVITY_MAX = 60

/** A coin nothing could be read about, which is not the same as a quiet one. */
const NO_STATS = (supply: number): ListingStats => ({
  last: null,
  trades: 0,
  holders: 0,
  replies: 0,
  asks: 0,
  bestAsk: null,
  creatorHolds: supply,
})

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
  const now = options.now ?? Date.now
  const kei = await Kei.server({
    seed: options.seed,
    node: options.node,
    ...(options.network === undefined ? {} : { network: options.network }),
  })

  const ttl = options.intentTtlMs ?? DEFAULT_INTENT_TTL_MS

  const coins = new Map<string, Coin>()
  const intents = new Map<string, Intent>()
  const summaries = new Map<string, { at: number; stats: ListingStats }>()
  let activityCache: { at: number; trades: Trade[] } | undefined
  /**
   * Every account whose chain might carry an offer.
   *
   * Creators are in here because they were minted the supply; buyers add
   * themselves through `watch`. This set is the entire reason the registry
   * exists, and it is the one piece of state that is not on the chain.
   */
  const traders = new Set<string>([kei.address])
  /** Where to start looking for an unused issuer index. 0 is the registry itself. */
  let nextIndex = 1
  const writes = new Queue()

  // Working capital. Launch fees cover their own burns, but an account with an
  // empty balance cannot fund the first issuer it derives, and on a real network
  // somebody funds this address once instead. A faucet that is not there is not
  // an error.
  await topUp()

  async function rawBalance(address: string): Promise<bigint> {
    const info = await kei.client.node.accountInfo(address)
    return info ? BigInt(info.balance) : 0n
  }

  /**
   * An account from this seed that has never issued anything.
   *
   * The flat launch fee is only correct if every coin is the *first* asset its
   * issuing account creates, because the burn escalates per account (SPEC
   * §5.6.5). On a mock chain a counter is enough: the ledger is new every boot,
   * so index 1 is always untouched. On a real network it is not — the chain
   * outlives the process, so a restart with the same seed walks straight back
   * over accounts that have already issued, and the second coin at index 1 would
   * quietly cost 2 Kei against a quote of 1.
   *
   * So the index is a starting point and the chain is the authority: an account
   * with no blocks on it has issued nothing. The scan costs one `account_info`
   * per skipped index, once, and only on a network where there is anything to
   * skip.
   */
  async function freshIssuer(): Promise<Kei> {
    for (;;) {
      const index = nextIndex++
      const candidate = await Kei.server({
        seed: options.seed,
        index,
        node: options.node,
        ...(options.network === undefined ? {} : { network: options.network }),
      })
      if ((await kei.client.node.accountInfo(candidate.address)) === null) return candidate
      candidate.close()
    }
  }

  /**
   * Ask the faucet for more, if there is one and the balance has run down.
   *
   * The registry pays each new issuer its burn out of its own balance, so it
   * runs down at roughly a Kei per launch. On the mock chain the faucet is
   * infinite; on the testnet it is a rate-limited service that may say no, and
   * saying no is not an error — it is the reason `quoteLaunch` still checks the
   * balance afterwards and refuses in a sentence rather than failing mid-launch
   * with the visitor's fee already spent.
   */
  async function topUp(): Promise<void> {
    if ((await rawBalance(kei.address)) >= WORKING_CAPITAL_RAW) return
    await kei.faucet(formatKei(WORKING_CAPITAL_RAW, 18)).catch(() => undefined)
    await kei.sync().catch(() => undefined)
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
    const issuer = await freshIssuer()

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
      launchedAt: now(),
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
      // Cheapest ask first, best bid first — both in Kei per unit, which for a
      // bid is not the number the SDK put in `price`. See `unitPrice`.
      asks: [...giving].sort((a, b) => unitPrice(a, asset) - unitPrice(b, asset)),
      bids: [...wanting].sort((a, b) => unitPrice(b, asset) - unitPrice(a, asset)),
      trades: [...trades].sort((a, b) => (a.settledAt ?? a.seenAt) - (b.settledAt ?? b.seenAt)),
      price,
    }
  }

  /**
   * Who holds it, read one `balanceOf` at a time.
   *
   * This has the same blind spot as the book and it is worth stating plainly: a
   * holder the registry has never heard of does not appear. `traders` is every
   * account that launched something, announced itself through `watch`, or was
   * quoted a launch — which in practice is everybody who has used this page, and
   * in principle is not everybody on the chain.
   *
   * So the rows are a floor, not a census, and the percentages are computed
   * against the coin's supply rather than against the sum of the rows. A table
   * that adds up to 60% is telling the truth about what it can see. One
   * normalised to 100% would be inventing a denominator.
   */
  async function holders(asset: string): Promise<Holder[]> {
    const coin = coins.get(asset)
    if (!coin) throw new ListingError('That coin is not listed here.')

    const token = await kei.token(asset)
    const candidates = new Set<string>([...traders, coin.creator, coin.issuer])
    candidates.delete(kei.address)

    const rows = await Promise.all(
      [...candidates].map(async (address) => ({
        address,
        amount: await token.balanceOf(address).catch(() => 0),
        creator: address === coin.creator,
        issuer: address === coin.issuer,
      })),
    )

    return rows.filter((row) => row.amount > 0).sort((a, b) => b.amount - a.amount)
  }

  /**
   * The card numbers, computed at most once every `SUMMARY_TTL_MS` per coin.
   *
   * Without the cache this is the most expensive thing the registry does: a
   * price read and a `balanceOf` per known account, per coin, per client, every
   * two seconds. With it, one tab and fifty tabs cost the same, which is the
   * property that matters when the board is the first thing everybody loads.
   *
   * A stale entry is served rather than awaited on refresh failure, because a
   * card showing numbers from four seconds ago is better than a card that
   * flickers back to "never traded" when one read times out.
   */
  async function summarise(coin: Coin): Promise<ListingStats> {
    const cached = summaries.get(coin.asset)
    if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.stats

    try {
      const from = [...traders]
      const [price, holding, asks] = await Promise.all([
        kei.market.price(coin.asset, { from }).catch(() => null),
        holders(coin.asset).catch(() => []),
        // The board's "buyable now" chip, and the reason it is allowed to exist:
        // it reads open `swap_offer` blocks off the same chains the book does.
        kei.market.offers({ from, asset: coin.asset, state: 'open' }).catch(() => []),
      ])
      const stats: ListingStats = {
        last: price?.last ?? null,
        trades: price?.trades ?? 0,
        holders: holding.length,
        replies: options.replyCount?.(coin.asset) ?? 0,
        asks: asks.length,
        bestAsk: asks.length === 0 ? null : Math.min(...asks.map((offer) => unitPrice(offer, coin.asset))),
        creatorHolds: holding.find((row) => row.creator)?.amount ?? 0,
      }
      summaries.set(coin.asset, { at: Date.now(), stats })
      return stats
    } catch {
      return cached?.stats ?? NO_STATS(coin.supply)
    }
  }

  /**
   * Everything that has settled lately, across every coin at once.
   *
   * One read rather than one per coin: `market.trades` without an `asset` walks
   * the same chains the books walk and returns every `swap_accept` on them, so
   * the whole board's activity costs what one coin's history costs. That is the
   * property that makes a live ticker affordable here at all, and it is a
   * block-lattice property — history is per-account, so "everything these
   * accounts did" is a bounded walk rather than a ledger sweep (SPEC §9.1).
   *
   * It is still only as complete as the account list, exactly like the book, and
   * the strip that renders it says so.
   */
  async function activity(limit: number): Promise<Trade[]> {
    const fresh = activityCache && Date.now() - activityCache.at < SUMMARY_TTL_MS
    if (!fresh) {
      const trades = await kei.market
        .trades({ from: [...traders], last: ACTIVITY_MAX })
        .catch(() => activityCache?.trades ?? [])
      activityCache = {
        at: Date.now(),
        trades: [...trades]
          .filter((trade) => coins.has(trade.give.asset) || coins.has(trade.want.asset))
          .sort((a, b) => (b.settledAt ?? b.seenAt) - (a.settledAt ?? a.seenAt)),
      }
    }
    return activityCache!.trades.slice(0, limit)
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

  /** Drop every quote nobody paid for inside the TTL. */
  function sweepIntents(): void {
    const current = now()
    for (const [who, intent] of intents) if (current - intent.at > ttl) intents.delete(who)
  }

  function take(address: string): Intent | undefined {
    sweepIntents()
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
      const listings = await Promise.all(
        [...coins.values()].map(async (coin) => ({ ...describe(coin), stats: await summarise(coin) })),
      )
      return {
        address: kei.address,
        chain: options.chain ?? { mode: 'mock', sdkNetwork: kei.network, node: null, ephemeral: true },
        launchFee: formatKei(LAUNCH_FEE_RAW, 18),
        // The breakdown travels with the total so the launch screen states the
        // constants rather than a caption that agrees with them today.
        launchFeeParts: {
          burn: formatKei(LAUNCH_BURN_RAW, 18),
          margin: formatKei(LAUNCH_MARGIN_RAW, 18),
        },
        listings,
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

      // A symbol is also taken while somebody is on their way to pay for it. A
      // quote lands in `intents` and only reaches `coins` when the payment
      // settles, so scanning settled coins alone left the whole TTL open: two
      // people could quote DOGE inside two minutes, both pay a fee that is not
      // refunded, and end up with two coins the board cannot tell apart (#17).
      //
      // The sweep runs first so an abandoned quote stops holding the ticker at
      // the TTL rather than whenever the map is next written to, and the
      // caller's own quote is skipped so re-quoting stays idempotent.
      sweepIntents()
      for (const [who, intent] of intents) {
        if (who !== creator && intent.symbol === symbol) {
          throw new ListingError(
            `${symbol} was claimed a moment ago by somebody who is paying for it. Pick another symbol, or try this one again in a couple of minutes if their launch does not settle.`,
          )
        }
      }

      if ((await rawBalance(kei.address)) < LAUNCH_FEE_RAW + LAUNCH_MARGIN_RAW) {
        // Ask before refusing. The registry funds each new issuer out of its own
        // balance, so it runs down at about a Kei a launch, and on a network
        // with a faucet that is a top-up rather than an outage.
        await topUp()
        if ((await rawBalance(kei.address)) < LAUNCH_FEE_RAW + LAUNCH_MARGIN_RAW) {
          throw new RegistryError(
            'The registry is out of working capital and cannot list anything right now. It funds each new coin’s issuing account out of its own balance, and the faucet it refills from has said no.',
          )
        }
      }

      intents.set(creator, { at: now(), symbol, name, blurb, transfer })
      traders.add(creator)
      return { symbol, name, to: kei.address, fee: formatKei(LAUNCH_FEE_RAW, 18) }
    },

    listing(asset) {
      const coin = coins.get(asset)
      return coin ? describe(coin) : undefined
    },

    book,

    holders,

    activity: (limit = 24) => activity(limit),

    async flush() {
      await kei.sync()
      await writes.idle()
    },

    invalidate() {
      summaries.clear()
      activityCache = undefined
    },

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

  async idle(): Promise<void> {
    await this.tail
  }
}

export type { Trade }
