import { expect, mock, test } from 'bun:test'
import {
  HttpNode,
  ZERO_HASH,
  generateWork,
  hashBlock,
  keyPairFromSeed,
  signHash,
  tierFor,
  workRoot,
  type Block,
  type BlockBody,
} from '@keicoin/core'
import { Kei } from 'kei-transaction'

import { cleanReply, replyHash } from '../shared/social.js'
import { LOG_LIMITS, eventKey, rawLimitError } from '../worker/durable-log.js'
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
  failAcceptedPut = false
  silentAcceptedPut = false
  failPendingDelete = false
  /**
   * Fail exactly the step that can only fail after a checkpoint pointer is
   * already authoritative: deleting the v1 rows the retained predecessor
   * covers. Single-key deletes (a rejected mutation's own WAL row) still work,
   * so this isolates post-activation cleanup from ordinary write handling.
   */
  failCoveredCleanup = false

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
    if (
      this.failAcceptedPut &&
      Object.entries(entries).some(
        ([key, entry]) =>
          key.startsWith('event:v1:') &&
          typeof entry === 'object' &&
          entry !== null &&
          (entry as { status?: unknown }).status === 'accepted',
      )
    ) {
      this.failAcceptedPut = false
      throw new Error('simulated accepted-status write failure')
    }
    if (
      this.silentAcceptedPut &&
      Object.entries(entries).some(
        ([key, entry]) =>
          key.startsWith('event:v1:') &&
          typeof entry === 'object' &&
          entry !== null &&
          (entry as { status?: unknown }).status === 'accepted',
      )
    ) {
      this.silentAcceptedPut = false
      return
    }
    for (const [key, entry] of Object.entries(entries)) this.values.set(key, structuredClone(entry))
  }

  async delete(key: string): Promise<boolean>
  async delete(keys: string[]): Promise<number>
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    if (typeof keyOrKeys === 'string') {
      if (this.failPendingDelete && keyOrKeys.startsWith('event:v1:')) {
        throw new Error('simulated rejected-pending cleanup failure')
      }
      return this.values.delete(keyOrKeys)
    }
    if (this.failCoveredCleanup && keyOrKeys.some((key) => key.startsWith('event:v1:'))) {
      throw new Error('simulated post-activation cleanup failure')
    }
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

async function signedBlock(node: HttpNode, body: BlockBody, privateKey: string): Promise<Block> {
  const thresholds = await node.workThresholds()
  return {
    ...body,
    work: generateWork(workRoot(body), BigInt(thresholds[tierFor(body)])),
    signature: await signHash(privateKey, hashBlock(body)),
  }
}

