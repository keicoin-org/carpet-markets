/**
 * The terms on the screen are the terms that get signed, asserted at the ledger.
 *
 * Every number in the book arrives from the registry, and the registry is an
 * index: SPEC §9.4 says a list of where to look, and a list of where to look can
 * attach the hash of one offer to the price and quantity of another. It does not
 * take an attacker — the book is polled every two seconds and a click lands
 * between polls — but an attacker is the case that matters, because the buyer's
 * own key signs the result and there is nothing to dispute afterwards.
 *
 * So the client passes the terms it drew into `accept`, the SDK re-reads the
 * offer from the chain and checks every field of both legs against them, and the
 * signature never happens if they disagree. The proof that nothing was signed is
 * the offer still being open afterwards, so that is what these assert.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { expectationFrom, Kei, KeiError, MockNode, randomSeed, type Offer } from 'kei-transaction'

import { coinAmount, keiAmount, LAUNCH_SUPPLY, type Listing } from '../shared/listing.js'
import { startRegistry, type Registry } from '../server/registry.js'

const UNIT_PRICE = 0.0002

let node: MockNode
let registry: Registry
let alice: Kei
let bob: Kei
let coin: Listing

beforeAll(async () => {
  node = await MockNode.create({ faucetAmount: 100 })
  registry = await startRegistry({ seed: randomSeed(), node, network: 'mock' })
  alice = await Kei.start({ node, network: 'mock', seed: randomSeed() })
  bob = await Kei.start({ node, network: 'mock', seed: randomSeed() })
  await alice.faucet(100)
  await bob.faucet(100)
  registry.watch(alice.address)
  registry.watch(bob.address)
  coin = await launch(alice, 'TERMS')
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

async function launch(who: Kei, symbol: string): Promise<Listing> {
  const quote = await registry.quoteLaunch(who.address, {
    symbol,
    name: `${symbol} Coin`,
    blurb: 'A test coin.',
    transfer: 'open',
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

const ask = async (amount: number): Promise<Offer> => {
  await alice.sync()
  return alice.market.sell({ asset: coin.asset, amount, price: amount * UNIT_PRICE })
}

const held = async (who: Kei): Promise<number> => {
  await who.sync()
  return who.token(coin.asset).then((token) => token.balance())
}

// ------------------------------------------------------------------ the refusal

test('an accept whose terms moved is refused before it is signed', async () => {
  const real = await ask(1_000)
  const before = await bob.balance()

  // What a compromised or merely stale index could have drawn for that hash: the
  // right offer, a hundredth of the price. Everything else matches.
  const shown = { ...real, want: { ...real.want, amount: real.want.amount / 100 } }

  await bob.sync()
  await expect(bob.market.accept(real.hash, { expect: expectationFrom(shown) })).rejects.toThrow(
    /not the trade that was shown to you/,
  )

  // The half that proves no block went out. A refusal that still settled would
  // pass the assertion above and be the exact bug this file is about.
  expect((await bob.market.get(real.hash))?.state).toBe('open')
  expect(await bob.balance()).toBe(before)
  expect(await held(bob)).toBe(0)

  await alice.market.cancel(real.hash)
}, 45_000)

test('an expectation with a mismatched hash is refused, which price alone would not catch', async () => {
  const real = await ask(1_000)
  const substituted = await ask(1_000)

  // Same coin, same quantity, same price — a check on the numbers passes and the
  // buyer takes a listing they never looked at. This is the substituted-listing
  // case from the SDK's own docstring.
  await bob.sync()
  await expect(bob.market.accept(real.hash, { expect: expectationFrom(substituted) })).rejects.toThrow(
    /the offer hash was shown as/,
  )
  expect((await bob.market.get(real.hash))?.state).toBe('open')

  await alice.market.cancel(real.hash)
  await alice.market.cancel(substituted.hash)
}, 45_000)

test('the refusal is a KeiError with a code the page can name', async () => {
  const real = await ask(1_000)
  const shown = { ...real, give: { ...real.give, amount: real.give.amount * 2 } }

  await bob.sync()
  const error = await bob.market.accept(real.hash, { expect: expectationFrom(shown) }).catch((thrown) => thrown)
  expect(error).toBeInstanceOf(KeiError)
  expect((error as KeiError).code).toBe('offer-changed')
  expect((error as KeiError).message).toContain('shown as 2000')
  expect((error as KeiError).message).toContain('the chain says 1000')

  await alice.market.cancel(real.hash)
}, 45_000)

// ------------------------------------------------------------- the happy path

test('an accept matching what was rendered settles both legs', async () => {
  const real = await ask(2_000)
  const total = 2_000 * UNIT_PRICE
  const aliceKei = await alice.balance()
  const bobKei = await bob.balance()

  await bob.sync()
  const settlement = await bob.market.accept(real.hash, { expect: expectationFrom(real) })

  // Both legs, so the check cannot be satisfied by a client that refuses
  // everything. Alice's coins left her balance when she wrote the offer, which
  // is why the coin leg is only readable on Bob's side.
  expect(settlement.received.amount).toBe(2_000)
  expect(await held(bob)).toBe(2_000)
  expect(await bob.balance()).toBeCloseTo(bobKei - total, 9)
  await alice.sync()
  expect(await alice.balance()).toBeCloseTo(aliceKei + total, 9)
  expect((await bob.market.get(real.hash))?.state).toBe('accepted')
}, 45_000)

// ------------------------------------------------------- the row the page draws

test('a book row carries the terms it renders into the accept, and they still match', async () => {
  await ask(1_500)

  // Exactly what reaches `OrderBook`: the registry's book, through JSON.
  const book = await until('the ask to be readable', async () => {
    const read = await registry.book(coin.asset)
    return read.asks.length === 1 ? read : undefined
  })
  const row = JSON.parse(JSON.stringify(book.asks[0]!)) as Offer
  const expected = expectationFrom(row)

  // The guard against a vacuous check. An expectation that names nothing passes
  // against any offer on the chain, and a field rename would produce exactly
  // that while every other assertion in this file still went green.
  expect(expected.hash).toBe(row.hash)
  expect(expected.seller).toBe(row.from)
  expect(expected.give?.amount).toBe(coinAmount(row, coin.asset))
  expect(expected.want?.amount).toBe(keiAmount(row, coin.asset))
  expect(expected.give?.amount).toBe(1_500)

  await bob.sync()
  const settlement = await bob.market.accept(row.hash, { expect: expected })
  expect(settlement.received.amount).toBe(1_500)
  expect(await held(alice)).toBe(LAUNCH_SUPPLY - 3_500)
}, 45_000)
