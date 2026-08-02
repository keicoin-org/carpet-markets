/**
 * Carpet Markets, on Cloudflare, at keicoin.org/examples/carpet-markets.
 *
 * The same three things `bun run dev` serves locally are served here: the mock
 * node, the market, and the client.
 *
 * The chain lives in **one Durable Object**, because a chain that differed per
 * request would not be a chain — and because a market where two visitors saw
 * different prices for the same coin would be a worse joke than the one this
 * game is telling. That is also the honest shape of the thing: this is a
 * single-node mock, not a network, and a Durable Object is a single node. When
 * the object is evicted the chain resets, which the examples page says.
 *
 * The player's key never comes here. It is generated in their browser, kept in
 * their browser, and signs every block this Worker sees — including the one that
 * pulls the carpet.
 */

import { DurableObject } from 'cloudflare:workers'
import { MockNode, mockRpcHandler, randomSeed } from 'kei-transaction'

import { ListingError } from '../shared/listing.js'
import { MarketError, startMarket, type Market } from '../server/market.js'

interface Env {
  ASSETS: Fetcher
  FLOOR: DurableObjectNamespace<Floor>
  /** Optional. Without it the market is new on every boot, which is fine here. */
  CARPET_SEED?: string
}

/** Everything under the mount point that is not a static file. */
const MOUNT = '/examples/carpet-markets'

function apiPath(url: URL): string | null {
  const path = url.pathname.startsWith(MOUNT) ? url.pathname.slice(MOUNT.length) : url.pathname
  return path === '/rpc' || path.startsWith('/market/') ? path : null
}

export class Floor extends DurableObject<Env> {
  #booting: Promise<{ market: Market; rpc: (request: Request) => Promise<Response> }> | undefined

  /** One chain and one market, built on the first request and kept. */
  #ready(): Promise<{ market: Market; rpc: (request: Request) => Promise<Response> }> {
    this.#booting ??= (async () => {
      const node = await MockNode.create({ faucetAmount: 25 })
      const market = await startMarket({
        seed: this.env.CARPET_SEED ?? randomSeed(),
        node,
        network: 'mock',
      })
      return { market, rpc: mockRpcHandler({ node }) }
    })()
    return this.#booting
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = apiPath(url)
    if (!path) return new Response('Not found', { status: 404 })

    const { market, rpc } = await this.#ready()

    if (path === '/rpc') return rpc(request)

    try {
      switch (path) {
        case '/market/facts':
          return json(await market.facts())

        case '/market/claims':
          return json({ bundles: market.claimsFor(url.searchParams.get('address') ?? '') })

        case '/market/launch': {
          const body = await read<{ address: string } & Record<string, unknown>>(request)
          return json(await market.quoteLaunch(body.address, body))
        }

        case '/market/buy': {
          const { address, asset, budget } = await read<{ address: string; asset: string; budget: string }>(request)
          return json(await market.quoteBuy(address, asset, budget))
        }

        default:
          return new Response('Not found', { status: 404 })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: message }, error instanceof ListingError || error instanceof MarketError ? 400 : 500)
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (apiPath(url)) {
      // One name, so every visitor shares one market — which is what makes a
      // price a price rather than a save file.
      const floor = env.FLOOR.get(env.FLOOR.idFromName('carpet-markets'))
      return floor.fetch(request)
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

async function read<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T
  } catch {
    throw new ListingError('That request was not JSON.')
  }
}
