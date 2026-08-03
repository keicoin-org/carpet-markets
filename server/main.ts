/**
 * The backend half of `bun run dev`. Two things, and only one is the market:
 *
 *   /rpc        a Kei node. In-memory, and a development tool — point this at a
 *               real one and nothing above this line changes.
 *   /market/*   the registry, which is `server/registry.ts`, plus the reply
 *               threads, which are `server/social.ts` and are not on the chain.
 *
 * The client is Next.js and is served by `next dev` on its own port, which
 * proxies both paths back here (see `next.config.mjs`). In the deployed copy
 * neither of them is a proxy: the Worker serves the exported client as static
 * files and answers these same two paths out of a Durable Object.
 *
 * The player's browser talks to the node directly and signs everything it
 * writes; this server never sees a player's key and cannot move their coins.
 */

import { MockNode, mockRpcHandler, randomSeed } from 'kei-transaction'

import { ListingError } from '../shared/listing.js'
import { ReplyError } from '../shared/social.js'
import { RegistryError, startRegistry } from './registry.js'
import { Threads, type PostReply } from './social.js'

const port = Number(process.env.PORT ?? 7788)

// A fresh chain every run, because it is in memory. A player's wallet lives in
// their browser and outlives it, so they come back to an empty account on a new
// chain — the honest behaviour for a mock, and the reason nothing here is worth
// anything.
const node = await MockNode.create({ faucetAmount: 25 })
const rpc = mockRpcHandler({ node })

// Off-chain, and the only thing here that is. See `server/social.ts`.
const threads = new Threads()

const registry = await startRegistry({
  seed: process.env.CARPET_SEED ?? randomSeed(),
  node,
  network: 'mock',
  replyCount: (asset) => threads.count(asset),
})

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { 'access-control-allow-origin': '*' } })

const failed = (error: unknown): Response =>
  json(
    { error: error instanceof Error ? error.message : String(error) },
    error instanceof ListingError || error instanceof RegistryError || error instanceof ReplyError ? 400 : 500,
  )

async function read<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T
  } catch {
    throw new ListingError('That request was not JSON.')
  }
}

const server = Bun.serve({
  port,
  routes: {
    '/rpc': { POST: rpc, OPTIONS: rpc },

    '/market/facts': {
      async GET() {
        try {
          return json(await registry.facts())
        } catch (error) {
          return failed(error)
        }
      },
    },

    // The order book and the trade history, both read off the chains of the
    // accounts the registry knows about. Nothing here is the server's opinion.
    '/market/book': {
      async GET(request) {
        try {
          const asset = new URL(request.url).searchParams.get('asset') ?? ''
          return json(await registry.book(asset))
        } catch (error) {
          return failed(error)
        }
      },
    },

    // Who holds it. Read off the chain, and only as complete as the registry's
    // list of accounts to ask about — see `holders` in server/registry.ts.
    '/market/holders': {
      async GET(request) {
        try {
          const asset = new URL(request.url).searchParams.get('asset') ?? ''
          return json({ holders: await registry.holders(asset) })
        } catch (error) {
          return failed(error)
        }
      },
    },

    '/market/replies': {
      async GET(request) {
        const asset = new URL(request.url).searchParams.get('asset') ?? ''
        return json({ replies: threads.list(asset) })
      },
    },

    '/market/reply': {
      async POST(request) {
        try {
          const body = await read<PostReply>(request)
          if (!registry.listing(body.asset)) throw new ListingError('That coin is not listed here.')
          return json(await threads.add(body))
        } catch (error) {
          return failed(error)
        }
      },
    },

    '/market/launch': {
      async POST(request) {
        try {
          const body = await read<{ address: string } & Record<string, unknown>>(request)
          return json(await registry.quoteLaunch(body.address, body))
        } catch (error) {
          return failed(error)
        }
      },
    },

    // "I am somebody whose chain may carry an offer." The registry cannot see a
    // settlement it was not part of, so a buyer says so itself.
    '/market/watch': {
      async POST(request) {
        try {
          const { address } = await read<{ address: string }>(request)
          registry.watch(address)
          return json({ watching: true })
        } catch (error) {
          return failed(error)
        }
      },
    },
  },
})

console.log(`
  Carpet Markets — the registry and the chain.

  api           ${server.url}
  node (mock)   ${server.url}rpc
  registry      ${registry.address}

  The client is next dev, on :3000, and proxies /rpc and /market/* to here.

  The registry issues coins and remembers who to read. It does not price
  anything and never holds a coin: every trade here is an offer one player wrote
  and another accepted, settled in one block by consensus.

  This chain is in memory and dies with this process. Every coin you can launch
  here is worthless by construction, which is what makes it safe to show you how
  the dump works.
`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    registry.close()
    void server.stop(true).then(() => process.exit(0))
  })
}
