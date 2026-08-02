/**
 * The market. This file is the whole backend.
 *
 * There is no database. Not "a small one" — none. Who holds which coin is a
 * question the chain answers, and asking it is `balanceOf`. What is kept in
 * memory here is the part the chain has no opinion about: which coins exist,
 * who launched them, and which orders have been quoted but not yet paid for.
 * Stop the process and that is gone, along with the mock chain it described.
 *
 * It holds the market's seed, which is why it cannot run in a browser (SPEC §6.3).
 *
 * ## The one idea
 *
 * Every coin has a **deed**: a single item, minted to whoever launched it. The
 * deed is the authority to take the reserve, and taking the reserve means
 * sending the deed back here. So the question "can this coin be rugged?" is not
 * a promise the market makes. It is the deed's `transfer` policy, which is set
 * at launch, enforced by consensus, and immutable afterwards (SPEC §5.4):
 *
 *   - `carpet`      the deed transfers. It can come back. The reserve can leave.
 *   - `nailed-down` the deed is soulbound. It cannot be sent anywhere, by anyone,
 *                   ever, so there is no message that empties the reserve.
 *
 * A database could hold the same flag and a developer could edit the row. That
 * is the difference this game exists to show, and it is why the rug is a
 * mechanic here rather than a warning.
 */

import {
  Kei,
  issuanceBurn,
  type ClaimBundle,
  type Item,
  type IssuerToken,
  type KeiNode,
  type NetworkName,
} from 'kei-transaction'

import {
  CURVE_SUPPLY,
  GRADUATION_RAW,
  KEI_RAW,
  coinsFor,
  costToBuy,
  formatKei,
  proceedsOfSale,
  reserveAt,
  spotPrice,
} from '../shared/curve.js'
import {
  cleanIdentity,
  cleanLock,
  ListingError,
  type BuyQuote,
  type CoinState,
  type LaunchQuote,
  type Listing,
  type MarketFacts,
  type ReserveLock,
  type Tick,
} from '../shared/listing.js'

export interface MarketOptions {
  seed: string
  node: KeiNode | string
  network?: NetworkName
  /** How long a quote waits for its payment before it is forgotten. */
  intentTtlMs?: number
  /** Ticks kept per coin for the chart. The chain keeps the real history. */
  historyLimit?: number
}

export interface Market {
  address: string
  facts(): Promise<MarketFacts>
  /** Quote a launch. Nothing is issued until the fee arrives. */
  quoteLaunch(creator: string, input: unknown): Promise<LaunchQuote>
  /** Quote a buy. Nothing is minted until the Kei arrives. */
  quoteBuy(buyer: string, asset: string, budget: string): Promise<BuyQuote>
  /** Everything that has settled, for a client that wants to wait for its trade. */
  listing(asset: string): Listing | undefined
  /**
   * Proofs waiting to be collected by one address (SPEC §5.5).
   *
   * A commit publishes a root; it does not deliver anything. The entitlement is
   * only worth something once the holder writes their own claim, from their own
   * chain, using a proof — and the proof has to reach them somehow. This is the
   * somehow. Handing the same proof out twice is harmless: the second claim is
   * rejected by the ledger's double-claim index, not by this map.
   */
  claimsFor(address: string): ClaimBundle[]
  close(): void
}

export class MarketError extends Error {}

const DEFAULT_INTENT_TTL_MS = 120_000
const DEFAULT_HISTORY = 120
/** Above the launch burn, so a launch does not leave the market unable to pay out. */
const LAUNCH_MARGIN_RAW = KEI_RAW / 10n
/** What the market wants in hand before it will sign anything. */
const WORKING_CAPITAL_RAW = 25n * KEI_RAW