async function ledgerView(node: HttpNode, address: string) {
  return {
    account: await node.accountInfo(address),
    receivables: await node.receivables(address),
    history: await node.accountHistory(address, { limit: 100 }),
  }
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

/**
 * A row a deployed compat object really would have accepted: `watch` ignores
 * anything that is not an address, and the input is still stored. Repeating one
 * of them is set-like, so canonicalisation folds the whole pile to one event
 * while the raw bytes stay on disk.
 */
const LEGACY_FILLER = `not-an-address-${'x'.repeat(1600)}`

function storeOversizedLegacy(storage: FakeStorage, rows: number): void {
  for (let sequence = 1; sequence <= rows; sequence += 1) {
    storage.values.set(`event:v1:${sequence.toString().padStart(12, '0')}`, {
      version: 1,
      sequence,
      status: 'accepted',
      kind: 'watch',
      at: sequence,
      address: LEGACY_FILLER,
    })
  }
  storage.values.set('meta:event-sequence:v1', rows + 1)
}

/** What the object actually persists, which is not what replay folds it into. */
function rawStorage(storage: FakeStorage): { events: number; bytes: number } {
  const rows = [...storage.values.entries()].filter(([key]) => key.startsWith('event:v1:'))
  return {
    events: rows.length,
    bytes: rows.reduce(
      (total, [, value]) => total + new TextEncoder().encode(JSON.stringify(value)).byteLength,
      0,
    ),
  }
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
  120_000,
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
  'signed late-validation refusals preserve live receivables and the next accepted mutation across restart',
  async () => {
    const storage = new FakeStorage()
    const floor = openFloor(storage)
    await answer<MarketFacts>(await call(floor, '/market/facts'))
    const node = nodeFor(floor)

    const invalidBalanceRecipient = await keyPairFromSeed('46'.repeat(32), 0)
    const invalidBalanceSend = await node.faucet(invalidBalanceRecipient.address, '100')
    const beforeInvalidBalance = await ledgerView(node, invalidBalanceRecipient.address)
    expect(beforeInvalidBalance).toMatchObject({
      account: null,
      receivables: [{ hash: invalidBalanceSend.hash, amount: '100' }],
      history: [],
    })
    const balanceSequence = storage.values.get('meta:event-sequence:v1') as number
    const rowsBeforeInvalidBalance = eventRows(storage)
    const invalidOpen = await signedBlock(
      node,
      {
        type: 'state',
        subtype: 'open',
        account: invalidBalanceRecipient.address,
        previous: ZERO_HASH,
        representative: invalidBalanceRecipient.address,
        balance: '101',
        link: invalidBalanceSend.hash,
      },
      invalidBalanceRecipient.privateKey,
    )

    storage.failPendingDelete = true
    const invalidBalanceRequest = call(floor, '/rpc', { action: 'process', block: invalidOpen })
    // Start a same-instance read while the rejected process owns the mutation
    // queue. It must resolve against the accepted-history replacement, never
    // the authority whose late refusal already consumed this receivable.
    const concurrentView = ledgerView(node, invalidBalanceRecipient.address)
    const invalidBalanceResponse = await invalidBalanceRequest
    expect(invalidBalanceResponse.status).toBe(503)
    expect((await invalidBalanceResponse.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/pending WAL row was preserved.*cold restart/i),
    })
    expect(await concurrentView).toEqual(beforeInvalidBalance)
    expect(await ledgerView(node, invalidBalanceRecipient.address)).toEqual(beforeInvalidBalance)
    expect(eventRows(storage)).toEqual([...rowsBeforeInvalidBalance, eventKey(balanceSequence)])
    expect(storage.values.get(eventKey(balanceSequence))).toMatchObject({ status: 'pending' })
    expect(storage.values.get('meta:event-sequence:v1')).toBe(balanceSequence + 1)

    // The disposable serving authority was rebuilt, but failed WAL cleanup still
    // latches this live object closed. A fresh boot re-evaluates the pending row
    // in isolation and deletes it only after another clean rebuild succeeds.
    const blockedKeys = [...storage.values.keys()]
    const blockedRetry = await call(floor, '/rpc', { action: 'process', block: invalidOpen })
    expect(blockedRetry.status).toBe(503)
    expect([...storage.values.keys()]).toEqual(blockedKeys)
    storage.failPendingDelete = false
    const recoveredFloor = openFloor(storage)
    const recoveredNode = nodeFor(recoveredFloor)
    expect(await ledgerView(recoveredNode, invalidBalanceRecipient.address)).toEqual(beforeInvalidBalance)
    expect(eventRows(storage)).toEqual(rowsBeforeInvalidBalance)
    expect(storage.values.has(eventKey(balanceSequence))).toBe(false)

    const validOpen = await signedBlock(
      recoveredNode,
      {
        type: 'state',
        subtype: 'open',
        account: invalidBalanceRecipient.address,
        previous: ZERO_HASH,
        representative: invalidBalanceRecipient.address,
        balance: '100',
        link: invalidBalanceSend.hash,
      },
      invalidBalanceRecipient.privateKey,
    )
    const validOpenResult = await answer<{ hash: string }>(
      await call(recoveredFloor, '/rpc', { action: 'process', block: validOpen }),
    )
    expect(validOpenResult).toEqual({ hash: hashBlock(validOpen) })
    expect(storage.values.get(eventKey(balanceSequence + 1))).toMatchObject({
      kind: 'rpc',
      status: 'accepted',
    })
    expect(storage.values.get('meta:event-sequence:v1')).toBe(balanceSequence + 2)
    expect(await ledgerView(recoveredNode, invalidBalanceRecipient.address)).toMatchObject({
      account: { balance: '100', receivableCount: 0 },
      receivables: [],
    })
    const rowsAfterValidOpen = eventRows(storage)
    const sequenceAfterValidOpen = storage.values.get('meta:event-sequence:v1')
    expect(
      await answer<{ hash: string }>(
        await call(recoveredFloor, '/rpc', { action: 'process', block: validOpen }),
      ),
    ).toEqual(validOpenResult)
    expect(eventRows(storage)).toEqual(rowsAfterValidOpen)
    expect(storage.values.get('meta:event-sequence:v1')).toBe(sequenceAfterValidOpen)

    const wrongTypeRecipient = await keyPairFromSeed('47'.repeat(32), 0)
    const wrongTypeSend = await recoveredNode.faucet(wrongTypeRecipient.address, '77')
    const beforeWrongType = await ledgerView(recoveredNode, wrongTypeRecipient.address)
    const wrongTypeSequence = storage.values.get('meta:event-sequence:v1') as number
    const rowsBeforeWrongType = eventRows(storage)
    const wrongTypeReceive = await signedBlock(
      recoveredNode,
      {
        type: 'asset',
        account: wrongTypeRecipient.address,
        previous: ZERO_HASH,
        representative: wrongTypeRecipient.address,
        balance: '0',
        op: { kind: 'asset_receive', link: wrongTypeSend.hash },
      },
      wrongTypeRecipient.privateKey,
    )

    const wrongTypeResponse = await call(recoveredFloor, '/rpc', {
      action: 'process',
      block: wrongTypeReceive,
    })
    expect((await wrongTypeResponse.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/Incoming Kei is collected by a receive block/i),
    })
    expect(await ledgerView(recoveredNode, wrongTypeRecipient.address)).toEqual(beforeWrongType)
    expect(eventRows(storage)).toEqual(rowsBeforeWrongType)
    expect(storage.values.has(eventKey(wrongTypeSequence))).toBe(false)
    expect(storage.values.get('meta:event-sequence:v1')).toBe(wrongTypeSequence + 1)

    const correctSecondOpen = await signedBlock(
      recoveredNode,
      {
        type: 'state',
        subtype: 'open',
        account: wrongTypeRecipient.address,
        previous: ZERO_HASH,
        representative: wrongTypeRecipient.address,
        balance: '77',
        link: wrongTypeSend.hash,
      },
      wrongTypeRecipient.privateKey,
    )
    await answer<{ hash: string }>(
      await call(recoveredFloor, '/rpc', { action: 'process', block: correctSecondOpen }),
    )
    expect(storage.values.get(eventKey(wrongTypeSequence + 1))).toMatchObject({
      kind: 'rpc',
      status: 'accepted',
    })
    expect(storage.values.get('meta:event-sequence:v1')).toBe(wrongTypeSequence + 2)

    const live = {
      invalidBalance: await ledgerView(recoveredNode, invalidBalanceRecipient.address),
      wrongType: await ledgerView(recoveredNode, wrongTypeRecipient.address),
      rows: eventRows(storage),
      sequence: storage.values.get('meta:event-sequence:v1'),
    }
    const reopened = openFloor(storage)
    const replayedNode = nodeFor(reopened)
    const replayed = {
      invalidBalance: await ledgerView(replayedNode, invalidBalanceRecipient.address),
      wrongType: await ledgerView(replayedNode, wrongTypeRecipient.address),
      rows: eventRows(storage),
      sequence: storage.values.get('meta:event-sequence:v1'),
    }
    expect(replayed).toEqual(live)
  },
  180_000,
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
  60_000,
)

