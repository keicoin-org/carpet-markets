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
import { randomSeed } from 'kei-transaction'

import { openChain, type ChainSource } from '../server/network.js'
import { ListingError } from '../shared/listing.js'
import { NetworkRefused } from '../shared/network.js'
import { ReplyError } from '../shared/social.js'
import { RegistryError, startRegistry, type Registry } from '../server/registry.js'
import { Threads, type PostReply } from '../server/social.js'

interface Env {
  ASSETS: Fetcher
  FLOOR: DurableObjectNamespace<Floor>
  /** Optional. Without it the market is new on every boot, which is fine here. */
  CARPET_SEED?: string
  /**
   * `mock` (the default) or `testnet`. `mainnet` is refused, loudly, on boot.
   *
   * It is a variable rather than a constant because the same bundle is served
   * from more than one place and the honest answer differs — and because the
   * client reads it back out of `/market/facts` rather than out of its own
   * build, so a deploy that changes this changes the badge with it.
   */
  CARPET_NETWORK?: string
  /** The node URL when `CARPET_NETWORK=testnet`. Defaults to the public one. */
  CARPET_NODE?: string
}

/** Everything under the mount point that is not a static file. */
const MOUNT = '/examples/carpet-markets'

function apiPath(url: URL): string | null {
  const path = url.pathname.startsWith(MOUNT) ? url.pathname.slice(MOUNT.length) : url.pathname
  return path === '/rpc' || path.startsWith('/market/') ? path : null
}

export class Floor extends DurableObject<Env> {
  #booting: Promise<{ registry: Registry; chain: ChainSource }> | undefined

  /**
   * The reply threads, in memory beside the chain and lost with it.
   *
   * They are not persisted to the object's storage on purpose. A thread that
   * outlived the coins it is about would be a wall of comments on assets that no
   * longer exist, which is a worse artefact than an empty page.
   */
  readonly #threads = new Threads()

  /**
   * One chain and one registry, built on the first request and kept.
   *
   * On the mock the object *is* the chain, so an eviction resets the market — an
   * empty board means the object restarted rather than that nobody came. On the
   * testnet the object is not the chain at all: it holds the registry, and
   * `/rpc` is a pass-through to a node somewhere else, so an eviction loses the
   * list of coins and none of the blocks.
   */
  #ready(): Promise<{ registry: Registry; chain: ChainSource }> {
    this.#booting ??= (async () => {
      const chain = await openChain({
        network: this.env.CARPET_NETWORK,
        node: this.env.CARPET_NODE,
      })
      const registry = await startRegistry({
        seed: this.env.CARPET_SEED ?? randomSeed(),
        node: chain.node,
        network: chain.sdkNetwork,
        chain: chain.facts,
        replyCount: (asset) => this.#threads.count(asset),
      })
      return { registry, chain }
    })()
    return this.#booting
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = apiPath(url)
    if (!path) return new Response('Not found', { status: 404 })

    let registry: Registry
    let chain: ChainSource
    try {
      ;({ registry, chain } = await this.#ready())
    } catch (error) {
      // A refused network is a deployment mistake, and it has to read like one:
      // an object that half-booted and served a mock instead would be the exact
      // quiet degradation `shared/network.ts` exists to prevent.
      this.#booting = undefined
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: message }, error instanceof NetworkRefused ? 503 : 500)
    }

    if (path === '/rpc') return chain.rpc(request)

    try {
      switch (path) {
        case '/market/facts':
          return json(await registry.facts())

        case '/market/book':
          return json(await registry.book(url.searchParams.get('asset') ?? ''))

        case '/market/holders':
          return json({ holders: await registry.holders(url.searchParams.get('asset') ?? '') })

        case '/market/activity': {
          const asked = Number(url.searchParams.get('limit') ?? 24)
          return json({ trades: await registry.activity(Number.isFinite(asked) ? asked : 24) })
        }

        case '/market/replies':
          return json({ replies: this.#threads.list(url.searchParams.get('asset') ?? '') })

        case '/market/reply': {
          const body = await read<PostReply>(request)
          if (!registry.listing(body.asset)) throw new ListingError('That coin is not listed here.')
          return json(await this.#threads.add(body))
        }

        case '/market/launch': {
          const body = await read<{ address: string } & Record<string, unknown>>(request)
          return json(await registry.quoteLaunch(body.address, body))
        }

        case '/market/watch': {
          const { address } = await read<{ address: string }>(request)
          registry.watch(address)
          return json({ watching: true })
        }

        default:
          return new Response('Not found', { status: 404 })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const theirs = error instanceof ListingError || error instanceof RegistryError || error instanceof ReplyError
      return json({ error: message }, theirs ? 400 : 500)
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
