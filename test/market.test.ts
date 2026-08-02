/**
 * The market, against a real ledger.
 *
 * Everything here goes through the mock node, which enforces the rules the real
 * one does: one chain per account, derived asset ids, receivable arrivals, supply
 * caps, and — the test this file exists for — transfer policy. The claim on the
 * badge is that a nailed-down coin *cannot* be rugged. That is either true at the
 * ledger or it is marketing, so it is asserted at the ledger.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Kei, MockNode, randomSeed } from 'kei-transaction'

import { GRADUATION_RAW, KEI_RAW, coinsFor, costToBuy, formatKei, reserveAt } from '../shared/curve.js'
import type { Listing } from '../shared/listing.js'
import { startMarket, type Market } from '../server/market.js'

let node: MockNode
let market: Market
let alice: Kei
let bob: Kei

beforeAll(async () => {
  node = await MockNode.create({ faucetAmount: 100 })
  market = await startMarket({ seed: randomSeed(), node, network: 'mock' })
  alice = await Kei.start({ node, network: 'mock', seed: randomSeed() })
  bob = await Kei.start({ node, network: 'mock', seed: randomSeed() })
  await alice.faucet(100)
  await bob.faucet(100)
})

afterAll(() => {
  market.close()
  alice.close()
  bob.close()
})

// --------------------------------------------------------------------- helpers

/** Poll until the market has settled something, or give up and say what was missing. */
async function until<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await Bun.sleep(25)
  }
}

async function launch(
  who: Kei,
  symbol: string,
  lock: 'carpet' | 'nailed-down',
): Promise<Listing> {
  const quote = await market.quoteLaunch(who.address, {
    symbol,
    name: `${symbol} Coin`,
    blurb: 'A test coin.',
    lock,
  })
  await who.pay({ to: quote.to, amount: formatKei(BigInt(quote.fee), 18) })
  return until(`${symbol} to be listed`, async () =>
    (await market.facts()).listings.find((listing) => listing.symbol === symbol),
  )
}

async function buy(who: Kei, listing: Listing, kei: bigint): Promise<bigint> {
  const before = BigInt(market.listing(listing.asset)?.sold ?? '0')
  const quote = await market.quoteBuy(who.address, listing.asset, kei.toString())
  await who.pay({ to: quote.to, amount: formatKei(kei, 18) })
  await until('the buy to settle', async () => {
    const sold = BigInt(market.listing(listing.asset)?.sold ?? '0')
    return sold > before ? sold : undefined
  })
  return BigInt(quote.coins)
}

const keiOf = async (who: Kei): Promise<bigint> => {
  await who.sync()
  const info = await node.accountInfo(who.address)
  return BigInt(info?.balance ?? '0')
}

const coinsOf = async (who: Kei, asset: string): Promise<bigint> =>
  who.token(asset).then(async (token) => BigInt(Math.round(await token.balance())))

// ----------------------------------------------------------------------- tests

test('nothing is issued until the fee is paid', async () => {
  await market.quoteLaunch(alice.address, {
    symbol: 'GHOST',
    name: 'Never Paid For',
    blurb: '',
    lock: 'nailed-down',
  })
  await Bun.sleep(100)
  expect((await market.facts()).listings.some((listing) => listing.symbol === 'GHOST')).toBe(false)
})

test('a paid launch mints the deed to whoever paid', async () => {
  const listing = await launch(alice, 'SOLID', 'nailed-down')

  expect(listing.creator).toBe(alice.address)
  expect(listing.sold).toBe('0')
  expect(listing.lock).toBe('nailed-down')

  await alice.sync()
  const owned = await alice.items.ownedBy()
  expect(owned.map((item) => item.id)).toContain(listing.deed)
  expect(owned.find((item) => item.id === listing.deed)?.transferPolicy).toBe('none')
})

test('the launch fee rises with every asset the market has issued', async () => {
  const before = BigInt((await market.facts()).launchFee)
  await launch(bob, 'SECOND', 'carpet')
  const after = BigInt((await market.facts()).launchFee)
  // Two assets per launch — the coin and its deed — so the next fee is at least
  // two Kei higher than the last one (SPEC §5.6.5).
  expect(after - before).toBeGreaterThanOrEqual(2n * KEI_RAW)
})

test('buying mints exactly what the curve priced, and the reserve backs it', async () => {
  const listing = (await market.facts()).listings.find((entry) => entry.symbol === 'SOLID')!
  const budget = KEI_RAW / 2n

  const expected = coinsFor(0n, budget)
  const quoted = await buy(alice, listing, budget)
  expect(quoted).toBe(expected)
  expect(await coinsOf(alice, listing.asset)).toBe(expected)

  const after = market.listing(listing.asset)!
  expect(BigInt(after.sold)).toBe(expected)
  expect(BigInt(after.reserve)).toBe(reserveAt(expected))
  // The market kept only what the curve said, and sent the rest back.
  expect(BigInt(after.reserve)).toBeLessThanOrEqual(budget)
})

test('selling pays the curve back and burns the coins', async () => {
  const listing = market.listing((await market.facts()).listings.find((e) => e.symbol === 'SOLID')!.asset)!
  const held = await coinsOf(alice, listing.asset)
  expect(held).toBeGreaterThan(0n)

  const sold = BigInt(listing.sold)
  const owed = costToBuy(sold - held, held)
  const before = await keiOf(alice)

  const token = await alice.token(listing.asset)
  await token.transfer(market.address, held.toString())

  await until('the sale to settle', async () => {
    const now = market.listing(listing.asset)
    return now && BigInt(now.sold) === sold - held ? now : undefined
  })

  expect(await coinsOf(alice, listing.asset)).toBe(0n)
  const gained = (await keiOf(alice)) - before
  expect(gained).toBe(owed)
})

