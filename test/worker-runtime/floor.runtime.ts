import { env } from 'cloudflare:workers'
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { keyPairFromSeed, signHash, type AccountInfo, type Block } from '@keicoin/core'
import { Kei } from 'kei-transaction'
import { expect, test } from 'vitest'

import type { Floor } from '../../worker/index.js'
import {
  CHECKPOINT_POINTERS,
  EVENT_PREFIX,
  NEXT_SEQUENCE,
  eventKey,
  loadLog,
  type StoredEvent,
} from '../../worker/durable-log.js'
import type { Book, Holder, MarketFacts } from '../../shared/listing.js'
import { cleanReply, replyHash, type Reply } from '../../shared/social.js'
import { answer, call, nodeFor } from './helpers.js'

const BUYER_SEED = '29'.repeat(32)

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

interface LedgerSnapshot {
  account: AccountInfo | null
  history: Block[]
  block: Block | null
}

async function ledgerSnapshot(
  stub: DurableObjectStub<Floor>,
  account: string,
  hash: string,
): Promise<LedgerSnapshot> {
  const [{ account: info }, { history }, { block }] = await Promise.all([
    answer<{ account: AccountInfo | null }>(
      await call(stub, '/rpc', { action: 'account_info', account }),
    ),
    answer<{ history: Block[] }>(
      await call(stub, '/rpc', { action: 'account_history', account, count: 100, shape: 'block' }),
    ),
    answer<{ block: Block | null }>(await call(stub, '/rpc', { action: 'block_info', hash })),
  ])
  return { account: info, history, block }
}

