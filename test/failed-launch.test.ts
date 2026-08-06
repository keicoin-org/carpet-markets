/**
 * `launch()` is four signed writes in sequence — fund the issuer, its receive,
 * the issue, the mint — and on a real node any of them can fail. Before this,
 * a failure past the first write left a burn-and-margin's worth of Kei sitting
 * on an issuing account `freshIssuer()` would never look at again, the payer's
 * fee with it, and the only record of any of it was one `console.error` line
 * (#28).
 *
 * `node` here is a real `MockNode` wrapped in a `Proxy` that fails exactly one
 * write — the `issue` block for a chosen symbol — so this exercises the actual
 * failure path rather than asserting behaviour registry.ts merely promises.
 * Everything else about the chain is real: the burn-funding send really lands
 * on the issuer, `recordFailure` really has to read that account back and send
 * it home.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Kei, MockNode, randomSeed, type Block, type KeiNode } from 'kei-transaction'

import { parseKei } from '../shared/format.js'
import { startRegistry, type Registry } from '../server/registry.js'

/** Fails the `issue` block for one symbol; everything else reaches the real node. */
function nodeThatFailsToIssue(real: KeiNode, symbol: string): KeiNode {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'process') {
        return async (block: Block) => {
          if (block.type === 'asset' && block.op.kind === 'issue' && block.op.symbol === symbol) {
            throw new Error(`simulated node failure issuing ${symbol}`)
          }
          return target.process(block)
        }
      }
      const value = Reflect.get(target, prop, receiver) as unknown
      // MockNode's own methods close over private fields, which a bare Proxy
      // forwards to the wrong `this` — bind everything back to the real node.
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as unknown as KeiNode
}

let mock: MockNode
let node: KeiNode
let registry: Registry
let alice: Kei

beforeAll(async () => {
  mock = await MockNode.create({ faucetAmount: 100 })
  node = nodeThatFailsToIssue(mock, 'DOOMED')
  registry = await startRegistry({ seed: randomSeed(), node, network: 'mock' })
  alice = await Kei.start({ node, network: 'mock', seed: randomSeed() })
  await alice.faucet(100)
})

afterAll(() => {
  registry.close()
  alice.close()
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

test('a launch that fails after the fee lands is refunded, reclaimed, and recorded', async () => {
  const before = await (async () => {
    await alice.sync()
    return BigInt((await mock.accountInfo(alice.address))?.balance ?? '0')
  })()

  const quote = await registry.quoteLaunch(alice.address, {
    symbol: 'DOOMED',
    name: 'Never Issued',
    blurb: '',
    transfer: 'open',
  })
  await alice.pay({ to: quote.to, amount: quote.fee })

  const failure = await until('DOOMED to be recorded as a failure', async () => registry.failures()[0])

  // The failure this file is about, not somebody else's.
  expect(failure.symbol).toBe('DOOMED')
  expect(failure.creator).toBe(alice.address)
  expect(failure.error).toContain('simulated node failure')

  // Never listed — the issue block itself is what failed.
  expect((await registry.facts()).listings.some((entry) => entry.symbol === 'DOOMED')).toBe(false)

  // The fee came back. Not "eventually consistent" — refund happens inside the
  // same write that recorded the failure, before this poll could observe it.
  // Compared as raw amounts, not strings: `payment.amount` round-trips through
  // a JS double (registry.ts's own DUST_RAW comment explains why 1.1 can come
  // back as 1.0999999999999999), so an exact string match is the wrong check.
  const paidRaw = parseKei(quote.fee)
  const refundedRaw = parseKei(failure.refunded)
  expect(refundedRaw).toBeGreaterThan(paidRaw - 1_000_000_000n)
  await alice.sync()
  const after = BigInt((await mock.accountInfo(alice.address))?.balance ?? '0')
  expect(after).toBeGreaterThanOrEqual(before - 1_000_000n) // dust, not a real loss

  // The burn-and-margin send to the issuer landed before the issue block
  // failed, so it was real Kei sitting on an account `freshIssuer` will never
  // reuse — reclaimed back to the registry rather than left there.
  expect(failure.issuer).not.toBeNull()
  expect(failure.reclaimed).not.toBe('0')

  const issuerInfo = await mock.accountInfo(failure.issuer!)
  expect(BigInt(issuerInfo?.balance ?? '0')).toBe(0n)
})