test(
  'an accepted-status write failure preserves pending authority and fails closed until cold replay',
  async () => {
    const storage = new FakeStorage()
    const floor = openFloor(storage)
    const facts = await answer<MarketFacts>(await call(floor, '/market/facts'))
    const asset = facts.listings[0]!.asset
    const keys = await keyPairFromSeed('3F'.repeat(32), 0)
    const body = cleanReply('acceptance failure survived exactly once')
    const at = Date.now()
    const reply = {
      asset,
      author: keys.address,
      body,
      at,
      signature: await signHash(keys.privateKey, replyHash({ asset, body, at })),
    }
    const sequence = storage.values.get('meta:event-sequence:v1') as number
    const pendingKey = `event:v1:${sequence.toString().padStart(12, '0')}`

    storage.silentAcceptedPut = true
    const failed = await call(floor, '/market/reply', reply)
    expect(failed.status).toBe(503)
    expect((await failed.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/pending row was preserved.*cold restart/i),
    })
    expect(storage.values.get(pendingKey)).toMatchObject({ kind: 'reply', status: 'pending' })
    expect(storage.values.get('meta:event-sequence:v1')).toBe(sequence + 1)

    // The application was observable before its acceptance write failed. A
    // retry on this same live instance must neither apply it again nor allocate
    // another WAL row while durable authority is unresolved.
    expect(
      (await answer<{ replies: Reply[] }>(await call(floor, `/market/replies?asset=${asset}`))).replies.map(
        (entry) => entry.body,
      ).filter((entry) => entry === body),
    ).toEqual([body])
    const keysAtFailure = [...storage.values.keys()]
    const refusedRetry = await call(floor, '/market/reply', reply)
    expect(refusedRetry.status).toBe(503)
    expect((await refusedRetry.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/pending row was preserved.*cold restart/i),
    })
    expect([...storage.values.keys()]).toEqual(keysAtFailure)
    expect(storage.values.get('meta:event-sequence:v1')).toBe(sequence + 1)

    // A fresh instance rebuilds disposable state, applies the one pending row,
    // marks it accepted, and remains stable across another eviction.
    const reopened = openFloor(storage)
    const recovered = await answer<{ replies: Reply[] }>(await call(reopened, `/market/replies?asset=${asset}`))
    expect(recovered.replies.map((entry) => entry.body).filter((entry) => entry === body)).toEqual([body])
    expect(storage.values.get(pendingKey)).toMatchObject({ kind: 'reply', status: 'accepted' })
    const rowsAfterRecovery = eventRows(storage)

    const evictedAgain = openFloor(storage)
    const replayed = await answer<{ replies: Reply[] }>(
      await call(evictedAgain, `/market/replies?asset=${asset}`),
    )
    expect(replayed.replies.map((entry) => entry.body).filter((entry) => entry === body)).toEqual([body])
    expect(eventRows(storage)).toEqual(rowsAfterRecovery)
  },
  60_000,
)

