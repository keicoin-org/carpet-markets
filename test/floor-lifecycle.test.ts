import { expect, mock, test } from 'bun:test'
import { HttpNode, keyPairFromSeed, signHash } from '@keicoin/core'
import { Kei } from 'kei-transaction'

import { cleanReply, replyHash } from '../shared/social.js'
import type { Book, Holder, MarketFacts } from '../shared/listing.js'
import type { Reply } from '../shared/social.js'

mock.module('cloudflare:workers', () => ({
  DurableObject: class<Environment> {
    readonly ctx: FakeState
    readonly env: Environment

    constructor(ctx: FakeState, env: Environment) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

interface FloorLike {
  fetch(request: Request): Promise<Response>
}

const { Floor } = (await import('../worker/' + 'index.ts')) as {
  Floor: new (state: unknown, env: unknown) => FloorLike
}

class FakeStorage {
  readonly values = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async put(key: string, value: unknown): Promise<void>
  async put(entries: Record<string, unknown>): Promise<void>
  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof keyOrEntries === 'string' ? { [keyOrEntries]: value } : keyOrEntries
    for (const [key, entry] of Object.entries(entries)) this.values.set(key, structuredClone(entry))
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key)
  }

  async list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    const rows = [...this.values.entries()]
      .filter(([key]) => key.startsWith(options.prefix ?? ''))
      .sort(([left], [right]) => left.localeCompare(right))
    return new Map(rows) as Map<string, T>
  }

  async transaction<T>(callback: (storage: FakeStorage) => Promise<T>): Promise<T> {
    return callback(this)
  }
}

class FakeState {
  constructor(readonly storage: FakeStorage) {}

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback()
  }
}

const environment = { CARPET_NETWORK: 'mock' }
const BUYER_SEED = '29'.repeat(32)

function openFloor(storage: FakeStorage, env: Record<string, string> = environment): FloorLike {
  return new Floor(new FakeState(storage), env)
}

