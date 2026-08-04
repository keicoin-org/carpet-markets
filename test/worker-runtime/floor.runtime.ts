import { env } from 'cloudflare:workers'
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { keyPairFromSeed, signHash } from '@keicoin/core'
import { Kei } from 'kei-transaction'
import { expect, test } from 'vitest'

import type { Floor } from '../../worker/index.js'
import type { Book, Holder, MarketFacts } from '../../shared/listing.js'
import { cleanReply, replyHash, type Reply } from '../../shared/social.js'
import { answer, call, nodeFor } from './helpers.js'

const BUYER_SEED = '29'.repeat(32)
const EVENT_PREFIX = 'event:v1:'
const NEXT_SEQUENCE = 'meta:event-sequence:v1'
const CHECKPOINT_POINTERS = 'meta:checkpoint:v2'

interface StoredEvent {
  kind: string
  sequence: number
  status: 'pending' | 'accepted'
}

interface CheckpointPointers {
  active: { generation: number; throughSequence: number }
  previous?: { generation: number; throughSequence: number }
}

interface DurableSnapshot {
  address: string
  listings: MarketFacts['listings']
  book: Book
  holders: Holder[]
  replies: Reply[]
  activity: unknown[]
}

function durableView(snapshot: DurableSnapshot) {
  return {
    address: snapshot.address,
    listings: snapshot.listings.map(({ stats: _derivedCache, ...identity }) => identity),
    book: {
      asset: snapshot.book.asset,
      asks: snapshot.book.asks.map((offer) => offer.hash),
      bids: snapshot.book.bids.map((offer) => offer.hash),
      trades: snapshot.book.trades.map((trade) => trade.hash),
      price: snapshot.book.price,
    },
    holders: snapshot.holders,
    replies: snapshot.replies,
    activity: snapshot.activity.map((trade) => (trade as { hash: string }).hash),
  }
}

async function eventLog(stub: DurableObjectStub<Floor>): Promise<Map<string, StoredEvent>> {
  return runInDurableObject<Floor, Map<string, StoredEvent>>(stub, async (_instance, state) =>
    state.storage.list<StoredEvent>({ prefix: EVENT_PREFIX }),
  )
}

async function snapshot(stub: DurableObjectStub<Floor>, asset: string): Promise<DurableSnapshot> {
  const facts = await answer<MarketFacts>(await call(stub, '/market/facts'))
  const book = await answer<Book>(await call(stub, `/market/book?asset=${asset}`))
  const { holders } = await answer<{ holders: Holder[] }>(
    await call(stub, `/market/holders?asset=${asset}`),
  )
  const { replies } = await answer<{ replies: Reply[] }>(
    await call(stub, `/market/replies?asset=${asset}`),
  )
  const { trades: activity } = await answer<{ trades: unknown[] }>(
    await call(stub, '/market/activity?limit=50'),
  )
  return { address: facts.address, listings: facts.listings, book, holders, replies, activity }
}

test('the configured FLOOR persists the seeded market, first trade, discovery, and reply across real eviction', async () => {
  const stub = env.FLOOR.get(env.FLOOR.idFromName('carpet-markets'))

  // These are the first two calls into an empty, cold object. The runtime owns
  // the constructor gate and storage transaction semantics exercised here.
  const [initial, simultaneous] = await Promise.all([
    call(stub, '/market/facts').then(answer<MarketFacts>),
    call(stub, '/market/facts').then(answer<MarketFacts>),
  ])

  expect(initial.chain).toMatchObject({ mode: 'mock', sdkNetwork: 'mock', ephemeral: false })
  expect(initial.listings).toHaveLength(6)
  expect(simultaneous.address).toBe(initial.address)
  expect(simultaneous.listings.map((listing) => listing.asset)).toEqual(
    initial.listings.map((listing) => listing.asset),
  )

  const seededLog = await eventLog(stub)
  const seedEvents = [...seededLog.values()].filter((event) => event.kind === 'seed')
  expect(seedEvents).toEqual([expect.objectContaining({ status: 'accepted' })])

  // A rejected write must leave no pending WAL record in the real storage
  // transaction implementation, and the object must remain bootable.
  const beforeRejected = [...seededLog.keys()]
  const rejected = await call(stub, '/rpc', { action: 'process', block: {} })
  expect(await rejected.json<{ error?: string }>()).toHaveProperty('error')
  const afterRejected = await eventLog(stub)
  expect([...afterRejected.keys()]).toEqual(beforeRejected)
  expect([...afterRejected.values()].some((event) => event.status === 'pending')).toBe(false)

  const listing = initial.listings.find((entry) => entry.symbol === 'FRINGE')
  expect(listing).toBeDefined()
  const asset = listing!.asset
  const beforeBuy = await answer<Book>(await call(stub, `/market/book?asset=${asset}`))
  expect(beforeBuy.asks).toHaveLength(1)

  const buyer = await Kei.server({ seed: BUYER_SEED, node: nodeFor(stub), network: 'mock' })
  try {
    await buyer.faucet(50)
    await buyer.sync()
    await answer(await call(stub, '/market/watch', { address: buyer.address }))
    await buyer.market.accept(beforeBuy.asks[0]!.hash)
    await buyer.sync()

    const body = cleanReply('first buy survived a real Durable Object eviction')
    const at = Date.now()
    const keys = await keyPairFromSeed(BUYER_SEED, 0)
    const signature = await signHash(keys.privateKey, replyHash({ asset, body, at }))
    await answer(
      await call(stub, '/market/reply', { asset, author: buyer.address, body, at, signature }),
    )

    // Fill the measured replay boundary with ordinary signed blocks rather
    // than cheap metadata alone: four sends and their four receives bring the
    // accepted history to 15 events (seed + first-buy flow + eight payments).
    const sink = await Kei.server({ seed: '30'.repeat(32), node: nodeFor(stub), network: 'mock' })
    try {
      for (let index = 0; index < 4; index += 1) {
        await buyer.pay({ to: sink.address, amount: 0.001 })
        await sink.sync()
      }
    } finally {
      sink.close()
    }

    const beforeEviction = await snapshot(stub, asset)
    expect(beforeEviction.book.asks).toHaveLength(0)
    expect(beforeEviction.holders).toContainEqual(
      expect.objectContaining({ address: buyer.address, amount: 5_000 }),
    )
    expect(beforeEviction.replies.map((reply) => reply.body)).toContain(body)
    expect(beforeEviction.activity.length).toBeGreaterThan(0)

    await evictDurableObject(stub)

    const afterEviction = await snapshot(stub, asset)
    // seenAt/settledAt and listing summaries are observation-time caches, not
    // durable claims. Compare the immutable listing identities plus every
    // persisted book/trade hash, holder, discovery result, and signed reply.
    expect(durableView(afterEviction)).toEqual(durableView(beforeEviction))
    expect(afterEviction.address).toBe(initial.address)
    expect(afterEviction.activity.map((trade) => (trade as { hash: string }).hash)).toEqual(
      beforeEviction.activity.map((trade) => (trade as { hash: string }).hash),
    )

    // Simulate a crash after the write-ahead transaction and before rejection
    // cleanup. A genuine second eviction must replay, reject, delete, and then
    // expose the exact same accepted state.
    const pendingKey = await runInDurableObject<Floor, string>(stub, async (_instance, state) =>
      state.storage.transaction(async (storage) => {
        const sequence = (await storage.get<number>(NEXT_SEQUENCE)) ?? 0
        const key = `${EVENT_PREFIX}${sequence.toString().padStart(12, '0')}`
        await storage.put({
          [key]: {
            version: 1,
            sequence,
            status: 'pending',
            kind: 'rpc',
            at: Date.now(),
            body: JSON.stringify({ action: 'process', block: {} }),
          },
          [NEXT_SEQUENCE]: sequence + 1,
        })
        return key
      }),
    )
    expect((await eventLog(stub)).get(pendingKey)?.status).toBe('pending')

    await evictDurableObject(stub)

    expect(durableView(await snapshot(stub, asset))).toEqual(durableView(beforeEviction))
    expect((await eventLog(stub)).has(pendingKey)).toBe(false)
  } finally {
    buyer.close()
  }
})