test(
  'compat audits oversized legacy state without deleting it, while compact refuses unsafe activation',
  async () => {
    const base = new FakeStorage()
    await answer<MarketFacts>(await call(openFloor(base), '/market/facts'))

    const compat = new FakeStorage()
    for (const [key, value] of base.values) compat.values.set(key, structuredClone(value))
    storeOversizedLegacy(compat, 24)
    const pendingKey = 'event:v1:000000000025'
    compat.values.set(pendingKey, {
      version: 1,
      sequence: 25,
      status: 'pending',
      kind: 'rpc',
      at: 25,
      body: JSON.stringify({ action: 'process', block: {} }),
    })
    compat.values.set('meta:event-sequence:v1', 26)
    const acceptedBefore = [...compat.values.keys()].filter((key) => key.startsWith('event:v1:') && key !== pendingKey)

    // Past both compact-mode raw dimensions. Compatibility mode has no such
    // ceiling: it reads and writes this log exactly as the deployed version did.
    const legacyUsage = rawStorage(compat)
    expect(legacyUsage.events).toBeGreaterThan(LOG_LIMITS.rawEvents)
    expect(legacyUsage.bytes).toBeGreaterThan(LOG_LIMITS.rawBytes)

    const compatible = openFloor(compat, { CARPET_NETWORK: 'mock', CARPET_LOG_MODE: 'compat' })
    expect((await answer<MarketFacts>(await call(compatible, '/market/facts'))).listings).toHaveLength(6)
    expect(compat.values.has(pendingKey)).toBe(false)
    expect(acceptedBefore.every((key) => compat.values.has(key))).toBe(true)
    for (let index = 0; index < 3; index += 1) {
      expect(
        await answer<{ watching: boolean }>(
          await call(compatible, '/market/watch', { address: `kei_compat_still_accepts_writes_${index}` }),
        ),
      ).toEqual({ watching: true })
    }
    expect(compat.values.get('meta:event-sequence:v1')).toBe(29)
    expect(rawStorage(compat).events).toBe(acceptedBefore.length + 3)
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
  120_000,
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
  'an oversized compat log activates compact by reclaiming it, not by losing it',
  async () => {
    const base = new FakeStorage()
    await answer<MarketFacts>(await call(openFloor(base), '/market/facts'))

    const migrating = new FakeStorage()
    for (const [key, value] of base.values) migrating.values.set(key, structuredClone(value))
    storeOversizedLegacy(migrating, 24)

    // What the checkpoint-aware rollback floor reads in compat, for comparison.
    const reference = await answer<MarketFacts>(
      await call(
        openFloor(migrating, { CARPET_NETWORK: 'mock', CARPET_LOG_MODE: 'compat' }),
        '/market/facts',
      ),
    )
    const oversized = rawStorage(migrating)
    expect(oversized.events).toBeGreaterThan(LOG_LIMITS.rawEvents)
    expect(oversized.bytes).toBeGreaterThan(LOG_LIMITS.rawBytes)

    const compacting = openFloor(migrating, { CARPET_NETWORK: 'mock', CARPET_LOG_MODE: 'compact' })
    const migrated = await answer<MarketFacts>(await call(compacting, '/market/facts'))
    expect(migrated.address).toBe(reference.address)
    expect(migrated.listings.map((listing) => listing.asset)).toEqual(
      reference.listings.map((listing) => listing.asset),
    )

    // The first generation deliberately keeps the complete v1 log, so the
    // reclamation is its verified successor. Both remain readable afterwards.
    const pointers = migrating.values.get('meta:checkpoint:v2') as {
      active: { generation: number; eventCount: number; registryAddress: string; throughSequence: number }
      previous: { generation: number; throughSequence: number }
    }
    expect(pointers).toMatchObject({ active: { generation: 2 }, previous: { generation: 1 } })
    expect(pointers.active.registryAddress).toBe(reference.address)
    expect(pointers.active.throughSequence).toBe(24)
    expect(pointers.active.eventCount).toBe(2)
    expect(
      [...migrating.values.keys()].filter((key) => key.startsWith('checkpoint:v2:00000001:')).length,
    ).toBeGreaterThan(0)
    expect(rawStorage(migrating)).toEqual({ events: 0, bytes: 0 })

    // And it is an open market again, not a fail-closed one.
    const asset = migrated.listings.find((listing) => listing.symbol === 'FRINGE')!.asset
    expect(await answer<Book>(await call(compacting, `/market/book?asset=${asset}`))).toMatchObject({ asset })
    expect(
      await answer<{ watching: boolean }>(
        await call(compacting, '/market/watch', { address: (await keyPairFromSeed('43'.repeat(32), 0)).address }),
      ),
    ).toEqual({ watching: true })
    expect(rawStorage(migrating).events).toBe(1)
  },
  120_000,
)

test(
  'v1 cleanup failing after pointer activation cannot grow raw storage across restarts',
  async () => {
    const storage = new FakeStorage()
    storage.failCoveredCleanup = true
    // One real address, posted over and over. Canonicalisation folds it to a
    // single accepted event, so the canonical replay bound never refuses any of
    // this; only the rows the object actually persists grow.
    const watcher = (await keyPairFromSeed('41'.repeat(32), 0)).address

    const cycles: { events: number; bytes: number; accepted: number }[] = []
    let opening: MarketFacts | undefined
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const floor = openFloor(storage, { CARPET_NETWORK: 'mock', CARPET_LOG_MODE: 'compact' })
      const facts = await answer<MarketFacts>(await call(floor, '/market/facts'))
      opening ??= facts
      expect(facts.address).toBe(opening.address)
      expect(facts.listings.map((listing) => listing.asset)).toEqual(
        opening.listings.map((listing) => listing.asset),
      )

      const sequenceBefore = storage.values.get('meta:event-sequence:v1') as number
      let accepted = 0
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await call(floor, '/market/watch', { address: watcher })
        if (response.ok) {
          expect(await response.json()).toEqual({ watching: true })
          accepted += 1
          continue
        }
        expect(response.status).toBe(507)
        expect((await response.json()) as { error: string }).toHaveProperty('error')
      }
      // A refusal costs no sequence and no WAL row, in every cycle.
      expect(storage.values.get('meta:event-sequence:v1')).toBe(sequenceBefore + accepted)
      cycles.push({ ...rawStorage(storage), accepted })
    }

    // The defect: each restart cleared an in-memory latch, accepted another
    // compaction cycle of writes, and left its covered rows behind again. Row
    // 17 is where this object stops, in every life it has.
    expect(cycles.map((cycle) => cycle.events)).toEqual([16, 16, 16, 16, 16])
    expect(cycles.map((cycle) => cycle.accepted)).toEqual([15, 0, 0, 0, 0])
    for (const cycle of cycles) {
      expect(cycle.events).toBeLessThanOrEqual(LOG_LIMITS.rawEvents)
      expect(cycle.bytes).toBeLessThanOrEqual(LOG_LIMITS.rawBytes)
    }

    // What refuses is the persisted measurement, projected before anything is
    // allocated: the rows are inside the bound and one more would cross it.
    const persisted = rawStorage(storage)
    expect(rawLimitError(persisted)).toBeUndefined()
    expect(rawLimitError({ events: persisted.events + 1, bytes: persisted.bytes })).toMatchObject({
      status: 507,
    })

    // Reads and canonical state stay exactly available throughout.
    const last = openFloor(storage, { CARPET_NETWORK: 'mock', CARPET_LOG_MODE: 'compact' })
    const facts = await answer<MarketFacts>(await call(last, '/market/facts'))
    expect(facts.listings).toHaveLength(6)
    expect(facts.listings.map((listing) => listing.asset)).toEqual(
      opening!.listings.map((listing) => listing.asset),
    )
    const asset = facts.listings.find((listing) => listing.symbol === 'FRINGE')!.asset
    expect(await answer<Book>(await call(last, `/market/book?asset=${asset}`))).toMatchObject({
      asset,
    })
  },
  120_000,
)