test('a soulbound deed cannot be sent back, so the reserve cannot be taken', async () => {
  const listing = (await market.facts()).listings.find((entry) => entry.symbol === 'SOLID')!
  await buy(bob, listing, KEI_RAW)

  const reserved = BigInt(market.listing(listing.asset)!.reserve)
  expect(reserved).toBeGreaterThan(0n)

  await alice.sync()
  // Not "the market refuses". The ledger refuses, and the message says so.
  await expect(alice.items.transfer(listing.deed, market.address)).rejects.toThrow(/soulbound/i)

  expect(market.listing(listing.asset)!.state).toBe('trading')
  expect(BigInt(market.listing(listing.asset)!.reserve)).toBe(reserved)
})

test('a carpet deed sent back pays out the whole reserve and kills the coin', async () => {
  const listing = (await market.facts()).listings.find((entry) => entry.symbol === 'SECOND')!
  await buy(alice, listing, 2n * KEI_RAW)

  const reserve = BigInt(market.listing(listing.asset)!.reserve)
  expect(reserve).toBeGreaterThan(0n)

  await bob.sync()
  const before = await keiOf(bob)
  await bob.items.transfer(listing.deed, market.address)

  const rugged = await until('the rug', async () => {
    const now = market.listing(listing.asset)
    return now?.state === 'rugged' ? now : undefined
  })

  expect(rugged.reserve).toBe('0')
  expect((await keiOf(bob)) - before).toBe(reserve)

  // The holder still holds. That is the point: the coins were always theirs, and
  // being theirs never meant being worth anything.
  expect(await coinsOf(alice, listing.asset)).toBeGreaterThan(0n)
})

test('a rugged coin buys nothing and sells nothing', async () => {
  const listing = (await market.facts()).listings.find((entry) => entry.symbol === 'SECOND')!
  await expect(market.quoteBuy(alice.address, listing.asset, KEI_RAW.toString())).rejects.toThrow(/rugged/i)

  const held = await coinsOf(alice, listing.asset)
  const before = await keiOf(alice)
  const token = await alice.token(listing.asset)
  await token.transfer(market.address, held.toString())

  // Sent back rather than pocketed, so a mistake costs nothing.
  await until('the coins to come back', async () =>
    (await coinsOf(alice, listing.asset)) === held ? true : undefined,
  )
  expect(await keiOf(alice)).toBe(before)
})

test('crossing the graduation reserve closes the curve and drops a badge', async () => {
  const listing = await launch(alice, 'GRAD', 'carpet')

  // Enough to cross the line in one buy; the market charges the curve and
  // returns the rest, so overshooting is free.
  await buy(bob, listing, 20n * KEI_RAW)

  const done = await until('graduation', async () => {
    const now = market.listing(listing.asset)
    return now?.state === 'graduated' ? now : undefined
  })
  expect(BigInt(reserveAt(BigInt(done.sold)))).toBeGreaterThanOrEqual(GRADUATION_RAW)

  await expect(market.quoteBuy(bob.address, listing.asset, KEI_RAW.toString())).rejects.toThrow(/graduated/i)

  // The badge is one commit covering every holder. It is not delivered: bob
  // collects the proof and writes his own claim, from his own chain.
  const bundles = await until('the graduation proof', async () => {
    const waiting = market.claimsFor(bob.address)
    return waiting.length > 0 ? waiting : undefined
  })
  expect(await bob.items.ownedBy().then((owned) => owned.some((i) => i.name === 'GRAD Graduate'))).toBe(false)

  for (const bundle of bundles) await bob.claims.add(bundle)
  const badge = (await bob.items.ownedBy()).find((item) => item.name === 'GRAD Graduate')
  expect(badge?.transferPolicy).toBe('none')

  // Handing the same proof out twice is safe, which is why the market does not
  // bother tracking who has collected: a second claim against a root this
  // account already claimed adds nothing. The ledger's double-claim index is
  // what makes that true, so the client can be careless and the badge still
  // cannot be duplicated.
  await bob.claims.add(bundles[0]!)
  expect(await bob.token(badge!.id).then((token) => token.balance())).toBe(1)
  // Graduation is the slowest thing the market does: a large mint, an asset
  // issuance, and a commit, all on one chain and therefore all in a row.
}, 30_000)

test('the deed to a graduated coin is worth nothing, transferable or not', async () => {
  const listing = (await market.facts()).listings.find((entry) => entry.symbol === 'GRAD')!
  expect(listing.lock).toBe('carpet')

  await alice.sync()
  const before = await keiOf(alice)
  await alice.items.transfer(listing.deed, market.address)
  await Bun.sleep(300)

  expect(market.listing(listing.asset)!.state).toBe('graduated')
  expect(await keiOf(alice)).toBe(before)
})

test('two coins cannot share a symbol, because they would share an asset id', async () => {
  await expect(
    market.quoteLaunch(bob.address, { symbol: 'SOLID', name: 'Impostor', blurb: '', lock: 'carpet' }),
  ).rejects.toThrow(/already listed/i)
})

test('bad identities are refused before anybody is charged', async () => {
  for (const bad of [
    { symbol: 'x', name: 'Lowercase and too short', lock: 'carpet' },
    { symbol: 'TOOLONGSYMBOL', name: 'Over ten characters', lock: 'carpet' },
    { symbol: '9LIVES', name: 'Starts with a digit', lock: 'carpet' },
    { symbol: 'FINE', name: 'x', lock: 'carpet' },
    { symbol: 'FINE', name: 'Bad lock', lock: 'maybe' },
  ]) {
    await expect(market.quoteLaunch(alice.address, { ...bad, blurb: '' })).rejects.toThrow()
  }
})
