/**
 * A ticker identifies one coin, including while somebody is paying for it.
 *
 * The registry refuses a duplicate symbol because a launchpad where the ticker
 * in the listing does not identify the coin is a launchpad for impersonating the
 * coin above you. That refusal used to scan settled coins only, so the whole
 * window between a quote and its payment was open: two people could quote DOGE
 * inside the intent TTL, both pay a fee that is not refundable, and the board
 * would carry two coins nothing on it could tell apart (#17).
 *
 * The quote is where the check has to live, because that is the last moment
 * before somebody spends. Refusing at settlement would refuse after the burn.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Kei, MockNode, randomSeed } from 'kei-transaction'

import { startRegistry, type Registry } from '../server/registry.js'

/** Short enough that a test can outlive a quote without sleeping for two minutes. */
const TTL_MS = 300

let node: MockNode
let registry: Registry
let alice: Kei
let bob: Kei

beforeAll(async () => {
  node = await MockNode.create({ faucetAmount: 100 })
  registry = await startRegistry({ seed: randomSeed(), node, network: 'mock', intentTtlMs: TTL_MS })
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

// Same shape as the `until` helper in registry.test.ts / ledger-claims.test.ts /
// terms.test.ts. A 15 s default deadline is generous for the mock node, but the
// settlement below signs a real block with proof of work behind it, and a loaded
// runner has occasionally taken longer than that — hence the wider budget at the
// one call site here that waits on it, matching what those other files do for
// their own settling cases.
async function until<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await Bun.sleep(25)
  }
}

test('a second launcher cannot quote a ticker somebody is already paying for', async () => {
  await registry.quoteLaunch(alice.address, identity('DOGE'))

  // Nothing has settled, so the old check — which read `coins` — saw an empty
  // board and let this through. Both would then have paid a fee that buys a burn.
  await expect(registry.quoteLaunch(bob.address, identity('DOGE'))).rejects.toThrow(/claimed a moment ago/)
})

test('re-quoting your own ticker is still idempotent', async () => {
  await registry.quoteLaunch(alice.address, identity('KILIM'))

  // A launcher who edits the blurb and submits again is the same intent, not a
  // competitor for their own symbol.
  const again = await registry.quoteLaunch(alice.address, { ...identity('KILIM'), blurb: 'Reworded.' })
  expect(again.symbol).toBe('KILIM')
})

test('an abandoned quote stops holding its ticker once the TTL passes', async () => {
  await registry.quoteLaunch(alice.address, identity('FRINGE'))
  await expect(registry.quoteLaunch(bob.address, identity('FRINGE'))).rejects.toThrow(/claimed a moment ago/)

  // Alice never pays. The sweep runs inside the check rather than only when the
  // map is next written to, so the symbol frees itself.
  await Bun.sleep(TTL_MS + 50)
  const bobs = await registry.quoteLaunch(bob.address, identity('FRINGE'))
  expect(bobs.symbol).toBe('FRINGE')
})

test('a settled ticker is still refused after its intent is long gone', async () => {
  const quote = await registry.quoteLaunch(alice.address, identity('WARP'))
  await alice.pay({ to: quote.to, amount: quote.fee })

  await until(
    'WARP to be listed',
    async () => (await registry.facts()).listings.find((entry) => entry.symbol === 'WARP'),
    40_000,
  )

  // The intent was consumed by the settlement, so this is the settled-coin check
  // doing its original job — the new one must not have replaced it.
  await expect(registry.quoteLaunch(bob.address, identity('WARP'))).rejects.toThrow(/already listed here/)
  // Past the 40 s wait above with room to spare: this is the one case here that
  // waits on a real settlement — a payment, the registry noticing it, and an
  // issuance with its proof-of-work — and bun's 5 s default was never going to
  // reach a deadline that long. The rest of the suite already carries explicit
  // timeouts for the same reason.
}, 45_000)