test('the real runtime migrates v1, compacts atomically, evicts, and recovers from a damaged active generation', async () => {
  const stub = env.FLOOR.get(env.FLOOR.idFromName('compaction-migration'))
  const initial = await answer<MarketFacts>(await call(stub, '/market/facts'))

  // The seed plus 15 accepted writes crosses the 8-event threshold twice.
  // Unique watches preserve observable registry discovery while duplicate-watch
  // folding is covered independently by the deterministic unit tests.
  for (let index = 0; index < 15; index += 1) {
    await answer(await call(stub, '/market/watch', { address: `kei_runtime_compaction_${index}` }))
  }

  const before = await answer<MarketFacts>(await call(stub, '/market/facts'))
  const pointers = await runInDurableObject<Floor, CheckpointPointers>(stub, async (_instance, state) => {
    const value = await state.storage.get<CheckpointPointers>(CHECKPOINT_POINTERS)
    expect(value?.active.generation).toBe(2)
    expect(value?.previous?.generation).toBe(1)
    const v1 = await state.storage.list<StoredEvent>({ prefix: EVENT_PREFIX })
    expect([...v1.values()].every((event) => event.sequence > value!.previous!.throughSequence)).toBe(true)
    return value!
  })

  const beforeLimit = await eventLog(stub)
  const sequenceBeforeLimit = await runInDurableObject<Floor, number>(stub, async (_instance, state) =>
    state.storage.get<number>(NEXT_SEQUENCE).then((value) => value ?? -1),
  )
  const refused = await call(stub, '/market/watch', { address: 'kei_over_the_measured_replay_bound' })
  expect(refused.status).toBe(507)
  expect(await refused.json<{ error: string }>()).toMatchObject({
    error: expect.stringMatching(/No ledger mutation was accepted/i),
  })
  expect(await eventLog(stub)).toEqual(beforeLimit)
  await runInDurableObject<Floor, void>(stub, async (_instance, state) => {
    expect(await state.storage.get<number>(NEXT_SEQUENCE)).toBe(sequenceBeforeLimit)
  })

  await evictDurableObject(stub)
  const afterEviction = await answer<MarketFacts>(await call(stub, '/market/facts'))
  expect(afterEviction.address).toBe(initial.address)
  expect(afterEviction.listings.map((listing) => listing.asset)).toEqual(
    before.listings.map((listing) => listing.asset),
  )

  // Corrupt only the active immutable generation. The predecessor plus its v1
  // tail is still complete and must be selected on the next genuine cold boot.
  await runInDurableObject<Floor, void>(stub, async (_instance, state) => {
    const prefix = `checkpoint:v2:${pointers.active.generation.toString().padStart(8, '0')}:chunk:`
    const chunks = await state.storage.list({ prefix })
    const first = [...chunks.keys()][0]
    expect(first).toBeDefined()
    await state.storage.delete(first!)
  })
  await evictDurableObject(stub)

  const recovered = await answer<MarketFacts>(await call(stub, '/market/facts'))
  expect(recovered.address).toBe(initial.address)
  expect(recovered.listings.map((listing) => listing.asset)).toEqual(
    before.listings.map((listing) => listing.asset),
  )
})