test(
  'a transient cleanup failure is finished by the next boot without resetting authority',
  async () => {
    const storage = new FakeStorage()
    const watcher = (await keyPairFromSeed('42'.repeat(32), 0)).address
    const floor = openFloor(storage, { CARPET_NETWORK: 'mock', CARPET_LOG_MODE: 'compact' })
    const before = await answer<MarketFacts>(await call(floor, '/market/facts'))

    storage.failCoveredCleanup = true
    for (let attempt = 0; attempt < 16; attempt += 1) {
      await call(floor, '/market/watch', { address: watcher })
    }
    // The second generation activated and could not delete the rows its
    // predecessor covers, so this instance is fail-closed.
    const pointers = structuredClone(storage.values.get('meta:checkpoint:v2'))
    expect(pointers).toMatchObject({ active: { generation: 2 }, previous: { generation: 1 } })
    expect(rawStorage(storage).events).toBe(16)
    expect((await call(floor, '/market/watch', { address: watcher })).status).toBe(507)

    storage.failCoveredCleanup = false
    const reopened = openFloor(storage, { CARPET_NETWORK: 'mock', CARPET_LOG_MODE: 'compact' })
    const after = await answer<MarketFacts>(await call(reopened, '/market/facts'))
    expect(after.address).toBe(before.address)
    expect(after.listings.map((listing) => listing.asset)).toEqual(
      before.listings.map((listing) => listing.asset),
    )

    // Recovery is the delete that was owed, and nothing else: the same active
    // generation, the same retained predecessor, no new checkpoint, and
    // admission open again.
    expect(rawStorage(storage).events).toBe(8)
    expect(storage.values.get('meta:checkpoint:v2')).toEqual(pointers)
    expect(
      await answer<{ watching: boolean }>(await call(reopened, '/market/watch', { address: watcher })),
    ).toEqual({ watching: true })
    expect(rawStorage(storage).events).toBe(9)
  },
  120_000,
)