/**
 * How far under a quote a payment may land and still count. 0.00000001 Kei.
 *
 * `PaymentEvent.amount` is a JS `number`, and a double cannot hold eighteen
 * decimal places: a fee of exactly 7.1 Kei is reported as 7.099999999999999645.
 * So an exact-equality check on an arriving amount does not work, and quietly
 * rejects real payments — which is worth knowing before you write the same check
 * in your own integration.
 *
 * The tolerance is five orders of magnitude above the double's resolution at any
 * balance this game reaches, and a sixth of the price of the cheapest coin on
 * the curve, so nothing can be bought with it.
 */
const DUST_RAW = 10_000_000_000n

interface Coin {
  token: IssuerToken
  deed: Item
  creator: string
  lock: ReserveLock
  name: string
  blurb: string
  state: CoinState
  /** Coins sold off the curve. The reserve is a function of this and nothing else. */
  sold: bigint
  launchedAt: number
  history: Tick[]
}

/**
 * An intent quoted to one address and not yet paid for.
 *
 * A Kei transfer carries no memo (decisions-m0 §4), so an arriving payment says
 * only who it came from and how much. That is enough exactly when an address has
 * one open intent, so an address has one open intent: quoting a second replaces
 * the first. Two browser tabs racing each other is therefore a thing a player can
 * do to themselves, and the honest fix is a memo field in the wire format rather
 * than a cleverer guess here.
 */
type Intent =
  | { kind: 'launch'; at: number; symbol: string; name: string; blurb: string; lock: ReserveLock; fee: bigint }
  | { kind: 'buy'; at: number; asset: string }

