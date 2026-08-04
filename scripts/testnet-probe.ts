/**
 * Does the public testnet actually do the things this demo needs?
 *
 * The demo runs against a mock chain, and the reason it does is a claim rather
 * than a preference: that the public node is not ready to carry a market. A
 * claim like that goes stale silently, so this file checks it instead of
 * asserting it, and prints a report somebody can paste into a pull request.
 *
 * It walks the whole path a launch and a trade take — faucet, issue, mint,
 * `swap_offer`, `swap_accept`, `swap_cancel`, price history, and a refusal the
 * ledger is supposed to make — against whatever node it is pointed at. Every
 * step is recorded whether it passed or failed, because "the swap RPC is served
 * and the faucet is dry" is a different answer from "nothing is there", and only
 * one of them is fixed by funding an address.
 *
 *   bun run probe:testnet                            # the public testnet
 *   bun run scripts/testnet-probe.ts --node <url>    # anything else
 *   bun run scripts/testnet-probe.ts --json out.json # machine-readable
 *
 * It writes real blocks to whatever it is pointed at. Nothing on a testnet is
 * worth anything, which is the only reason that is acceptable — do not point it
 * at a network where that is not true.
 */

import { Kei, KeiError, randomSeed } from 'kei-transaction'
import type { IssuerToken } from 'kei-transaction'

import { PUBLIC_TESTNET_RPC, readiness, type ProbeReport, type ProbeStep } from '../shared/network.js'

const argv = Bun.argv.slice(2)

function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

const NODE = flag('node') ?? PUBLIC_TESTNET_RPC
const JSON_OUT = flag('json')

/** A ticker nothing else on the network is using, so `issue` is not idempotent onto somebody else's coin. */
const stamp = (prefix: string): string => `${prefix}${Date.now().toString(36).slice(-4).toUpperCase()}`

const steps: ProbeStep[] = []
const started = Date.now()

async function step(id: string, what: string, job: () => Promise<string>): Promise<boolean> {
  const at = Date.now()
  try {
    const detail = await job()
    steps.push({ id, what, ok: true, detail, ms: Date.now() - at })
    console.log(`  ok    ${what}\n        ${detail}`)
    return true
  } catch (error) {
    const detail = error instanceof KeiError || error instanceof Error ? error.message : String(error)
    steps.push({ id, what, ok: false, detail, ms: Date.now() - at })
    console.log(`  FAIL  ${what}\n        ${detail}`)
    return false
  }
}

/** A step that passes when the ledger *refuses*, which is most of the point. */
function refusal(id: string, what: string, job: () => Promise<unknown>): Promise<boolean> {
  return step(id, what, async () => {
    try {
      await job()
    } catch (error) {
      return `refused: ${error instanceof Error ? error.message : String(error)}`
    }
    throw new Error('the ledger allowed it, so the policy is not enforced on this network')
  })
}

async function rpc<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(NODE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  if (!response.ok) throw new Error(`the node answered ${response.status} for "${action}"`)
  const body = (await response.json()) as { error?: string } & T
  if (body && typeof body === 'object' && typeof body.error === 'string') throw new Error(body.error)
  return body
}

console.log(`\n  Carpet Markets — network readiness probe\n  node: ${NODE}\n`)

// ------------------------------------------------------------------ node identity

let version: Record<string, string> = {}

await step('rpc.version', 'the node answers `version`', async () => {
  version = await rpc<Record<string, string>>('version')
  return `${version.node_vendor ?? 'unknown vendor'}, network "${version.network ?? '?'}", protocol ${version.protocol_version ?? '?'}`
})

await step('rpc.work_thresholds', 'work tiers A, B and C are published (SPEC §5.6.4)', async () => {
  const body = await rpc<{ thresholds?: Record<string, string> }>('work_thresholds')
  const tiers = Object.keys(body.thresholds ?? {}).sort()
  if (tiers.join('') !== 'ABC') throw new Error(`got tiers ${tiers.join(', ') || 'none'}, expected A, B and C`)
  return 'A/B/C present, so this is a Kei node rather than a stock Banano one'
})

await step('rpc.swap_info', '`swap_info` is served — the §9.2 read path exists', async () => {
  const body = await rpc<{ offer?: unknown }>('swap_info', { hash: '0'.repeat(64) })
  if (!('offer' in body)) throw new Error('no `offer` field in the answer')
  return 'answers `offer: null` for an unknown hash rather than an unknown-action error'
})

// ------------------------------------------------------------------- the M5 walk

let coin: IssuerToken | undefined
let offerHash: string | undefined

/**
 * Three wallets, or nothing.
 *
 * Returned rather than assigned to outer `let`s, because TypeScript will not
 * carry a narrowing across the closure boundary of every step below and the
 * alternative is a non-null assertion on each of forty lines.
 */
let wallets: { issuer: Kei; seller: Kei; buyer: Kei } | undefined

await step('sdk.connect', 'three wallets open against it', async () => {
  const [issuer, seller, buyer] = await Promise.all([
    Kei.server({ seed: randomSeed(), node: NODE, network: 'testnet' }),
    Kei.server({ seed: randomSeed(), node: NODE, network: 'testnet' }),
    Kei.server({ seed: randomSeed(), node: NODE, network: 'testnet' }),
  ])
  wallets = { issuer, seller, buyer }
  return `issuer ${issuer.address.slice(0, 16)}…, plus a seller and a buyer`
})