test(
  'only the same complete signed envelope retries without buying authority',
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

    const reorderedBlock = Object.fromEntries(Object.entries(accepted.block).reverse())
    // These are the same complete signed envelope. Ordinary client/proxy JSON
    // formatting and key order must not buy another authority row.
    const copies = [
      JSON.stringify(accepted, null, 2),
      JSON.stringify({ block: accepted.block, action: accepted.action }),
      JSON.stringify({ block: reorderedBlock, action: accepted.action }),
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

    // MockLedger itself returns a held block's hash before validating its
    // envelope. The Durable Object must not turn that quirk into successful
    // unsigned/tampered retries or hide the conflicting payload. They are
    // refused explicitly and consume no row or sequence.
    const { work: _work, signature: _signature, ...unsignedBlock } = accepted.block
    const conflicts = [
      JSON.stringify({ ...accepted, block: { ...accepted.block, signature: '0'.repeat(128) } }),
      JSON.stringify({ ...accepted, block: { ...accepted.block, work: 'f'.repeat(16) } }),
      JSON.stringify({ ...accepted, block: unsignedBlock }),
    ]
    for (const conflict of conflicts) {
      const response = await postBody(floor, conflict)
      expect(response.status).toBe(409)
      expect((await response.json()) as { error: string }).toMatchObject({
        error: expect.stringMatching(/envelope differs/i),
      })
    }

    // Nineteen re-encodings is more than the sixteen-event replay bound. If any
    // of them had bought a canonical slot the log would be full, the tail would
    // have compacted, and the honest write below would be refused instead.
    expect(eventRows(storage)).toEqual(rowsBefore)
    expect(storage.values.get('meta:event-sequence:v1')).toBe(sequenceBefore)

    // A cold replay retains the same exact-envelope contract.
    const reopened = openFloor(storage, { CARPET_NETWORK: 'mock', CARPET_LOG_MODE: 'compact' })
    const replayed = await postBody(reopened, copies[0]!)
    expect(replayed.status).toBe(200)
    expect(await replayed.json()).toEqual(hash)
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
