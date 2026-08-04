/**
 * The network badge, and the one thing it must never get wrong.
 *
 * A launchpad that leaves somebody unsure whether the coins are real has already
 * failed at the only part of it that is not a joke. Three rules are asserted
 * here because all three are load-bearing:
 *
 *   1. mainnet is refused by name, loudly, rather than falling back to a mock;
 *   2. an unrecognised network name is refused too, because `CARPET_NETWORK=tesnet`
 *      quietly serving a mock is exactly the failure the module exists to stop;
 *   3. the readiness verdict names what is missing, because "the swap RPC is
 *      served and the faucet is dry" needs a different fix from "nothing is there".
 */

import { expect, test } from 'bun:test'

import {
  MAINNET_GATES,
  NETWORKS,
  NetworkRefused,
  parseMode,
  PUBLIC_TESTNET_RPC,
  readiness,
  REQUIRED_STEPS,
  resolveMode,
  type ProbeStep,
} from '../shared/network.js'
import { openChain } from '../server/network.js'

const step = (id: string, ok: boolean): ProbeStep => ({ id, what: id, ok, detail: '', ms: 1 })
const all = (ok: boolean): ProbeStep[] => REQUIRED_STEPS.map((id) => step(id, ok))

// ------------------------------------------------------------------ the refusals

test('mainnet is refused by name and says why', () => {
  expect(() => resolveMode('mainnet')).toThrow(NetworkRefused)
  try {
    resolveMode('mainnet')
  } catch (error) {
    const message = (error as Error).message
    expect(message).toMatch(/refuses to run against mainnet/i)
    // Every gate is named in the refusal itself. A guard that will not say what
    // it is guarding gets disabled rather than read, and a boot message is the
    // one place somebody is definitely looking.
    for (const gate of MAINNET_GATES) expect(message).toContain(gate.spec)
  }
})

test('an unknown network is refused rather than defaulted', () => {
  // The typo case. Silently serving a mock under a name somebody chose
  // deliberately is the quiet degradation this whole module exists to prevent.
  expect(() => resolveMode('tesnet')).toThrow(NetworkRefused)
  expect(() => resolveMode('production')).toThrow(NetworkRefused)
  expect(() => resolveMode(7)).toThrow(NetworkRefused)
})

test('an absent setting is the mock, which is the safe default and the honest one', () => {
  expect(resolveMode(undefined)).toBe('mock')
  expect(resolveMode('')).toBe('mock')
  expect(resolveMode(null)).toBe('mock')
  expect(resolveMode('mock')).toBe('mock')
  expect(resolveMode('testnet')).toBe('testnet')
})

test('parseMode knows the three names and nothing else', () => {
  expect(parseMode('mainnet')).toBe('mainnet')
  expect(parseMode('nonsense')).toBeUndefined()
})

// ------------------------------------------------------------------- the badges

test('every mode has a badge, a sentence, and a paragraph that do not contradict each other', () => {
  for (const network of Object.values(NETWORKS)) {
    expect(network.label.length).toBeGreaterThan(3)
    expect(network.summary.length).toBeGreaterThan(40)
    expect(network.detail.length).toBeGreaterThan(120)
  }

  expect(NETWORKS.mock.selectable).toBe(true)
  expect(NETWORKS.testnet.selectable).toBe(true)
  expect(NETWORKS.mainnet.selectable).toBe(false)
  expect(NETWORKS.mainnet.tone).toBe('refused')
})

test('neither runnable mode is described as worth anything', () => {
  // The demo must not read as production-ready, near-production, or awaiting a
  // launch (SPEC §9.6). The testnet copy is the one at risk, because it is the
  // one that is genuinely a real network.
  expect(NETWORKS.testnet.summary).toMatch(/worth nothing/i)
  expect(NETWORKS.testnet.detail).toMatch(/does not make anything valuable|worth nothing|not make anything valuable/i)
  for (const network of Object.values(NETWORKS)) {
    expect(network.detail).not.toMatch(/production[- ]ready|ready for mainnet|launch date/i)
  }
})

test('the deployed mock says eviction is durable without pretending it is a network', async () => {
  const chain = await openChain({ durable: true })
  expect(chain.facts.ephemeral).toBe(false)
  expect(NETWORKS.mock.summary).toMatch(/replays.*after eviction/i)
  expect(NETWORKS.mock.detail).toMatch(/not a network/i)
  expect(NETWORKS.mock.detail).toMatch(/does not give these coins value|worth nothing|no-value/i)
})

test('the mainnet gates name their own sections, so each claim is checkable', () => {
  expect(MAINNET_GATES.length).toBeGreaterThanOrEqual(4)
  for (const gate of MAINNET_GATES) {
    expect(gate.spec).toMatch(/^§\d+(\.\d+)*$/)
    expect(gate.why.length).toBeGreaterThan(60)
  }
  // The four that SPEC §15 and §17 actually block mainnet on.
  const sections = MAINNET_GATES.map((gate) => gate.spec)
  expect(sections).toContain('§15.1')
  expect(sections).toContain('§15.2')
  expect(sections).toContain('§15.3')
  expect(sections).toContain('§17')
})

// ----------------------------------------------------------------- the readiness

test('a node that passes everything is ready, and says what it carried', () => {
  const verdict = readiness(all(true))
  expect(verdict.ready).toBe(true)
  expect(verdict.missing).toEqual([])
  expect(verdict.verdict).toMatch(/issue, mint, offer, accept, cancel/)
})

test('a node that fails one step is not ready and the verdict names which', () => {
  const steps = all(true).map((entry) => (entry.id === 'rpc.faucet' ? step(entry.id, false) : entry))
  const verdict = readiness(steps)

  expect(verdict.ready).toBe(false)
  expect(verdict.missing).toEqual(['rpc.faucet'])
  expect(verdict.verdict).toMatch(/rpc\.faucet/)
})

test('an empty run is not accidentally ready', () => {
  const verdict = readiness([])
  expect(verdict.ready).toBe(false)
  expect(verdict.missing).toEqual([...REQUIRED_STEPS])
})

test('the required list covers the whole swap path rather than just the reads', () => {
  for (const id of ['op.issue', 'op.mint', 'op.swap_offer', 'op.swap_accept', 'op.swap_cancel', 'policy.soulbound']) {
    expect(REQUIRED_STEPS).toContain(id)
  }
})

test('the public node is the one SPEC §15 says the project runs', () => {
  expect(PUBLIC_TESTNET_RPC).toBe('https://testnet.keicoin.org/rpc')
})
