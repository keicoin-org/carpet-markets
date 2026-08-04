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
  failPointer = false

  async get<T>(key: string): Promise<T | undefined>
  async get<T>(keys: string[]): Promise<Map<string, T>>
  async get<T>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (typeof keyOrKeys === 'string') return this.values.get(keyOrKeys) as T | undefined
    const found = new Map<string, T>()
    for (const key of keyOrKeys) {
      if (this.values.has(key)) found.set(key, structuredClone(this.values.get(key)) as T)
    }
    return found
  }

  async put(key: string, value: unknown): Promise<void>
  async put(entries: Record<string, unknown>): Promise<void>
  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof keyOrEntries === 'string' ? { [keyOrEntries]: value } : keyOrEntries
    if (this.failPointer && 'meta:checkpoint:v2' in entries) throw new Error('simulated pointer failure')
    for (const [key, entry] of Object.entries(entries)) this.values.set(key, structuredClone(entry))
  }

  async delete(key: string): Promise<boolean>
  async delete(keys: string[]): Promise<number>
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    if (typeof keyOrKeys === 'string') return this.values.delete(keyOrKeys)
    let deleted = 0
    for (const key of keyOrKeys) if (this.values.delete(key)) deleted += 1
    return deleted
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

function nodeFor(floor: FloorLike, posted?: string[]): HttpNode {
  return new HttpNode({
    url: 'https://example.test/examples/carpet-markets/rpc',
    network: 'mock',
    pollInterval: 60_000,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input as Request, init)
      if (posted) {
        const text = await request.clone().text()
        if (text.includes('"process"')) posted.push(text)
      }
      return floor.fetch(request)
    }) as typeof fetch,
  })
}

function postBody(floor: FloorLike, body: string): Promise<Response> {
  return floor.fetch(
    new Request('https://example.test/examples/carpet-markets/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  )
}

function eventRows(storage: FakeStorage): string[] {
  return [...storage.values.keys()].filter((key) => key.startsWith('event:v1:'))
}

test(
  'the fast Floor harness replays its seeded ledger, first buy, holder, and signed reply',
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

    // A new class instance with the same fake storage exercises replay quickly;
    // test/worker-runtime/floor.runtime.ts is the actual runtime eviction proof.
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

test(
  'compat audits oversized legacy state without deleting it, while compact refuses unsafe activation',
  async () => {
    const base = new FakeStorage()
    await answer<MarketFacts>(await call(openFloor(base), '/market/facts'))

    const compat = new FakeStorage()
    for (const [key, value] of base.values) compat.values.set(key, structuredClone(value))
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      compat.values.set(`event:v1:${sequence.toString().padStart(12, '0')}`, {
        version: 1,
        sequence,
        status: 'accepted',
        kind: 'watch',
        at: sequence,
        address: 'kei_same_legacy_watcher',
      })
    }
    const pendingKey = 'event:v1:000000000021'
    compat.values.set(pendingKey, {
      version: 1,
      sequence: 21,
      status: 'pending',
      kind: 'rpc',
      at: 21,
      body: JSON.stringify({ action: 'process', block: {} }),
    })
    compat.values.set('meta:event-sequence:v1', 22)
    const acceptedBefore = [...compat.values.keys()].filter((key) => key.startsWith('event:v1:') && key !== pendingKey)

    const compatible = openFloor(compat, { CARPET_NETWORK: 'mock', CARPET_LOG_MODE: 'compat' })
    expect((await answer<MarketFacts>(await call(compatible, '/market/facts'))).listings).toHaveLength(6)
    expect(compat.values.has(pendingKey)).toBe(false)
    expect(acceptedBefore.every((key) => compat.values.has(key))).toBe(true)
    await answer(await call(compatible, '/market/watch', { address: 'kei_compat_still_accepts_writes' }))
    expect(compat.values.get('meta:event-sequence:v1')).toBe(23)
    expect([...compat.values.keys()].some((key) => key.startsWith('checkpoint:v2:'))).toBe(false)

    const oversized = new FakeStorage()
    for (const [key, value] of base.values) oversized.values.set(key, structuredClone(value))
    for (let sequence = 1; sequence <= 16; sequence += 1) {
      oversized.values.set(`event:v1:${sequence.toString().padStart(12, '0')}`, {
        version: 1,
        sequence,
        status: 'accepted',
        kind: 'watch',
        at: sequence,
        address: `kei_distinct_legacy_watcher_${sequence}`,
      })
    }
    oversized.values.set('meta:event-sequence:v1', 17)
    const compactKeys = [...oversized.values.keys()]
    const compacting = openFloor(oversized, { CARPET_NETWORK: 'mock', CARPET_LOG_MODE: 'compact' })
    expect((await answer<MarketFacts>(await call(compacting, '/market/facts'))).listings).toHaveLength(6)
    const refused = await call(compacting, '/market/watch', { address: 'kei_no_growth_over_bound' })
    expect(refused.status).toBe(507)
    expect([...oversized.values.keys()]).toEqual(compactKeys)
  },
  60_000,
)

test(
  'a persistent compaction failure fails closed before duplicate set-like traffic can grow the WAL',
  async () => {
    const storage = new FakeStorage()
    const floor = openFloor(storage, { CARPET_NETWORK: 'mock', CARPET_LOG_MODE: 'compact' })
    await answer<MarketFacts>(await call(floor, '/market/facts'))
    storage.failPointer = true

    const watcher = (await keyPairFromSeed('40'.repeat(32), 0)).address
    for (let index = 0; index < 7; index += 1) {
      expect(
        await answer<{ watching: boolean }>(
          await call(floor, '/market/watch', { address: watcher }),
        ),
      ).toEqual({ watching: true })
    }

    const raw = [...storage.values.keys()].filter((key) => key.startsWith('event:v1:'))
    expect(raw).toHaveLength(8)
    const keysAtFailure = [...storage.values.keys()]
    const sequenceAtFailure = storage.values.get('meta:event-sequence:v1')

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const refused = await call(floor, '/market/watch', { address: watcher })
      expect(refused.status).toBe(507)
      expect((await refused.json()) as { error: string }).toMatchObject({
        error: expect.stringMatching(/could not compact/i),
      })
    }
    expect([...storage.values.keys()]).toEqual(keysAtFailure)
    expect(storage.values.get('meta:event-sequence:v1')).toBe(sequenceAtFailure)
    expect([...storage.values.keys()].filter((key) => key.startsWith('event:v1:'))).toEqual(raw)

    // Eviction/restart retries compaction but never reopens mutation admission
    // while the same persistent storage failure remains.
    const reopened = openFloor(storage, { CARPET_NETWORK: 'mock', CARPET_LOG_MODE: 'compact' })
    await answer<MarketFacts>(await call(reopened, '/market/facts'))
    const keysAfterReopen = [...storage.values.keys()]
    const refusedAfterReopen = await call(reopened, '/market/watch', { address: watcher })
    expect(refusedAfterReopen.status).toBe(507)
    expect((await refusedAfterReopen.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/could not compact/i),
    })
    expect([...storage.values.keys()]).toEqual(keysAfterReopen)
    expect(storage.values.get('meta:event-sequence:v1')).toBe(sequenceAtFailure)
    expect([...storage.values.keys()].filter((key) => key.startsWith('event:v1:'))).toEqual(raw)
  },
  60_000,
)

