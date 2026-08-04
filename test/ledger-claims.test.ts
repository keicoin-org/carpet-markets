/**
 * The new claims, asserted at the ledger rather than in the client.
 *
 * SPEC §9.6 criterion 8: *every claim the interface makes is backed by a test
 * that asserts it at the ledger, not in the client*. `test/screen.test.tsx`
 * proves the interface renders a sentence; this proves the sentence is true of
 * a chain. Both halves are needed and neither substitutes for the other — a
 * panel that prints "4,500 CARPET changed hands" is only worth anything if 4,500
 * CARPET changed hands.
 *
 * Three claims are new with the terminal work and had no ledger test:
 *
 *   volume        `PriceSummary.volume`, which the page did not render at all.
 *   the fee split the launch screen printed "1 Kei" and "0.1 Kei" as literal
 *                 strings beside a total it computed from the constants.
 *   the badge     the transfer policy now claims to be a ledger record read off
 *                 the node, not the registry's copy of one. That is a strictly
 *                 stronger claim than the page used to make, so it needs a
 *                 stronger test: read the asset record back and compare.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { issuanceBurn, Kei, MockNode, randomSeed } from 'kei-transaction'

import { KEI_RAW, parseKei } from '../shared/format.js'
import { METRICS, metric } from '../lib/metrics.js'
import { LAUNCH_SUPPLY, unitPrice, type Book, type Listing, type TransferPolicy } from '../shared/listing.js'
import { startRegistry, type Registry } from '../server/registry.js'

const UNIT_PRICE = 0.0002

let node: MockNode
let registry: Registry
let alice: Kei
let bob: Kei

beforeAll(async () => {
  node = await MockNode.create({ faucetAmount: 100 })
  registry = await startRegistry({ seed: randomSeed(), node, network: 'mock' })
  alice = await Kei.start({ node, network: 'mock', seed: randomSeed() })
  bob = await Kei.start({ node, network: 'mock', seed: randomSeed() })
  await alice.faucet(100)
  await bob.faucet(100)
  registry.watch(alice.address)
  registry.watch(bob.address)
})

afterAll(() => {
  registry.close()
  alice.close()
  bob.close()
})

async function until<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await Bun.sleep(25)
  }
}

async function launch(who: Kei, symbol: string, transfer: TransferPolicy): Promise<Listing> {
  const quote = await registry.quoteLaunch(who.address, {
    symbol,
    name: `${symbol} Coin`,
    blurb: 'A test coin.',
    transfer,
  })
  await who.pay({ to: quote.to, amount: quote.fee })
  const listing = await until(`${symbol} to be listed`, async () =>
    (await registry.facts()).listings.find((entry) => entry.symbol === symbol),
  )
  await until(`${symbol} to arrive`, async () => {
    await who.sync()
    const held = await who.token(listing.asset).then((token) => token.balance())
    return held > 0 ? held : undefined
  })
  return listing
}

/** Sell a lot and have the other side take it, so a real trade settles. */
async function trade(listing: Listing, amount: number): Promise<void> {
  await alice.sync()
  const offer = await alice.market.sell({ asset: listing.asset, amount, price: amount * UNIT_PRICE })
  await bob.sync()
  await bob.market.accept(offer.hash)
}

/** What the coin page would render, built the way the coin page builds it. */
function readings(listing: Listing, book: Book, holders: { address: string }[] = []) {
  return {
    listing,
    book,
    holders: holders as never,
    held: 0,
    loading: false,
    problem: null,
  }
}

// ------------------------------------------------------------------ the volume

test('the volume the page renders is units that actually changed hands', async () => {
  const listing = await launch(alice, 'VOLUME', 'open')

  const before = await registry.book(listing.asset)
  expect(before.price).toBeNull()
  expect(metric('volume').read(readings(listing, before))).toEqual({ state: 'absent', why: 'never traded' })

  await trade(listing, 1_000)
  await trade(listing, 500)

  const after = await until('two trades to settle', async () => {
    const book = await registry.book(listing.asset)
    return book.price && book.price.trades === 2 ? book : undefined
  })

  // The ledger's own figure, not one this test computed and then asserted
  // against itself: `volume` is summed by the SDK off the `swap_accept` blocks.
  expect(after.price!.volume).toBe(1_500)
  expect(metric('volume').read(readings(listing, after))).toEqual({ state: 'known', value: '1,500 VOLUME' })
  expect(metric('trades').read(readings(listing, after))).toEqual({ state: 'known', value: '2' })
}, 45_000)

test('a coin whose ledger has no settled block reports no price, median, range, volume or count', async () => {
  const listing = await launch(bob, 'QUIET', 'open')
  const book = await registry.book(listing.asset)

  expect(book.trades).toHaveLength(0)
  for (const id of ['last', 'median', 'range', 'volume', 'trades']) {
    expect([id, metric(id).read(readings(listing, book))]).toEqual([id, { state: 'absent', why: 'never traded' }])
  }
}, 45_000)

// -------------------------------------------------------------- the holders row