function call(floor: FloorLike, path: string, body?: unknown): Promise<Response> {
  return floor.fetch(
    new Request(`https://example.test/examples/carpet-markets${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }),
  )
}

async function answer<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { error?: string } & T
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

function nodeFor(floor: FloorLike): HttpNode {
  return new HttpNode({
    url: 'https://example.test/examples/carpet-markets/rpc',
    network: 'mock',
    pollInterval: 60_000,
    fetch: ((input, init) => floor.fetch(new Request(input, init))) as typeof fetch,
  })
}

test(
  'the actual Floor replays its seeded ledger, first buy, holder, and signed reply after eviction',
  async () => {
    const storage = new FakeStorage()
    const first = openFloor(storage)
    const [initial, simultaneous] = await Promise.all([
      call(first, '/market/facts').then(answer<MarketFacts>),
      call(first, '/market/facts').then(answer<MarketFacts>),
    ])

    expect(initial.chain.mode).toBe('mock')
    expect(initial.listings).toHaveLength(6)
    expect(simultaneous.listings.map((listing) => listing.asset)).toEqual(
      initial.listings.map((listing) => listing.asset),
    )
    expect(
      [...storage.values.values()].filter(
        (value) => typeof value === 'object' && value !== null && (value as { kind?: string }).kind === 'seed',
      ),
    ).toHaveLength(1)
    expect(
      [...storage.values.values()].find(
        (value) => typeof value === 'object' && value !== null && (value as { kind?: string }).kind === 'seed',
      ),
    ).toHaveProperty('status', 'accepted')
    expect(initial.listings.some((listing) => (listing.stats?.asks ?? 0) > 0)).toBe(true)

    const beforeRejected = [...storage.values.keys()].filter((key) => key.startsWith('event:v1:'))
    const rejected = await call(first, '/rpc', { action: 'process', block: {} })
    expect((await rejected.json()) as { error?: string }).toHaveProperty('error')
    expect([...storage.values.keys()].filter((key) => key.startsWith('event:v1:'))).toEqual(beforeRejected)

    const listing = initial.listings.find((entry) => entry.symbol === 'FRINGE')!
    const before = await answer<Book>(await call(first, `/market/book?asset=${listing.asset}`))
    expect(before.asks).toHaveLength(1)

    const buyer = await Kei.server({ seed: BUYER_SEED, node: nodeFor(first), network: 'mock' })
    await buyer.faucet(50)
    await buyer.sync()
    await answer(await call(first, '/market/watch', { address: buyer.address }))
    await buyer.market.accept(before.asks[0]!.hash)
    await buyer.sync()

    const keys = await keyPairFromSeed(BUYER_SEED, 0)
    const body = cleanReply('first buy survived the cold start')
    const at = Date.now()
    const signature = await signHash(keys.privateKey, replyHash({ asset: listing.asset, body, at }))
    await answer(
      await call(first, '/market/reply', { asset: listing.asset, author: buyer.address, body, at, signature }),
    )

    const holdersBefore = await answer<{ holders: Holder[] }>(
      await call(first, `/market/holders?asset=${listing.asset}`),
    )
    const activityBefore = await answer<{ trades: unknown[] }>(await call(first, '/market/activity?limit=50'))
    expect(holdersBefore.holders.some((holder) => holder.address === buyer.address && holder.amount === 5_000)).toBe(true)
    expect(activityBefore.trades.length).toBeGreaterThan(0)
    buyer.close()

    // A new class instance with the same storage is a DO eviction/cold start.
    const second = openFloor(storage)
    const after = await answer<MarketFacts>(await call(second, '/market/facts'))
    const afterListing = after.listings.find((entry) => entry.symbol === 'FRINGE')!
    expect(after.listings.map((entry) => entry.asset)).toEqual(initial.listings.map((entry) => entry.asset))
    expect(afterListing.asset).toBe(listing.asset)

    const afterBook = await answer<Book>(await call(second, `/market/book?asset=${listing.asset}`))
    const afterHolders = await answer<{ holders: Holder[] }>(
      await call(second, `/market/holders?asset=${listing.asset}`),
    )
    const afterReplies = await answer<{ replies: Reply[] }>(
      await call(second, `/market/replies?asset=${listing.asset}`),
    )
    const activityAfter = await answer<{ trades: unknown[] }>(await call(second, '/market/activity?limit=50'))

    expect(afterBook.asks).toHaveLength(0)
    expect(afterHolders.holders.some((holder) => holder.address === buyer.address && holder.amount === 5_000)).toBe(true)
    expect(afterReplies.replies.map((reply) => reply.body)).toContain(body)
    expect(activityAfter.trades.map((trade) => (trade as { hash: string }).hash)).toEqual(
      activityBefore.trades.map((trade) => (trade as { hash: string }).hash),
    )

    const events = [...storage.values.keys()].filter((key) => key.startsWith('event:v1:'))
    expect(events.length).toBeGreaterThanOrEqual(5)

    // Reinstantiating again replays; it does not append or duplicate the seed.
    const third = openFloor(storage)
    await answer<MarketFacts>(await call(third, '/market/facts'))
    expect([...storage.values.keys()].filter((key) => key.startsWith('event:v1:'))).toEqual(events)
  },
  60_000,
)

test(
  'a changed configurable seed is refused by its stored public identity without storing the seed',
  async () => {
    const storage = new FakeStorage()
    await answer<MarketFacts>(await call(openFloor(storage), '/market/facts'))

    for (const value of storage.values.values()) {
      expect(JSON.stringify(value)).not.toContain('A1'.repeat(32))
    }

    const changed = openFloor(storage, { CARPET_NETWORK: 'mock', CARPET_SEED: '3A'.repeat(32) })
    const response = await call(changed, '/market/facts')
    expect(response.status).toBe(500)
    expect(((await response.json()) as { error: string }).error).toMatch(/does not match.*reset.*Durable Object/i)
  },
  30_000,
)

test(
  'cold replay removes a pending rejected mutation left by a crash before cleanup',
  async () => {
    const storage = new FakeStorage()
    await answer<MarketFacts>(await call(openFloor(storage), '/market/facts'))

    const sequence = storage.values.get('meta:event-sequence:v1') as number
    const key = `event:v1:${sequence.toString().padStart(12, '0')}`
    await storage.put({
      [key]: {
        version: 1,
        sequence,
        status: 'pending',
        kind: 'rpc',
        at: Date.now(),
        body: JSON.stringify({ action: 'process', block: {} }),
      },
      'meta:event-sequence:v1': sequence + 1,
    })

    const facts = await answer<MarketFacts>(await call(openFloor(storage), '/market/facts'))
    expect(facts.listings).toHaveLength(6)
    expect(storage.values.has(key)).toBe(false)
  },
  30_000,
)

test('the actual Floor still refuses mainnet before writing durable demo state', async () => {
  const storage = new FakeStorage()
  const response = await call(openFloor(storage, { CARPET_NETWORK: 'mainnet' }), '/market/facts')
  expect(response.status).toBe(503)
  expect(((await response.json()) as { error: string }).error).toMatch(/refuses to run against mainnet/i)
  expect(storage.values.size).toBe(0)
})
