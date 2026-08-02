/**
 * `bun run dev` — the whole thing, one process.
 *
 * Three things live here and only one of them is the market:
 *
 *   /rpc        a Kei node. In-memory, and a development tool — point this at a
 *               real one and nothing above this line changes.
 *   /market/*   the issuer, which is `server/market.ts`.
 *   /           the client, bundled on startup.
 *
 * They share a process because it is one command, not because they belong
 * together. The player's browser talks to the node directly and signs everything
 * it writes; this server never sees a player's key and cannot move their coins.
 */

import { MockNode, mockRpcHandler, randomSeed } from 'kei-transaction'

import { ListingError } from '../shared/listing.js'
import { MarketError, startMarket } from './market.js'

/** Native, and with a trailing separator — `pathname` would hand Windows `/C:/…`. */
const root = Bun.fileURLToPath(new URL('..', import.meta.url))
const port = Number(process.env.PORT ?? 7788)

const bundle = await Bun.build({
  entrypoints: [`${root}src/main.ts`],
  outdir: `${root}public/build`,
  target: 'browser',
  sourcemap: 'linked',
})
if (!bundle.success) {
  for (const log of bundle.logs) console.error(log)
  process.exit(1)
}

// A fresh chain every run, because it is in memory. A player's wallet lives in
// their browser and outlives it, so they come back to an empty account on a new
// chain — the honest behaviour for a mock, and the reason nothing here is worth
// anything.
const node = await MockNode.create({ faucetAmount: 25 })
const rpc = mockRpcHandler({ node })

const market = await startMarket({
  seed: process.env.CARPET_SEED ?? randomSeed(),
  node,
  network: 'mock',
})

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { 'access-control-allow-origin': '*' } })

const failed = (error: unknown): Response =>
  json(
    { error: error instanceof Error ? error.message : String(error) },
    error instanceof ListingError || error instanceof MarketError ? 400 : 500,
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
    '/': () => new Response(Bun.file(`${root}index.html`), { headers: { 'content-type': 'text/html' } }),

    '/favicon.ico': () =>
      new Response(Bun.file(`${root}public/favicon.ico`), { headers: { 'content-type': 'image/x-icon' } }),

    '/build/*': (request) => {
      // Only what the bundler wrote, and only by name — no path walking. The
      // bundle is rebuilt on every start, so a cached one is always the wrong one.
      const name = new URL(request.url).pathname.slice('/build/'.length)
      if (!/^[\w.-]+$/.test(name)) return new Response('Not found', { status: 404 })
      return new Response(Bun.file(`${root}public/build/${name}`), { headers: { 'cache-control': 'no-store' } })
    },

    '/rpc': { POST: rpc, OPTIONS: rpc },

    '/market/facts': {
      async GET() {
        try {
          return json(await market.facts())
        } catch (error) {
          return failed(error)
        }
      },
    },

    // A commit publishes a root; the holder still has to write their own claim.
    // This is where the proof they need to do that is picked up.
    '/market/claims': {
      GET(request) {
        const address = new URL(request.url).searchParams.get('address') ?? ''
        return json({ bundles: market.claimsFor(address) })
      },
    },

    '/market/launch': {
      async POST(request) {
        try {
          const body = await read<{ address: string } & Record<string, unknown>>(request)
          return json(await market.quoteLaunch(body.address, body))
        } catch (error) {
          return failed(error)
        }
      },
    },

    '/market/buy': {
      async POST(request) {
        try {
          const { address, asset, budget } = await read<{ address: string; asset: string; budget: string }>(request)
          return json(await market.quoteBuy(address, asset, budget))
        } catch (error) {
          return failed(error)
        }
      },
    },
  },
})

console.log(`
  Carpet Markets — launch a coin, or don't.

  trade         ${server.url}
  node (mock)   ${server.url}rpc
  market        ${market.address}

  This chain is in memory and dies with this process. Every coin you can launch
  here is worthless by construction, which is what makes it safe to show you how
  the rug works.
`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    market.close()
    void server.stop(true).then(() => process.exit(0))
  })
}