test('the holders figure counts accounts the chain says hold a balance', async () => {
  const listing = await launch(alice, 'HOLDERS', 'open')

  const atLaunch = await registry.holders(listing.asset)
  expect(atLaunch.map((row) => row.address)).toEqual([alice.address])
  expect(atLaunch[0]!.amount).toBe(LAUNCH_SUPPLY)
  expect(atLaunch[0]!.creator).toBe(true)

  await trade(listing, 250_000)

  const after = await until('bob to show up as a holder', async () => {
    const rows = await registry.holders(listing.asset)
    return rows.length === 2 ? rows : undefined
  })

  const held = Object.fromEntries(after.map((row) => [row.address, row.amount]))
  expect(held[bob.address]).toBe(250_000)
  expect(held[alice.address]).toBe(LAUNCH_SUPPLY - 250_000)
  expect(metric('holders').read(readings(listing, await registry.book(listing.asset), after))).toEqual({
    state: 'known',
    value: '2',
  })
}, 45_000)

test('the card’s "creator holds" is the creator’s balance on the chain, not a guess', async () => {
  const listing = await until('HOLDERS to carry stats', async () => {
    const found = (await registry.facts()).listings.find((entry) => entry.symbol === 'HOLDERS')
    return found?.stats && found.stats.creatorHolds !== LAUNCH_SUPPLY ? found : undefined
  })
  const onChain = await alice.token(listing.asset).then((token) => token.balanceOf(alice.address))
  expect(listing.stats!.creatorHolds).toBe(onChain)
  expect(onChain).toBe(LAUNCH_SUPPLY - 250_000)
}, 45_000)

// ------------------------------------------------------------------ the fee split

test('the fee breakdown the launch screen prints is the constants that charge it', async () => {
  const facts = await registry.facts()
  const burn = parseKei(facts.launchFeeParts.burn)
  const margin = parseKei(facts.launchFeeParts.margin)

  // Not "1 Kei" as a string: the burn is whatever the SDK charges an account
  // for its first asset, and the screen now says that number rather than a
  // caption that happens to agree with it today.
  expect(burn).toBe(issuanceBurn(0))
  expect(margin).toBe(KEI_RAW / 10n)
  expect(burn + margin).toBe(parseKei(facts.launchFee))
})

test('the fee is still flat after several launches, which is the claim beside it', async () => {
  const facts = await registry.facts()
  expect(facts.listings.length).toBeGreaterThan(2)
  expect(parseKei(facts.launchFee)).toBe(issuanceBurn(0) + KEI_RAW / 10n)
})

// -------------------------------------------------------------------- the badge

test('the asset record a browser reads carries the policy the badge shows', async () => {
  for (const transfer of ['open', 'issuer-only', 'none'] as const) {
    const listing = await launch(bob, `BADGE${transfer === 'open' ? 1 : transfer === 'none' ? 2 : 3}`, transfer)

    // This is the read `Trader.assetInfo` makes: past the registry, to the node,
    // for the issuance block's own record.
    const info = await bob.token(listing.asset).then((token) => token.info())

    expect(info.transfer).toBe(transfer)
    expect(info.transfer).toBe(listing.transfer)
    expect(info.issuer).toBe(listing.issuer)
    expect(info.id).toBe(listing.asset)
    expect(BigInt(info.circulating)).toBe(BigInt(LAUNCH_SUPPLY))
    expect(info.maxSupply === null ? null : BigInt(info.maxSupply)).toBe(BigInt(LAUNCH_SUPPLY))
  }
}, 60_000)

test('a soulbound coin is refused by the ledger, which is what the badge is claiming', async () => {
  const listing = (await registry.facts()).listings.find((entry) => entry.symbol === 'BADGE2')!
  expect(listing.transfer).toBe('none')

  await bob.sync()
  // The panel is absent rather than disabled because there is no state of the
  // page in which this succeeds. Here is the ledger saying so.
  await expect(bob.market.sell({ asset: listing.asset, amount: 10, price: 1 })).rejects.toThrow()

  const book = await registry.book(listing.asset)
  expect(book.asks).toHaveLength(0)
}, 45_000)

// --------------------------------------------------------------- the price side

test('an offer read back off the chain prices the way the ladder renders it', async () => {
  const listing = await launch(alice, 'LADDER', 'open')
  await alice.sync()
  await alice.market.sell({ asset: listing.asset, amount: 2_000, price: 2_000 * UNIT_PRICE })

  const book = await until('the ask to be readable', async () => {
    const read = await registry.book(listing.asset)
    return read.asks.length === 1 ? read : undefined
  })

  expect(unitPrice(book.asks[0]!, listing.asset)).toBeCloseTo(UNIT_PRICE, 12)
  expect(metric('best-ask').read(readings(listing, book))).toEqual({ state: 'known', value: '0.0002 Kei' })
  expect(metric('best-bid').read(readings(listing, book))).toEqual({ state: 'absent', why: 'nobody is bidding' })
}, 45_000)

test('every metric survives a real book without throwing', async () => {
  const listing = (await registry.facts()).listings.find((entry) => entry.symbol === 'LADDER')!
  const book = await registry.book(listing.asset)
  const holders = await registry.holders(listing.asset)
  for (const entry of METRICS) {
    const reading = entry.read(readings(listing, book, holders))
    // Whatever it is, it is one of the three and it is not an empty string
    // standing in for a number nobody computed.
    expect([entry.id, ['pending', 'absent', 'known'].includes(reading.state)]).toEqual([entry.id, true])
    if (reading.state === 'known') expect([entry.id, reading.value.length > 0]).toEqual([entry.id, true])
    if (reading.state === 'absent') expect([entry.id, reading.why.length > 0]).toEqual([entry.id, true])
  }
}, 45_000)
