/**
 * The registry and the market, against a real ledger.
 *
 * Everything here goes through the mock node, which enforces the rules the real
 * one does: one chain per account, derived asset ids, receivable arrivals,
 * supply caps, atomic swap settlement, and — the tests this file exists for —
 * transfer policy and the issuance burn.
 *
 * The claim this example makes is that "can this coin be dumped on you?" is a
 * flag the chain enforces rather than a promise a website makes. That is either
 * true at the ledger or it is marketing, so it is asserted at the ledger.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Kei, MockNode, randomSeed } from 'kei-transaction'

import { KEI_RAW, parseKei } from '../shared/format.js'
import { LAUNCH_SUPPLY, type Listing, type TransferPolicy } from '../shared/listing.js'
import { startRegistry, LAUNCH_FEE_RAW, type Registry } from '../server/registry.js'

/** Kei per single coin. Small, because a fresh coin is worth almost nothing. */
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

// --------------------------------------------------------------------- helpers

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
  // The supply is a receivable until this wallet signs for it (SPEC §5.6.3).
  await until(`${symbol} to arrive`, async () => {
    await who.sync()
    const held = await who.token(listing.asset).then((token) => token.balance())
    return held > 0 ? held : undefined
  })
  return listing
}

const coinsOf = async (who: Kei, asset: string): Promise<number> => {
  await who.sync()
  return who.token(asset).then((token) => token.balance())
}

const keiOf = async (who: Kei): Promise<bigint> => {
  await who.sync()
  const info = await node.accountInfo(who.address)
  return BigInt(info?.balance ?? '0')
}

// ----------------------------------------------------------------------- tests

test('nothing is issued until the fee is paid', async () => {
  await registry.quoteLaunch(alice.address, {
    symbol: 'GHOST',
    name: 'Never Paid For',
    blurb: '',
    transfer: 'open',
  })
  await Bun.sleep(150)
  expect((await registry.facts()).listings.some((entry) => entry.symbol === 'GHOST')).toBe(false)
})

test('a paid launch mints the whole supply to whoever paid', async () => {
  const listing = await launch(alice, 'CARPET', 'open')

  expect(listing.creator).toBe(alice.address)
  expect(listing.supply).toBe(LAUNCH_SUPPLY)
  expect(listing.transfer).toBe('open')
  expect(await coinsOf(alice, listing.asset)).toBe(LAUNCH_SUPPLY)
})

test('every coin is issued by an account of its own', async () => {
  const first = (await registry.facts()).listings.find((entry) => entry.symbol === 'CARPET')!
  const second = await launch(bob, 'NAILED', 'none')

  expect(second.issuer).not.toBe(first.issuer)
  // And neither of them is the registry, which issues nothing and therefore
  // never accumulates an issuance count.
  expect(second.issuer).not.toBe(registry.address)
})

test('the launch fee does not rise with the number of coins already listed', async () => {
  // The regression this file exists for. The escalating issuance burn is charged
  // per account (SPEC §5.6.5), so issuing every coin from one account turned an
  // anti-spam rule into a tax on arriving late: a newcomer's first coin was the
  // most expensive one on the site. A fresh issuer per coin makes the fee flat.
  const before = BigInt(parseKei((await registry.facts()).launchFee))
  await launch(alice, 'THIRD', 'open')
  const after = BigInt(parseKei((await registry.facts()).launchFee))

  expect(after).toBe(before)
  // One asset from a brand new account: its first burn, and nothing else.
  expect(LAUNCH_FEE_RAW).toBeLessThan(2n * KEI_RAW)
})