if (wallets) {
  const { issuer, seller, buyer } = wallets
  const them = [issuer, seller, buyer] as const

  const funded = await step('rpc.faucet', 'the faucet funds three cold addresses', async () => {
    await Promise.all(them.map((wallet) => wallet.faucet(25)))
    await Promise.all(them.map((wallet) => wallet.sync()))
    const balances = await Promise.all(them.map((wallet) => wallet.balance()))
    if (balances.some((amount) => amount <= 0)) throw new Error(`balances came back ${balances.join(', ')}`)
    return `issuer ${balances[0]} Kei, seller ${balances[1]} Kei, buyer ${balances[2]} Kei`
  })

  if (funded) {
    await step('op.issue', '`issue` writes an asset and burns Kei (SPEC §5.6.5)', async () => {
      const before = await issuer.balance()
      coin = await issuer.token.issue({
        name: 'Probe Carpet',
        symbol: stamp('PRB'),
        decimals: 0,
        maxSupply: 1_000_000,
        transfer: 'open',
        swap: 'off',
      })
      const after = await issuer.balance()
      if (after >= before) throw new Error(`balance did not fall: ${before} → ${after}, so nothing was burned`)
      return `asset ${coin.id.slice(0, 12)}…, issuer balance ${before} → ${after} Kei`
    })
  }

  if (coin) {
    const asset = coin.id

    await step('op.mint', '`mint` credits a holder, arriving as a receivable (SPEC §5.6.3)', async () => {
      await coin!.mint(seller.address, 10_000)
      const owed = await seller.client.node.receivables(seller.address)
      await seller.sync()
      const held = await (await seller.token(asset)).balance()
      if (held !== 10_000) throw new Error(`seller holds ${held} after sync, expected 10,000`)
      return `${owed.length} receivable waiting before sync, 10,000 units held after it`
    })

    await step('op.swap_offer', '`swap_offer` locks the seller’s own units (SPEC §9.2)', async () => {
      const offer = await seller.market.sell({ asset, amount: 1_000, price: 0.5 })
      offerHash = offer.hash
      const left = await (await seller.token(asset)).balance()
      if (left !== 9_000) throw new Error(`seller shows ${left} spendable, expected 9,000 with 1,000 locked`)
      return `offer ${offer.hash.slice(0, 12)}…, 1,000 units out of the spendable balance`
    })

    await step('op.offers_read', 'the offer is readable off the seller’s own chain (SPEC §9.4)', async () => {
      const open = await buyer.market.offers({ from: seller.address, asset, state: 'open' })
      if (open.length !== 1) throw new Error(`read ${open.length} open offers, expected 1`)
      return `${open[0]!.price} Kei each, ${open[0]!.want.amount} Kei for the lot`
    })

    if (offerHash) {
      await step('op.swap_accept', '`swap_accept` settles both legs in one block (SPEC §9.2)', async () => {
        const before = await buyer.balance()
        const settlement = await buyer.market.accept(offerHash!)
        await Promise.all([buyer.sync(), seller.sync()])
        const bought = await (await buyer.token(asset)).balance()
        const after = await buyer.balance()
        if (bought !== 1_000) throw new Error(`buyer holds ${bought} after settling, expected 1,000`)
        return `paid ${(before - after).toFixed(4)} Kei for 1,000 units, block ${settlement.hash.slice(0, 12)}…`
      })
    }

    await step('op.swap_cancel', '`swap_cancel` returns the lock to the offerer', async () => {
      const before = await (await seller.token(asset)).balance()
      const offer = await seller.market.sell({ asset, amount: 500, price: 0.25 })
      const locked = await (await seller.token(asset)).balance()
      await seller.market.cancel(offer.hash)
      const after = await (await seller.token(asset)).balance()
      if (after !== before) throw new Error(`balance went ${before} → ${locked} → ${after}, expected to come back to ${before}`)
      return `${before} → ${locked} while listed → ${after} after the cancel`
    })

    await step('op.price', 'price history reads off the settled blocks (SPEC §9.1)', async () => {
      const summary = await buyer.market.price(asset, { from: [seller.address, buyer.address] })
      if (!summary || summary.trades < 1) throw new Error('no settled trades in the history')
      return `${summary.trades} trade(s), last ${summary.last} Kei per unit, volume ${summary.volume}`
    })
  }

  await refusal('policy.soulbound', 'a soulbound coin cannot be offered at all (SPEC §5.4)', async () => {
    const bound = await issuer.token.issue({
      name: 'Probe Soulbound',
      symbol: stamp('SBD'),
      decimals: 0,
      maxSupply: 1_000,
      transfer: 'none',
      swap: 'off',
    })
    await bound.mint(seller.address, 100)
    await seller.sync()
    return seller.market.sell({ asset: bound.id, amount: 10, price: 1 })
  })

  for (const wallet of them) wallet.close()
}

// ------------------------------------------------------------------- the verdict

const verdict = readiness(steps)
const report: ProbeReport = {
  node: NODE,
  at: started,
  ms: Date.now() - started,
  vendor: version.node_vendor ?? null,
  network: version.network ?? null,
  steps,
  ...verdict,
}

const rule = '─'.repeat(66)
console.log(`\n  ${rule}`)
console.log(`  ${report.ready ? 'READY' : 'NOT READY'} — ${report.verdict}`)
console.log(`  ${steps.filter((entry) => entry.ok).length}/${steps.length} steps passed in ${report.ms} ms`)
console.log(`  ${rule}\n`)

if (JSON_OUT) {
  await Bun.write(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`  written to ${JSON_OUT}\n`)
}

process.exit(report.ready ? 0 : 1)
