/**
 * Choosing the chain, in one place, on both deployments.
 *
 * `bun run dev` and the Worker are different processes with different globals
 * and the same question in front of them: which ledger is this, and what does
 * `/rpc` do about it. Answering it twice is how the two copies end up disagreeing
 * about what they are — which on a page whose whole subject is "you can check
 * this yourself" is the worst possible bug.
 *
 * Two shapes come out of here.
 *
 *   mock      A `MockNode` in this process, and `/rpc` is that node's own
 *             handler. One process is the entire network.
 *   testnet   A URL, and `/rpc` is a pass-through to it. The Worker is not the
 *             chain in this mode and does not pretend to be: it forwards the
 *             browser's signed blocks to a node it does not run, which is also
 *             what makes the trade on the other side of them somebody else's.
 *
 * There is no third shape. `resolveMode` refuses mainnet by name rather than
 * falling through to a default, for the same reason `Kei.server()` refuses a
 * browser (SPEC §6.3): a guard that degrades quietly is a guard nobody finds.
 */

import { MockNode, mockRpcHandler, type KeiNode, type NetworkName } from 'kei-transaction'

import {
  NETWORKS,
  PUBLIC_TESTNET_RPC,
  resolveMode,
  type NetworkFacts,
  type NetworkMode,
} from '../shared/network.js'

export interface ChainSource {
  /** What the registry and the browser are both talking to. */
  node: KeiNode | string
  /** What the SDK should be told this network is called. */
  sdkNetwork: NetworkName
  /** What the client is told, and renders in the bar. */
  facts: NetworkFacts
  /** Whatever should answer `/rpc`. */
  rpc(request: Request): Promise<Response>
}

export interface ChainConfig {
  /** `CARPET_NETWORK`. Absent means mock. */
  network?: string | undefined
  /** `CARPET_NODE`. Only meaningful on testnet; defaults to the public node. */
  node?: string | undefined
  /** Kei the mock faucet hands out. Ignored on testnet, where the node decides. */
  faucetAmount?: number
  /** Worker-only: mock mutations can be replayed from Durable Object storage. */
  durable?: boolean
}

/**
 * Build the chain this process is going to serve.
 *
 * Async because a mock ledger has to exist before anything can be read from it,
 * and because keeping both branches the same shape is what stops the Worker and
 * the dev server drifting apart.
 */
export async function openChain(config: ChainConfig = {}): Promise<ChainSource> {
  const mode: NetworkMode = resolveMode(config.network)

  if (mode === 'testnet') {
    const url = config.node?.trim() || PUBLIC_TESTNET_RPC
    return {
      node: url,
      sdkNetwork: 'testnet',
      facts: { mode, sdkNetwork: 'testnet', node: url, ephemeral: false },
      rpc: (request) => passThrough(request, url),
    }
  }

  const node = await MockNode.create({ faucetAmount: config.faucetAmount ?? 25 })
  const handler = mockRpcHandler({ node })
  return {
    node,
    sdkNetwork: 'mock',
    facts: { mode, sdkNetwork: 'mock', node: null, ephemeral: !config.durable },
    rpc: (request) => handler(request),
  }
}

/**
 * Forward one RPC call to the real node.
 *
 * Deliberately dumb. It does not rewrite actions, filter them, cache them, or
 * add a header the node did not ask for — the browser's block is the browser's
 * block, and anything this function did to it on the way past would be a claim
 * about the chain that the chain had not made. The one thing it adds is CORS,
 * because the page is served from a different origin than the node and a static
 * export has nowhere else to put that.
 *
 * Being a pass-through is also what keeps the demo's own claim true: a reader
 * with the node's URL gets the same answers without going through here at all.
 */
async function passThrough(request: Request, url: string): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  let upstream: Response
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: await request.text(),
    })
  } catch {
    return Response.json(
      { error: `Could not reach the Kei node at ${url}. It is one box, best-effort, with no uptime promise (SPEC §15).` },
      { status: 502, headers: CORS },
    )
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json', ...CORS },
  })
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
}

/** The banner every entry point prints, so a running process says what it is. */
export function describeChain(facts: NetworkFacts): string {
  const network = NETWORKS[facts.mode]
  return `${network.label} — ${facts.node ?? 'in this process'}\n  ${network.summary}`
}