test('an open coin trades peer to peer, in whatever size the seller chose', async () => {
  const listing = (await registry.facts()).listings.find((entry) => entry.symbol === 'CARPET')!

  // The creator holds everything and sells a clip of it. This is the rug, and it
  // needs no special mechanic: it is just selling, which is the point.
  //
  // `price` is the total ask for the whole lot, not the per-unit price — the
  // Offer that comes back reports `price` per unit, so the two numbers differ by
  // `amount` and it is worth being explicit about which one you are holding.
  const offer = await alice.market.sell({ asset: listing.asset, amount: 5_000, price: 5_000 * UNIT_PRICE })
  expect(offer.give.amount).toBe(5_000)
  expect(offer.price).toBeCloseTo(UNIT_PRICE, 12)

  const book = await registry.book(listing.asset)
  expect(book.asks.map((ask) => ask.hash)).toContain(offer.hash)

  const aliceKeiBefore = await keiOf(alice)
  await bob.market.accept(offer.hash)

  // One block, both legs (SPEC §9.2).
  expect(await coinsOf(bob, listing.asset)).toBe(5_000)
  expect(await coinsOf(alice, listing.asset)).toBe(LAUNCH_SUPPLY - 5_000)
  expect(await keiOf(alice)).toBeGreaterThan(aliceKeiBefore)

  // And again, at a different price, because nothing about the first sale
  // committed the seller to anything.
  const second = await alice.market.sell({ asset: listing.asset, amount: 2_500, price: 2_500 * UNIT_PRICE * 4 })
  const after = await registry.book(listing.asset)
  expect(after.asks.map((ask) => ask.hash)).toContain(second.hash)
  expect(after.asks.find((ask) => ask.hash === second.hash)?.price).toBeCloseTo(UNIT_PRICE * 4, 12)
})

test('the price history is the settled trades, read off the chain', async () => {
  const listing = (await registry.facts()).listings.find((entry) => entry.symbol === 'CARPET')!
  const book = await until('the trade to be readable', async () => {
    const now = await registry.book(listing.asset)
    return now.trades.length > 0 ? now : undefined
  })

  expect(book.trades[0]?.seller).toBe(alice.address)
  expect(book.trades[0]?.buyer).toBe(bob.address)
  expect(book.price?.trades).toBeGreaterThan(0)
  expect(book.price?.last).toBeCloseTo(UNIT_PRICE, 12)
})

test('a soulbound coin cannot be offered at all, so it has no market', async () => {
  const listing = (await registry.facts()).listings.find((entry) => entry.symbol === 'NAILED')!
  expect(listing.transfer).toBe('none')
  expect(await coinsOf(bob, listing.asset)).toBe(LAUNCH_SUPPLY)

  // Not "the registry refuses". The ledger refuses, because locking units into a
  // swap_offer is moving them, and this coin's units do not move.
  await expect(bob.market.sell({ asset: listing.asset, amount: 1, price: 1 })).rejects.toThrow()

  const book = await registry.book(listing.asset)
  expect(book.asks).toHaveLength(0)
  expect(book.trades).toHaveLength(0)
})

test('an issuer-only coin cannot be traded between two holders', async () => {
  const listing = await launch(alice, 'CLOSED', 'issuer-only')
  expect(listing.transfer).toBe('issuer-only')

  // Alice holds the supply and cannot list it for anybody but the issuer, so no
  // player-to-player book exists for it. This is the closed economy SPEC §5.4
  // describes, and the cost of choosing it is exactly this.
  await expect(alice.market.sell({ asset: listing.asset, amount: 10, price: 1 })).rejects.toThrow()
  expect((await registry.book(listing.asset)).asks).toHaveLength(0)
})

test('an offer can be cancelled, and the units come back', async () => {
  const listing = (await registry.facts()).listings.find((entry) => entry.symbol === 'THIRD')!
  const before = await coinsOf(alice, listing.asset)

  const offer = await alice.market.sell({ asset: listing.asset, amount: 1_000, price: 0.01 })
  expect(await coinsOf(alice, listing.asset)).toBe(before - 1_000)

  await alice.market.cancel(offer.hash)
  expect(await coinsOf(alice, listing.asset)).toBe(before)
  expect((await registry.book(listing.asset)).asks.map((ask) => ask.hash)).not.toContain(offer.hash)
})

test('two coins cannot share a symbol', async () => {
  await expect(
    registry.quoteLaunch(bob.address, { symbol: 'CARPET', name: 'Impostor', blurb: '', transfer: 'open' }),
  ).rejects.toThrow(/already listed/i)
})

test('bad identities are refused before anybody is charged', async () => {
  for (const bad of [
    { symbol: 'x', name: 'Lowercase and too short', transfer: 'open' },
    { symbol: 'TOOLONGSYMBOL', name: 'Over ten characters', transfer: 'open' },
    { symbol: '9LIVES', name: 'Starts with a digit', transfer: 'open' },
    { symbol: 'FINE', name: 'x', transfer: 'open' },
    { symbol: 'FINE', name: 'Bad policy', transfer: 'sometimes' },
  ]) {
    await expect(registry.quoteLaunch(alice.address, { ...bad, blurb: '' })).rejects.toThrow()
  }
})