export async function startMarket(options: MarketOptions): Promise<Market> {
  const kei = await Kei.server({
    seed: options.seed,
    node: options.node,
    ...(options.network === undefined ? {} : { network: options.network }),
  })

  const ttl = options.intentTtlMs ?? DEFAULT_INTENT_TTL_MS
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY

  const coins = new Map<string, Coin>()
  /** Deed asset id → coin asset id. A deed coming back is the rug. */
  const deeds = new Map<string, string>()
  const intents = new Map<string, Intent>()
  /** Address → proofs it has not collected yet. See `claimsFor`. */
  const proofs = new Map<string, ClaimBundle[]>()
  const writes = new Queue()

  // Working capital. Launch fees cover their own burns, but a market with an
  // empty account cannot pay for the first block it signs, and on a real network
  // somebody funds this address once instead. A faucet that is not there is not
  // an error — it just means this address is expected to be funded already.
  if ((await rawBalance()) < WORKING_CAPITAL_RAW) {
    await kei.faucet(formatKei(WORKING_CAPITAL_RAW, 18)).catch(() => undefined)
  }

  // -------------------------------------------------------------------- money

  /**
   * Raw Kei this account can spend.
   *
   * Every reserve the market is holding is also sitting in this balance, so the
   * float is what is left after subtracting them. The market never spends the
   * float below zero, because the reserves are other people's.
   */
  async function float(): Promise<bigint> {
    let held = 0n
    for (const coin of coins.values()) if (coin.state === 'trading') held += reserveAt(coin.sold)
    return (await rawBalance()) - held
  }

  async function rawBalance(): Promise<bigint> {
    const info = await kei.client.node.accountInfo(kei.address)
    return info ? BigInt(info.balance) : 0n
  }

  /** Assets issued so far — the number the next burn is computed from (SPEC §5.6.5). */
  async function issuedCount(): Promise<number> {
    const info = await kei.client.node.accountInfo(kei.address)
    return info?.issuedCount ?? 0
  }

  /**
   * What the next launch costs.
   *
   * A launch issues two assets, the coin and its deed, so it pays the nth burn
   * and the (n+1)th. The tenth coin on this market therefore costs more than the
   * first, and the thousandth costs more than anyone will pay — which is the
   * anti-spam mechanism, and the reason this market cannot become the thing it
   * is making fun of. It is charged to the launcher because it is real: the Kei
   * is destroyed, not collected.
   */
  async function launchFee(): Promise<bigint> {
    const issued = await issuedCount()
    return issuanceBurn(issued) + issuanceBurn(issued + 1) + LAUNCH_MARGIN_RAW
  }

  // ------------------------------------------------------------------ payments

  const stopPayments = kei.onPayment((payment) => {
    const intent = take(payment.from)
    // Kei that answers no quote stays here, and that is not the market being
    // clever: an unmatched arrival is indistinguishable from the faucet topping
    // this account up, and a market that reflexively sent money back to whoever
    // sent it money would return its own working capital on startup.
    if (!intent) return
    // Rounded down to raw, and treated as a floor on what arrived rather than as
    // the amount: see DUST_RAW. Under-crediting is invisible to the payer because
    // the curve charges them and hands back the change; over-crediting would be
    // the market paying for somebody else's coins.
    const paid = rawOf(payment.amount)

    if (intent.kind === 'launch') {
      void writes.run(() =>
        paid + DUST_RAW < intent.fee
          ? refund(payment.from, paid, 'the launch fee went up before that arrived')
          : launch(payment.from, intent, paid),
      )
    } else {
      void writes.run(() => fillBuy(payment.from, intent.asset, paid))
    }
  })

  const stopArrivals = kei.on('asset-received', (arrival) => {
    const asset = arrival.asset

    const rugged = deeds.get(asset)
    if (rugged !== undefined) {
      void writes.run(() => pullTheCarpet(rugged, arrival.from))
      return
    }

    const coin = coins.get(asset)
    if (coin) void writes.run(() => fillSell(coin, arrival.from, BigInt(Math.round(arrival.amount))))
    // Anything else is somebody sending the market an asset it does not trade.
    // It stays here. There is nothing sensible to do with it and pretending
    // otherwise would be a second, worse economy.
  })

  // ------------------------------------------------------------------- actions

  /** Issue the coin and its deed, and hand the deed to whoever paid. */
  async function launch(creator: string, intent: Extract<Intent, { kind: 'launch' }>, paid: bigint): Promise<void> {
    const token = await kei.token.issue({
      name: intent.name,
      symbol: intent.symbol,
      decimals: 0,
      maxSupply: Number(CURVE_SUPPLY),
      // Open, always. A coin nobody could send anywhere would make the deed
      // pointless and the joke unfunny: the risk being demonstrated is a market
      // risk, and a market needs the coin to move.
      transfer: 'open',
      description: intent.blurb,
    })

    const deed = await kei.items.create({
      name: `Deed to ${intent.symbol}`,
      description:
        intent.lock === 'carpet'
          ? 'Transferable. Send it back to the market and the reserve is yours.'
          : 'Soulbound. It cannot be sent anywhere, so the reserve stays where it is.',
      supply: 1,
      transfer: intent.lock === 'carpet' ? 'open' : 'none',
    })
    await kei.items.mint(deed.id, creator)

    const now = Date.now()
    coins.set(token.id, {
      token,
      deed,
      creator,
      lock: intent.lock,
      name: intent.name,
      blurb: intent.blurb,
      state: 'trading',
      sold: 0n,
      launchedAt: now,
      history: [{ at: now, sold: '0', kind: 'launch' }],
    })
    deeds.set(deed.id, token.id)

    // The fee bought two burns and a margin; anything past that is change.
    const change = paid - intent.fee
    if (change > 0n) await pay(creator, change)
  }

  /** Mint coins off the curve, refund the remainder, and check for graduation. */
  async function fillBuy(buyer: string, asset: string, paid: bigint): Promise<void> {
    const coin = coins.get(asset)
    if (!coin) return refund(buyer, paid, 'that coin is not listed here')
    if (coin.state !== 'trading') return refund(buyer, paid, `${coin.token.symbol} is ${coin.state}`)

    const count = coinsFor(coin.sold, paid)
    if (count <= 0n) return refund(buyer, paid, `that is less than one ${coin.token.symbol} costs`)

    // Charged at the curve, not at what arrived. The difference goes back, so the
    // reserve is always exactly `reserveAt(sold)` and never a running total that
    // could drift away from the supply it is supposed to back.
    const cost = costToBuy(coin.sold, count)
    await coin.token.mint(buyer, count.toString())
    coin.sold += count
    tick(coin, 'buy')

    const change = paid - cost
    if (change > 0n) await pay(buyer, change)

    if (reserveAt(coin.sold) >= GRADUATION_RAW) await graduate(coin)
  }

  /**
   * Pay for coins sent back, and burn them.
   *
   * The burn is not tidiness. Circulating supply is what the curve prices, so
   * coins that came off it have to stop existing or the next buyer would pay for
   * a position somebody already sold (SPEC §5.6.6).
   */
  async function fillSell(coin: Coin, seller: string, count: bigint): Promise<void> {
    if (count <= 0n) return

    if (coin.state !== 'trading') {
      // Nothing here can pay for them, so they go back rather than disappearing
      // into the market's balance. A rugged coin is worthless, and returning it
      // says so more clearly than keeping it would.
      await coin.token.transfer(seller, count.toString())
      return
    }

    const sold = count > coin.sold ? coin.sold : count
    const proceeds = proceedsOfSale(coin.sold, sold)
    coin.sold -= sold
    await coin.token.burn(sold.toString())
    await pay(seller, proceeds)
    tick(coin, 'sell')
  }

  /**
   * The deed came back. Hand over the reserve and close the curve.
   *
   * No check that the sender is the creator, deliberately: the deed is the
   * authority, and it is transferable precisely so that it can be sold to
   * somebody worse. Holding it is the whole claim, which is what "your item is
   * yours" costs when it is true.
   */
  async function pullTheCarpet(asset: string, puller: string): Promise<void> {
    const coin = coins.get(asset)
    if (!coin) return
    if (coin.state !== 'trading') return

    const reserve = reserveAt(coin.sold)
    coin.state = 'rugged'
    tick(coin, 'rug')
    if (reserve > 0n) await pay(puller, reserve)
  }

  /**
   * The curve closes and the reserve is locked, forever, for everybody.
   *
   * A graduated coin is out of this building: it still transfers between players
   * because `transfer: 'open'` said so at issuance, but the market no longer
   * makes a price and no deed can empty it. Holders get a badge, published as
   * **one** issuer block that each of them claims from their own chain
   * (SPEC §5.5) — a mint per holder would put the whole market behind one
   * account's chain, and the queue would become the game.
   */
  async function graduate(coin: Coin): Promise<void> {
    coin.state = 'graduated'
    tick(coin, 'graduate')

    const badge = await kei.items.create({
      name: `${coin.token.symbol} Graduate`,
      description: `Held ${coin.token.symbol} when its curve closed at ${formatKei(GRADUATION_RAW, 4)} Kei.`,
      supply: 10_000,
      transfer: 'none',
    })

    const holders = await coin.token.holders(200)
    const entries = holders
      .filter((holder) => holder.account !== kei.address && holder.balance > 0)
      .map((holder) => ({ to: holder.account, item: badge.id }))
    if (entries.length === 0) return

    const drops = await kei.items.commit(entries)
    for (const drop of drops) {
      for (const recipient of drop.recipients) {
        const waiting = proofs.get(recipient)
        const bundle = drop.proofFor(recipient)
        if (waiting) waiting.push(bundle)
        else proofs.set(recipient, [bundle])
      }
    }
  }

  // --------------------------------------------------------------------- plumbing

  function tick(coin: Coin, kind: Tick['kind']): void {
    coin.history.push({ at: Date.now(), sold: coin.sold.toString(), kind })
    if (coin.history.length > historyLimit) coin.history.splice(0, coin.history.length - historyLimit)
  }

  async function pay(to: string, raw: bigint): Promise<void> {
    if (raw <= 0n) return
    await kei.send(to, formatKei(raw, 18))
  }

  /**
   * Give it back.
   *
   * Called from inside the write queue, always, and never through it: a job that
   * queued more work and then waited for it would be waiting for itself.
   */
  async function refund(to: string, raw: bigint, why: string): Promise<void> {
    // Refusing quietly and keeping the money would be the more thematic choice
    // and is not one this market makes.
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

  function describe(asset: string, coin: Coin): Listing {
    return {
      asset,
      symbol: coin.token.symbol,
      name: coin.name,
      blurb: coin.blurb,
      creator: coin.creator,
      lock: coin.lock,
      deed: coin.deed.id,
      state: coin.state,
      sold: coin.sold.toString(),
      reserve: (coin.state === 'trading' ? reserveAt(coin.sold) : 0n).toString(),
      price: spotPrice(coin.sold).toString(),
      launchedAt: coin.launchedAt,
      history: coin.history,
    }
  }

  return {
    address: kei.address,

    async facts() {
      return {
        address: kei.address,
        network: kei.network,
        launchFee: (await launchFee()).toString(),
        issued: await issuedCount(),
        graduation: GRADUATION_RAW.toString(),
        listings: [...coins].map(([asset, coin]) => describe(asset, coin)),
      }
    },

    async quoteLaunch(creator, input) {
      const raw = (input ?? {}) as Record<string, unknown>
      const { symbol, name, blurb } = cleanIdentity(raw)
      const lock = cleanLock(raw.lock)

      for (const coin of coins.values()) {
        if (coin.token.symbol === symbol) {
          throw new ListingError(
            `${symbol} is already listed here. Asset ids are derived from the issuer and the symbol, so a second one would be the same coin (SPEC §5.6.1) — pick another.`,
          )
        }
      }

      const fee = await launchFee()
      if ((await float()) < LAUNCH_MARGIN_RAW) {
        throw new MarketError('The market is out of working capital and cannot list anything right now.')
      }

      intents.set(creator, { kind: 'launch', at: Date.now(), symbol, name, blurb, lock, fee })
      return { symbol, name, to: kei.address, fee: fee.toString() }
    },

    async quoteBuy(buyer, asset, budget) {
      const coin = coins.get(asset)
      if (!coin) throw new ListingError('That coin is not listed here.')
      if (coin.state !== 'trading') {
        throw new ListingError(
          coin.state === 'graduated'
            ? `${coin.token.symbol} graduated. The curve is closed and the reserve is locked; it only trades between players now.`
            : `${coin.token.symbol} was rugged. The reserve is gone and the market will not sell you any.`,
        )
      }

      const raw = BigInt(budget)
      if (raw <= 0n) throw new ListingError('Buy some amount of Kei worth, not none.')

      const count = coinsFor(coin.sold, raw)
      if (count <= 0n) {
        throw new ListingError(
          `One ${coin.token.symbol} costs ${formatKei(spotPrice(coin.sold))} Kei and you offered ${formatKei(raw)}.`,
        )
      }

      intents.set(buyer, { kind: 'buy', at: Date.now(), asset })
      return { asset, to: kei.address, cost: raw.toString(), coins: count.toString() }
    },

    listing(asset) {
      const coin = coins.get(asset)
      return coin ? describe(asset, coin) : undefined
    },

    claimsFor(address) {
      return proofs.get(address) ?? []
    },

    close() {
      stopPayments()
      stopArrivals()
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
 * An account has one chain (SPEC §5.6.1), so two of the market's writes racing
 * each other means one of them is building on a block that is about to stop
 * being the head. Everything the market signs goes through here, in order.
 */
class Queue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job)
    // Kept unhandled-rejection-free without swallowing: the caller still sees it.
    this.tail = next.catch((error: unknown) => {
      console.error('  market write failed:', error instanceof Error ? error.message : error)
    })
    return next
  }
}
