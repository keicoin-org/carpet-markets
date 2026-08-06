/**
 * A launch quote is free and unauthenticated on purpose — `POST /market/launch`
 * takes an `address` straight out of the request body, and nothing signs it
 * (SPEC has no primitive for proving control of an address without a real
 * transaction). That was fine for the quote itself, since nothing is charged
 * yet, but the intent it created used to be `intents.set(creator, ...)`: one
 * slot per address, last write wins. An address is public — every listing, book
 * row and holders table prints one — so anybody could quote a second, different
 * coin under somebody else's address and overwrite what that address's real
 * payment was going to buy (#27).
 *
 * The fix keys `intents` by an id nobody but the quoter ever sees, so a
 * stranger's forged request can only ever *add* a second intent under an
 * address, never replace the real one. That still leaves a real payment with
 * two live, disagreeing intents to choose between — and choosing wrong is the
 * whole of the bug, so `resolve()` refuses to guess: it refunds instead. The
 * fee is never stolen. It can be wasted on a refusal, which is the cost of a
 * two-step flow with no memo and no proof-of-control primitive, and is the same
 * trade-off `world-of-wonder/src/server/kei/Economy.ts` makes for order ids.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Kei, MockNode, randomSeed } from 'kei-transaction'

import { startRegistry, type Registry } from '../server/registry.js'

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
})

afterAll(() => {
  registry.close()
  alice.close()
  bob.close()
})

const identity = (symbol: string) => ({
  symbol,
  name: `${symbol} Coin`,
  blurb: 'A test coin.',
  transfer: 'open' as const,
})

async function keiOf(who: Kei): Promise<bigint> {
  await who.sync()
  const info = await node.accountInfo(who.address)
  return BigInt(info?.balance ?? '0')
}

test('a stranger cannot redirect somebody else\'s payment by quoting a second coin under their address', async () => {
  // Alice's real quote. Nothing has been paid yet.
  const quote = await registry.quoteLaunch(alice.address, identity('DOGE'))

  // Mallory does not control alice's key and is never asked to prove she does
  // — quoteLaunch takes whatever address the caller names. Before the fix this
  // single call overwrote alice's DOGE intent outright.
  await registry.quoteLaunch(alice.address, identity('RUG'))

  const before = await keiOf(alice)
  await alice.pay({ to: quote.to, amount: quote.fee })

  // Neither coin settles: the registry cannot tell which of the two live
  // intents alice's payment was for, and it does not guess.
  await Bun.sleep(300)
  const listings = (await registry.facts()).listings
  expect(listings.some((entry) => entry.symbol === 'DOGE')).toBe(false)
  expect(listings.some((entry) => entry.symbol === 'RUG')).toBe(false)

  // The fee comes back rather than buying Mallory's chosen content on alice's
  // own coin — the actual harm the report described: not that Mallory receives
  // alice's supply (launch() always mints to whoever paid), but that alice's
  // fee would have bought RUG, soulbound or otherwise not what she asked for,
  // with no way to undo it.
  await Bun.sleep(300)
  expect(await keiOf(alice)).toBeGreaterThanOrEqual(before)
})

test('unrelated creators quoting at the same time settle independently', async () => {
  const aliceQuote = await registry.quoteLaunch(alice.address, identity('KILIM'))
  const bobQuote = await registry.quoteLaunch(bob.address, identity('SISAL'))

  await alice.pay({ to: aliceQuote.to, amount: aliceQuote.fee })
  await bob.pay({ to: bobQuote.to, amount: bobQuote.fee })

  const kilim = await until('KILIM to be listed', async () =>
    (await registry.facts()).listings.find((entry) => entry.symbol === 'KILIM'),
  )
  const sisal = await until('SISAL to be listed', async () =>
    (await registry.facts()).listings.find((entry) => entry.symbol === 'SISAL'),
  )

  expect(kilim.creator).toBe(alice.address)
  expect(sisal.creator).toBe(bob.address)
})

// --------------------------------------------------------------------- helpers

async function until<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await Bun.sleep(25)
  }
}