test(
  'a re-encoded copy of an accepted signed block is one operation and buys no authority',
  async () => {
    const storage = new FakeStorage()
    const floor = openFloor(storage, { CARPET_NETWORK: 'mock', CARPET_LOG_MODE: 'compact' })
    await answer<MarketFacts>(await call(floor, '/market/facts'))

    const posted: string[] = []
    const buyer = await Kei.server({ seed: BUYER_SEED, node: nodeFor(floor, posted), network: 'mock' })
    try {
      await buyer.faucet(50)
      await buyer.sync()
    } finally {
      buyer.close()
    }
    const exact = posted.at(-1)!
    const accepted = JSON.parse(exact) as { action: string; block: Record<string, unknown> }

    const rowsBefore = eventRows(storage)
    const sequenceBefore = storage.values.get('meta:event-sequence:v1')
    const hash = await answer<{ hash: string }>(await postBody(floor, exact))

    // `MockLedger.process` hashes the block body and returns a held block's hash
    // before it validates anything, signature included (@keicoin/core 0.3.0,
    // mock/ledger.ts). So none of these is a second ledger operation; only the
    // request bytes differ. Re-encoding is ordinary client and proxy behaviour,
    // and the tampered signature is the adversarial spelling of the same thing.
    const copies = [
      JSON.stringify(accepted, null, 2),
      JSON.stringify({ block: accepted.block, action: accepted.action }),
      JSON.stringify({ ...accepted, block: { ...accepted.block, signature: '0'.repeat(128) } }),
      ...Array.from({ length: 16 }, (_, index) =>
        JSON.stringify(accepted).replace('{"action"', `{${' '.repeat(index + 1)}"action"`),
      ),
    ]
    expect(new Set(copies).size).toBe(copies.length)
    for (const copy of copies) expect(copy).not.toBe(exact)

    for (const copy of copies) {
      const response = await postBody(floor, copy)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(hash)
    }

    // Nineteen re-encodings is more than the sixteen-event replay bound. If any
    // of them had bought a canonical slot the log would be full, the tail would
    // have compacted, and the honest write below would be refused instead.
    expect(eventRows(storage)).toEqual(rowsBefore)
    expect(storage.values.get('meta:event-sequence:v1')).toBe(sequenceBefore)
    expect(
      await answer<{ watching: boolean }>(
        await call(floor, '/market/watch', { address: 'kei_capacity_was_never_spent' }),
      ),
    ).toEqual({ watching: true })
  },
  120_000,
)

test('an unknown durable-log mode refuses traffic before writing mock authority', async () => {
  const storage = new FakeStorage()
  const floor = openFloor(storage, { CARPET_NETWORK: 'mock', CARPET_LOG_MODE: 'compcat' })
  const response = await call(floor, '/market/facts')
  expect(response.status).toBe(500)
  expect((await response.json()) as { error: string }).toMatchObject({
    error: expect.stringMatching(/CARPET_LOG_MODE must be "compat" or "compact"/),
  })
  expect(storage.values.size).toBe(0)
})

test('the actual Floor still refuses mainnet before writing durable demo state', async () => {
  const storage = new FakeStorage()
  const response = await call(openFloor(storage, { CARPET_NETWORK: 'mainnet' }), '/market/facts')
  expect(response.status).toBe(503)
  expect(((await response.json()) as { error: string }).error).toMatch(/refuses to run against mainnet/i)
  expect(storage.values.size).toBe(0)
})
