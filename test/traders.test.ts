/**
 * `watch` is the one write an unauthenticated caller gets to make against the
 * registry's own state, and it used to be unauthenticated *and* unbounded: any
 * string starting with `kei_` grew `traders` forever, and `traders` is what
 * `holders()` walks at one `balanceOf` per entry, per coin, on every `facts()`
 * (#29, #33).
 *
 * Both halves of the fix are checked here without timing anything, because a
 * duration-based assertion on a suite that also mines real proof-of-work is
 * exactly the kind of test that flakes under a loaded runner (see the history
 * of test/ticker.test.ts). Instead this watches a real holder fall out of
 * `holders()` once the roster fills around them, and come back once they are
 * re-announced — which is the only thing a caller of this registry can
 * actually observe either property through.
 *
 * The subject has to be a *buyer*, not a launch's creator: `holders()` always
 * adds a coin's own creator and issuer to the candidates it reads, regardless
 * of the roster, so eviction would never be visible on them. A buyer is in
 * `holders()` only because `traders` says so, which is exactly the path #29
 * and #33 are about.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { addressFromPublicKey, keyPairFromSeed } from '@keicoin/core'
import { Kei, MockNode, randomSeed } from 'kei-transaction'

import { startRegistry, type Registry } from '../server/registry.js'

/** Kei per single coin. Small, because a fresh coin is worth almost nothing. */
const UNIT_PRICE = 0.0002

let node: MockNode
let registry: Registry
let carol: Kei
let dave: Kei

beforeAll(async () => {
  node = await MockNode.create({ faucetAmount: 100 })
  registry = await startRegistry({ seed: randomSeed(), node, network: 'mock' })
  carol = await Kei.start({ node, network: 'mock', seed: randomSeed() })
  dave = await Kei.start({ node, network: 'mock', seed: randomSeed() })
  await carol.faucet(100)
  await dave.faucet(100)
})

afterAll(() => {
  registry.close()
  carol.close()
  dave.close()
})

/** `TRADER_LIMIT` in server/registry.ts. Not exported — this is the ceiling from the outside. */
const TRADER_LIMIT = 128

/** Real, distinct addresses, cheap to derive and never touching the node. */
async function realAddresses(count: number): Promise<string[]> {
  const seed = randomSeed()
  const out: string[] = []
  for (let index = 0; index < count; index++) {
    const pair = await keyPairFromSeed(seed, index)
    out.push(addressFromPublicKey(pair.publicKey))
  }
  return out
}

async function launch(who: Kei, symbol: string): Promise<string> {
  const quote = await registry.quoteLaunch(who.address, {
    symbol,
    name: `${symbol} Coin`,
    blurb: '',
    transfer: 'open',
  })
  await who.pay({ to: quote.to, amount: quote.fee })
  const listing = await until(symbol + ' to be listed', async () =>
    (await registry.facts()).listings.find((entry) => entry.symbol === symbol),
  )
  return listing.asset
}

test('watch refuses anything that is not a real address, so it never costs a roster slot', async () => {
  const asset = await launch(carol, 'ROSTER')
  const offer = await carol.market.sell({ asset, amount: 1_000, price: 1_000 * UNIT_PRICE })
  await dave.market.accept(offer.hash)
  registry.watch(dave.address)
  expect((await registry.holders(asset)).some((row) => row.address === dave.address)).toBe(true)

  // The check this used to be — `address.startsWith('kei_')` — accepted every
  // one of these. If any of them had taken a roster slot, this flood alone
  // (more than TRADER_LIMIT) would already have pushed dave out below.
  for (let i = 0; i < TRADER_LIMIT * 2; i++) {
    registry.watch('kei_')
    registry.watch(`not-an-address-${i}`)
    registry.watch('kei_' + 'z'.repeat(60)) // right length, wrong checksum
  }

  expect((await registry.holders(asset)).some((row) => row.address === dave.address)).toBe(true)
})

test('the roster evicts the least recently announced entry once it fills, and re-announcing recovers it', async () => {
  const asset = await launch(carol, 'EVICT')
  const offer = await carol.market.sell({ asset, amount: 1_000, price: 1_000 * UNIT_PRICE })
  await dave.market.accept(offer.hash)
  registry.watch(dave.address)

  // A real holder — the accept above minted nothing, it moved units dave now
  // actually has — visible only because `watch` put him in `traders`.
  expect((await registry.holders(asset)).some((row) => row.address === dave.address)).toBe(true)

  for (const address of await realAddresses(TRADER_LIMIT)) registry.watch(address)

  // Still on chain, still holding what he bought — just no longer an account
  // this registry will spend a read on.
  expect((await registry.holders(asset)).some((row) => row.address === dave.address)).toBe(false)

  registry.watch(dave.address)
  expect((await registry.holders(asset)).some((row) => row.address === dave.address)).toBe(true)
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