function callBody(stub: DurableObjectStub<Floor>, path: string, body: string): Promise<Response> {
  return stub.fetch(
    new Request(`https://example.test/examples/carpet-markets${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  )
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

test('the real runtime serializes overlapping checkpoints and replays an idempotent signed retry', async () => {
  const stub = env.FLOOR.get(env.FLOOR.idFromName('compaction-migration'))
  const initial = await answer<MarketFacts>(await call(stub, '/market/facts'))
  const asset = initial.listings.find((listing) => listing.symbol === 'FRINGE')?.asset
  expect(asset).toBeDefined()

  const processCalls: { body: string; hash: string }[] = []
  const recordingFloor = {
    async fetch(request: Request): Promise<Response> {
      const body = request.method === 'POST' ? await request.clone().text() : ''
      let action: unknown
      try {
        action = (JSON.parse(body) as { action?: unknown }).action
      } catch {
        action = undefined
      }
      const response = await stub.fetch(request)
      if (action === 'process' && response.ok) {
        const result = await response.clone().json<{ hash?: string }>()
        if (result.hash) processCalls.push({ body, hash: result.hash })
      }
      return response
    },
  }
  const buyer = await Kei.server({
    seed: '31'.repeat(32),
    node: nodeFor(recordingFloor),
    network: 'mock',
  })

  try {
    await buyer.faucet(50)
    await buyer.sync()
    expect(processCalls).toHaveLength(1)
    const original = processCalls[0]!

    const beforeRetryLedger = await ledgerSnapshot(stub, buyer.address, original.hash)
    const beforeRetryMarket = await snapshot(stub, asset!)
    expect(beforeRetryLedger.account?.balance).toBe('50000000000000000000')
    expect(beforeRetryLedger.history).toHaveLength(1)

    const beforeRetryAuthority = await runInDurableObject<Floor, StoredEvent[]>(
      stub,
      async (_instance, state) => (await loadLog(state.storage)).events,
    )
    expect(
      beforeRetryAuthority.filter((event) => event.kind === 'rpc' && event.body === original.body),
    ).toHaveLength(1)

    // A rejected process consumes its assigned sequence but leaves no WAL row.
    // The gap must remain harmless when later overlapping writes compact it.
    const rejectedSequence = await runInDurableObject<Floor, number>(stub, async (_instance, state) =>
      state.storage.get<number>(NEXT_SEQUENCE).then((value) => value ?? -1),
    )
    const rejected = await call(stub, '/rpc', { action: 'process', block: {} })
    expect(await rejected.json<{ error?: string }>()).toHaveProperty('error')
    await runInDurableObject<Floor, void>(stub, async (_instance, state) => {
      expect(await state.storage.get(eventKey(rejectedSequence))).toBeUndefined()
      expect(await state.storage.get<number>(NEXT_SEQUENCE)).toBe(rejectedSequence + 1)
    })
    const firstConcurrentSequence = rejectedSequence + 1

    // Seed + faucet + the original receive are three accepted events. These
    // fourteen requests really overlap in workerd and carry the authority
    // across both the 8-event and 16-event checkpoint boundaries.
    const watchAddresses = await Promise.all(
      Array.from({ length: 13 }, (_, index) =>
        keyPairFromSeed((0x40 + index).toString(16).repeat(32), 0).then((keys) => keys.address),
      ),
    )
    const concurrent = await Promise.all([
      callBody(stub, '/rpc', original.body),
      ...watchAddresses.map((address) => call(stub, '/market/watch', { address })),
    ])
    expect(concurrent).toHaveLength(14)
    for (const response of concurrent) expect(response.status).toBe(200)
    expect(await concurrent[0]!.json<{ hash: string }>()).toEqual({ hash: original.hash })
    for (const response of concurrent.slice(1)) {
      expect(await response.json<{ watching: boolean }>()).toEqual({ watching: true })
    }

    // The retry is acknowledged with the same hash but allocates no second WAL
    // row or sequence and applies no second ledger transition.
    expect(await ledgerSnapshot(stub, buyer.address, original.hash)).toEqual(beforeRetryLedger)
    expect(durableView(await snapshot(stub, asset!))).toEqual(durableView(beforeRetryMarket))

    const proof = await runInDurableObject<
      Floor,
      {
        pointers: CheckpointPointers
        authority: StoredEvent[]
        v1Tail: StoredEvent[]
        nextSequence: number
        tailEvents: number
      }
    >(stub, async (_instance, state) => {
      const pointers = await state.storage.get<CheckpointPointers>(CHECKPOINT_POINTERS)
      expect(pointers).toBeDefined()
      const loaded = await loadLog(state.storage)
      const v1 = await state.storage.list<StoredEvent>({ prefix: EVENT_PREFIX })
      return {
        pointers: pointers!,
        authority: loaded.events,
        v1Tail: [...v1.values()].sort((left, right) => left.sequence - right.sequence),
        nextSequence: (await state.storage.get<number>(NEXT_SEQUENCE)) ?? -1,
        tailEvents: loaded.tailEvents,
      }
    })

    expect(proof.pointers.active.generation).toBe(2)
    expect(proof.pointers.previous?.generation).toBe(1)
    expect(proof.pointers.previous!.throughSequence).toBeLessThan(
      proof.pointers.active.throughSequence,
    )
    expect(proof.tailEvents).toBe(0)
    expect(proof.authority).toHaveLength(16)
    const sequences = proof.authority.map((event) => event.sequence)
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right))
    expect(new Set(sequences).size).toBe(sequences.length)
    expect(sequences).not.toContain(rejectedSequence)
    expect(proof.authority.every((event) => event.status === 'accepted')).toBe(true)
    expect(proof.pointers.active.throughSequence).toBe(sequences.at(-1))
    expect(proof.nextSequence).toBe(firstConcurrentSequence + watchAddresses.length)
    expect(proof.v1Tail.map((event) => event.sequence)).toEqual(
      sequences.filter((sequence) => sequence > proof.pointers.previous!.throughSequence),
    )
    expect(proof.v1Tail.every((event) => event.status === 'accepted')).toBe(true)
    const retried = proof.authority.filter(
      (event) => event.kind === 'rpc' && event.body === original.body,
    )
    expect(retried).toEqual(
      beforeRetryAuthority.filter((event) => event.kind === 'rpc' && event.body === original.body),
    )
    expect(proof.authority.filter((event) => event.kind === 'watch')).toHaveLength(
      watchAddresses.length,
    )
    expect(
      proof.authority
        .filter((event) => event.kind === 'watch')
        .map((event) => event.sequence),
    ).toEqual(
      Array.from({ length: watchAddresses.length }, (_, index) => firstConcurrentSequence + index),
    )
    for (const address of watchAddresses) {
      expect(
        proof.authority.filter((event) => event.kind === 'watch' && event.address === address),
      ).toHaveLength(1)
    }

    // Even at the measured authority ceiling, the same signed process remains
    // idempotently successful and consumes neither a sequence nor another row.
    const beforeLimit = await eventLog(stub)
    const sequenceBeforeLimit = proof.nextSequence
    const retryAtLimit = await callBody(stub, '/rpc', original.body)
    expect(retryAtLimit.status).toBe(200)
    expect(await retryAtLimit.json<{ hash: string }>()).toEqual({ hash: original.hash })
    expect(await eventLog(stub)).toEqual(beforeLimit)
    await runInDurableObject<Floor, void>(stub, async (_instance, state) => {
      expect(await state.storage.get<number>(NEXT_SEQUENCE)).toBe(sequenceBeforeLimit)
      expect((await loadLog(state.storage)).events).toEqual(proof.authority)
    })

    // A genuinely new seventeenth authority event is refused before allocating
    // a sequence or WAL row. Compaction must not turn that hard limit into loss.
    const refused = await call(stub, '/market/watch', {
      address: 'kei_over_the_measured_replay_bound',
    })
    expect(refused.status).toBe(507)
    expect(await refused.json<{ error: string }>()).toMatchObject({
      error: expect.stringMatching(/No ledger mutation was accepted/i),
    })
    expect(await eventLog(stub)).toEqual(beforeLimit)
    await runInDurableObject<Floor, void>(stub, async (_instance, state) => {
      expect(await state.storage.get<number>(NEXT_SEQUENCE)).toBe(sequenceBeforeLimit)
    })

    await evictDurableObject(stub)
    expect(await ledgerSnapshot(stub, buyer.address, original.hash)).toEqual(beforeRetryLedger)
    expect(durableView(await snapshot(stub, asset!))).toEqual(durableView(beforeRetryMarket))
    const replayedAuthority = await runInDurableObject<Floor, StoredEvent[]>(
      stub,
      async (_instance, state) => (await loadLog(state.storage)).events,
    )
    expect(replayedAuthority).toEqual(proof.authority)

    // Corrupt only the active immutable generation. The predecessor plus its
    // surviving v1 tail is still complete and must recover on a second cold boot.
    await runInDurableObject<Floor, void>(stub, async (_instance, state) => {
      const prefix = `checkpoint:v2:${proof.pointers.active.generation
        .toString()
        .padStart(8, '0')}:chunk:`
      const chunks = await state.storage.list({ prefix })
      const first = [...chunks.keys()][0]
      expect(first).toBeDefined()
      await state.storage.delete(first!)
    })
    await evictDurableObject(stub)

    expect(await ledgerSnapshot(stub, buyer.address, original.hash)).toEqual(beforeRetryLedger)
    expect(durableView(await snapshot(stub, asset!))).toEqual(durableView(beforeRetryMarket))
  } finally {
    buyer.close()
  }
})
