import { describe, expect, test } from 'bun:test'
import { keyPairFromSeed } from '@keicoin/core'

import {
  CHECKPOINT_POINTERS,
  EVENT_PREFIX,
  LOG_LIMITS,
  canonicalEvents,
  eventKey,
  loadLog,
  logSize,
  measureRawUsage,
  rawLimitError,
  readBoundedText,
  reclaimCoveredRows,
  writeCheckpoint,
  type LogStorage,
  type StoredEvent,
} from '../worker/durable-log.js'

class MemoryStorage implements LogStorage {
  readonly values = new Map<string, unknown>()
  readonly singleGets: string[] = []
  readonly multiGetSizes: number[] = []
  failPointer = false
  failDelete = false
  failCheckpointDelete = false
  /** A delete that reports success and removes nothing. */
  silentDelete = false

  async get<T>(key: string): Promise<T | undefined>
  async get<T>(keys: string[]): Promise<Map<string, T>>
  async get<T>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (typeof keyOrKeys === 'string') {
      this.singleGets.push(keyOrKeys)
      return structuredClone(this.values.get(keyOrKeys)) as T | undefined
    }
    this.multiGetSizes.push(keyOrKeys.length)
    const found = new Map<string, T>()
    for (const key of keyOrKeys) {
      if (this.values.has(key)) found.set(key, structuredClone(this.values.get(key)) as T)
    }
    return found
  }

  async put<T>(key: string, value: T): Promise<void>
  async put<T>(entries: Record<string, T>): Promise<void>
  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    const entries = typeof keyOrEntries === 'string' ? { [keyOrEntries]: value } : keyOrEntries
    if (this.failPointer && CHECKPOINT_POINTERS in entries) throw new Error('simulated pointer crash')
    for (const [key, entry] of Object.entries(entries)) this.values.set(key, structuredClone(entry))
  }

  async list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    const rows = [...this.values.entries()]
      .filter(([key]) => key.startsWith(options.prefix ?? ''))
      .sort(([left], [right]) => left.localeCompare(right))
    return new Map(rows) as Map<string, T>
  }

  async delete(keys: string[]): Promise<number> {
    if (this.failDelete) throw new Error('simulated cleanup crash')
    if (this.failCheckpointDelete && keys.some((key) => key.startsWith('checkpoint:v2:'))) {
      throw new Error('simulated inactive-checkpoint cleanup crash')
    }
    if (this.silentDelete) return keys.length
    let deleted = 0
    for (const key of keys) if (this.values.delete(key)) deleted += 1
    return deleted
  }

  async transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    const before = structuredClone(this.values)
    try {
      return await callback(this)
    } catch (error) {
      this.values.clear()
      for (const [key, value] of before) this.values.set(key, value)
      throw error
    }
  }
}

function seed(sequence = 0): StoredEvent {
  return {
    version: 1,
    sequence,
    status: 'accepted',
    kind: 'seed',
    at: 1,
    registryAddress: 'kei_registry',
  }
}

function watch(sequence: number, address = 'kei_watcher'): StoredEvent {
  return { version: 1, sequence, status: 'accepted', kind: 'watch', at: sequence, address }
}

function rawRows(storage: MemoryStorage): string[] {
  return [...storage.values.keys()].filter((key) => key.startsWith(EVENT_PREFIX)).sort()
}

async function storeLegacy(storage: MemoryStorage, events: StoredEvent[]): Promise<void> {
  const rows: Record<string, StoredEvent> = {}
  for (const event of events) rows[eventKey(event.sequence)] = event
  await storage.put(rows)
}

describe('durable replay checkpoints', () => {
  test('canonicalisation folds re-encoded process retries, set-like watches, and the reply tail', async () => {
    const { address } = await keyPairFromSeed('29'.repeat(32), 0)
    const block = {
      type: 'state',
      subtype: 'open',
      account: address,
      previous: '0'.repeat(64),
      representative: address,
      balance: '1000000000000000000',
      link: 'A'.repeat(64),
      work: 'abc',
      signature: 'F'.repeat(128),
    }
    // The same complete signed envelope spelled three ways, one conflicting
    // signature for the same block body, and one genuinely different block.
    const asPosted = JSON.stringify({ action: 'process', block })
    const reEncoded = JSON.stringify({ action: 'process', block }, null, 2)
    const reordered = JSON.stringify({
      block: Object.fromEntries(Object.entries(block).reverse()),
      action: 'process',
    })
    const reSigned = JSON.stringify({ action: 'process', block: { ...block, signature: '0'.repeat(128) } })
    const distinct = JSON.stringify({ action: 'process', block: { ...block, link: 'B'.repeat(64) } })

    const events: StoredEvent[] = [seed(), watch(1), watch(2)]
    for (let sequence = 3; sequence < 108; sequence += 1) {
      events.push({
        version: 1,
        sequence,
        status: 'accepted',
        kind: 'reply',
        at: sequence,
        body: {
          asset: 'A'.repeat(64),
          author: 'kei_author',
          body: `reply ${sequence}`,
          at: sequence,
          signature: `${sequence}`,
        },
      })
    }
    for (const [offset, body] of [asPosted, reEncoded, reordered, reSigned, distinct].entries()) {
      events.push({
        version: 1,
        sequence: 108 + offset,
        status: 'accepted',
        kind: 'rpc',
        at: 108 + offset,
        body,
      })
    }

    const compacted = canonicalEvents(events)
    expect(compacted.filter((event) => event.kind === 'watch').map((event) => event.sequence)).toEqual([1])
    expect(compacted.filter((event) => event.kind === 'reply')).toHaveLength(100)
    // Re-encoding/key order folds, but a different signature is not silently
    // equated with the accepted envelope, and a different block remains distinct.
    expect(compacted.filter((event) => event.kind === 'rpc').map((event) => event.sequence)).toEqual([
      108,
      111,
      112,
    ])
  })

  test('keeps a verified predecessor and v1 tail for active-checkpoint recovery', async () => {
    const storage = new MemoryStorage()
    const firstEvents = [seed(), ...Array.from({ length: 7 }, (_, index) => watch(index + 1))]
    await storeLegacy(storage, firstEvents)
    const first = await writeCheckpoint(storage, firstEvents, undefined)

    const tail = Array.from({ length: 8 }, (_, index) => watch(8 + index, `kei_${index}`))
    await storeLegacy(storage, tail)
    const second = await writeCheckpoint(storage, [...canonicalEvents(firstEvents), ...tail], first)

    expect(second.generation).toBe(2)
    expect([...storage.values.keys()].filter((key) => key.startsWith(EVENT_PREFIX))).toEqual(
      tail.map((event) => eventKey(event.sequence)),
    )

    const activeChunk = [...storage.values.keys()].find(
      (key) => key.includes('checkpoint:v2:00000002:chunk:'),
    )!
    storage.values.delete(activeChunk)

    const recovered = await loadLog(storage)
    expect(recovered.recoveredFrom).toBe('previous')
    expect(canonicalEvents(recovered.events)).toEqual(canonicalEvents([...firstEvents, ...tail]))
  })

  test('a crash before the pointer switch leaves the complete v1 authority active', async () => {
    const storage = new MemoryStorage()
    const events = [seed(), watch(1)]
    await storeLegacy(storage, events)
    storage.failPointer = true
    await expect(writeCheckpoint(storage, events, undefined)).rejects.toThrow('pointer crash')
    storage.failPointer = false

    const loaded = await loadLog(storage)
    expect(loaded.checkpoint).toBeUndefined()
    expect(loaded.events).toEqual(events)
  })

  test('a crash during cleanup leaves the newly verified generation authoritative', async () => {
    const storage = new MemoryStorage()
    const firstEvents = [seed(), watch(1)]
    await storeLegacy(storage, firstEvents)
    const first = await writeCheckpoint(storage, firstEvents, undefined)
    const tail = [watch(2, 'kei_other')]
    await storeLegacy(storage, tail)
    storage.failDelete = true
    await expect(writeCheckpoint(storage, [...firstEvents, ...tail], first)).rejects.toThrow('cleanup crash')
    storage.failDelete = false

    const loaded = await loadLog(storage)
    expect(loaded.checkpoint?.generation).toBe(2)
    expect(canonicalEvents(loaded.events)).toEqual(canonicalEvents([...firstEvents, ...tail]))
  })

  test('raw usage counts stored rows that canonical replay no longer looks at', async () => {
    const storage = new MemoryStorage()
    const firstEvents = [seed(), ...Array.from({ length: 7 }, (_, index) => watch(index + 1))]
    await storeLegacy(storage, firstEvents)
    const first = await writeCheckpoint(storage, firstEvents, undefined)
    const tail = Array.from({ length: 8 }, (_, index) => watch(8 + index, `kei_${index}`))
    await storeLegacy(storage, tail)
    const second = await writeCheckpoint(storage, [...canonicalEvents(firstEvents), ...tail], first)
    expect(rawRows(storage)).toHaveLength(8)

    // Exactly what a cleanup failure after pointer activation leaves behind:
    // rows the active generation already covers.
    await storeLegacy(storage, firstEvents)

    const loaded = await loadLog(storage)
    expect(loaded.checkpoint?.generation).toBe(second.generation)
    expect(loaded.recoveredFrom).toBeUndefined()
    expect(loaded.tailEvents).toBe(0)
    // Canonical replay is unchanged by them, which is the whole problem: they
    // are persisted bytes that no canonical measure can see.
    expect(loaded.events).toHaveLength(10)
    const usage = await measureRawUsage(storage)
    expect(usage).toEqual(logSize([...firstEvents, ...tail]))
    expect(usage.events).toBe(16)
    expect(rawLimitError(usage)).toBeUndefined()
    expect(rawLimitError({ events: usage.events + 1, bytes: usage.bytes })).toMatchObject({ status: 507 })
    expect(rawLimitError({ events: usage.events, bytes: LOG_LIMITS.rawBytes + 1 })).toMatchObject({
      status: 507,
    })

    // Finishing the cleanup is a delete of the same covered keys, nothing else.
    const pointers = structuredClone(storage.values.get(CHECKPOINT_POINTERS))
    expect(await reclaimCoveredRows(storage)).toBe('reclaimed')
    expect(await measureRawUsage(storage)).toEqual(logSize(tail))
    expect(storage.values.get(CHECKPOINT_POINTERS)).toEqual(pointers)
    expect((await loadLog(storage)).events).toEqual(loaded.events)
  })

  test('reclamation keeps covered rows when the retained predecessor cannot be verified', async () => {
    const storage = new MemoryStorage()
    const firstEvents = [seed(), watch(1)]
    await storeLegacy(storage, firstEvents)
    const first = await writeCheckpoint(storage, firstEvents, undefined)
    const tail = [watch(2, 'kei_other')]
    await storeLegacy(storage, tail)
    await writeCheckpoint(storage, [...firstEvents, ...tail], first)
    await storeLegacy(storage, firstEvents)

    const damaged = [...storage.values.keys()].find((key) => key.includes('checkpoint:v2:00000001:chunk:'))!
    storage.values.delete(damaged)

    // Those rows are the second recovery path. Reclaiming them against a
    // predecessor that no longer reads would leave exactly one.
    const before = rawRows(storage)
    expect(await reclaimCoveredRows(storage)).toBe('unverified-predecessor')
    expect(rawRows(storage)).toEqual(before)
  })

  test('a cleanup that reports success and removes nothing is a compaction failure', async () => {
    const storage = new MemoryStorage()
    const firstEvents = [seed(), watch(1)]
    await storeLegacy(storage, firstEvents)
    const first = await writeCheckpoint(storage, firstEvents, undefined)
    const tail = [watch(2, 'kei_other')]
    await storeLegacy(storage, tail)
    storage.silentDelete = true

    await expect(writeCheckpoint(storage, [...firstEvents, ...tail], first)).rejects.toThrow(
      /Cleanup left 2 event:v1 rows/,
    )
    storage.silentDelete = false
    // The generation still activated, so the next boot reclaims rather than
    // stacking another generation on rows it has proved it cannot remove.
    expect((await loadLog(storage)).checkpoint?.generation).toBe(2)
    expect(await reclaimCoveredRows(storage)).toBe('reclaimed')
    expect(await measureRawUsage(storage)).toMatchObject({ events: 1 })
  })

  test('inactive-generation cleanup is restart-safe and does not stack generations', async () => {
    const storage = new MemoryStorage()
    const firstEvents = [seed(), watch(1)]
    await storeLegacy(storage, firstEvents)
    const first = await writeCheckpoint(storage, firstEvents, undefined)

    const secondTail = [watch(2, 'kei_second')]
    await storeLegacy(storage, secondTail)
    const secondEvents = [...canonicalEvents(firstEvents), ...secondTail]
    const second = await writeCheckpoint(storage, secondEvents, first)

    const thirdTail = [watch(3, 'kei_third')]
    await storeLegacy(storage, thirdTail)
    storage.failCheckpointDelete = true
    await expect(
      writeCheckpoint(storage, [...canonicalEvents(secondEvents), ...thirdTail], second),
    ).rejects.toThrow('inactive-checkpoint cleanup crash')

    const pointerAfterFailure = structuredClone(storage.values.get(CHECKPOINT_POINTERS))
    expect(pointerAfterFailure).toMatchObject({ active: { generation: 3 }, previous: { generation: 2 } })
    const checkpointRows = () =>
      [...storage.values.keys()].filter((key) => key.startsWith('checkpoint:v2:')).sort()
    expect(checkpointRows()).toHaveLength(6)

    // A persistent failure repeats only cleanup; it does not write generation 4.
    await expect(reclaimCoveredRows(storage)).rejects.toThrow('inactive-checkpoint cleanup crash')
    expect(checkpointRows()).toHaveLength(6)
    expect(storage.values.get(CHECKPOINT_POINTERS)).toEqual(pointerAfterFailure)

    storage.failCheckpointDelete = false
    expect(await reclaimCoveredRows(storage)).toBe('reclaimed')
    expect(checkpointRows()).toHaveLength(4)
    expect(storage.values.get(CHECKPOINT_POINTERS)).toEqual(pointerAfterFailure)
    expect((await loadLog(storage)).events).toEqual(canonicalEvents([...secondEvents, ...thirdTail]))
  })

  test('streaming request limits reject before retaining an oversized body', async () => {
    const request = new Request('https://example.test/rpc', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('12345'))
          controller.enqueue(new TextEncoder().encode('67890'))
          controller.close()
        },
      }),
    })
    await expect(readBoundedText(request, 8)).rejects.toMatchObject({ status: 413 })
  })

  test('hostile pointer manifests fall back before computed checkpoint reads or allocations', async () => {
    const base = {
      version: 2,
      generation: 1,
      throughSequence: 0,
      chunkCount: 1,
      eventCount: 1,
      eventBytes: 1,
      digest: '0'.repeat(64),
      registryAddress: 'kei_registry',
      createdAt: 1,
    }
    const corruptions: Record<string, unknown>[] = [
      { generation: Number.NaN },
      { generation: Number.MAX_SAFE_INTEGER + 1 },
      { throughSequence: -1 },
      { throughSequence: Number.POSITIVE_INFINITY },
      { chunkCount: 0 },
      { chunkCount: 1.5 },
      { chunkCount: Number.MAX_SAFE_INTEGER },
      { eventCount: 0 },
      { eventCount: Number.NaN },
      { eventCount: LOG_LIMITS.replayEvents + 1 },
      { eventBytes: 0 },
      { eventBytes: Number.POSITIVE_INFINITY },
      { eventBytes: LOG_LIMITS.replayBytes + 1 },
      { digest: 'not-a-sha256-digest' },
      { registryAddress: 'x'.repeat(129) },
      { createdAt: Number.NaN },
      { createdAt: 1.5 },
      { unexpected: 'unversioned metadata' },
      { eventCount: 2, throughSequence: 0 },
      { eventCount: 2, eventBytes: 1, throughSequence: 1 },
    ]

    for (const corruption of corruptions) {
      const storage = new MemoryStorage()
      await storeLegacy(storage, [seed()])
      storage.values.set(CHECKPOINT_POINTERS, { version: 2, active: { ...base, ...corruption } })
      storage.singleGets.length = 0

      const recovered = await loadLog(storage)
      expect(recovered).toMatchObject({ events: [seed()], recoveredFrom: 'legacy' })
      expect(storage.singleGets).toEqual([CHECKPOINT_POINTERS])
      expect(storage.multiGetSizes).toEqual([])
    }
  })

  test('hostile stored manifest metadata is rejected before chunk-key allocation', async () => {
    const storage = new MemoryStorage()
    const events = [seed()]
    await storeLegacy(storage, events)
    const manifest = await writeCheckpoint(storage, events, undefined)
    storage.values.set(`checkpoint:v2:${manifest.generation.toString().padStart(8, '0')}:manifest`, {
      ...manifest,
      chunkCount: Number.MAX_SAFE_INTEGER,
    })
    storage.singleGets.length = 0
    storage.multiGetSizes.length = 0

    const recovered = await loadLog(storage)
    expect(recovered).toMatchObject({ events, recoveredFrom: 'legacy' })
    expect(storage.singleGets).toHaveLength(2)
    expect(storage.singleGets[0]).toBe(CHECKPOINT_POINTERS)
    expect(storage.singleGets[1]).toMatch(/^checkpoint:v2:.*:manifest$/)
    expect(storage.multiGetSizes).toEqual([])
  })

  test('an invalid active manifest still recovers through its verified predecessor', async () => {
    const storage = new MemoryStorage()
    const events = [seed()]
    await storeLegacy(storage, events)
    const previous = await writeCheckpoint(storage, events, undefined)
    storage.values.set(CHECKPOINT_POINTERS, {
      version: 2,
      active: { ...previous, generation: 2, chunkCount: Number.MAX_SAFE_INTEGER },
      previous,
    })
    storage.singleGets.length = 0
    storage.multiGetSizes.length = 0

    const recovered = await loadLog(storage)
    expect(recovered).toMatchObject({ events, checkpoint: previous, recoveredFrom: 'previous' })
    expect(storage.singleGets.filter((key) => key.startsWith('checkpoint:v2:'))).toHaveLength(1)
    expect(storage.multiGetSizes).toEqual([1])
  })

  test('unbounded checkpoint metadata fails closed without a legacy recovery path', async () => {
    const storage = new MemoryStorage()
    storage.values.set(CHECKPOINT_POINTERS, {
      version: 2,
      active: {
        version: 2,
        generation: 1,
        throughSequence: 0,
        chunkCount: Number.MAX_SAFE_INTEGER,
        eventCount: 1,
        eventBytes: 1,
        digest: '0'.repeat(64),
        registryAddress: 'kei_registry',
        createdAt: 1,
      },
    })

    await expect(loadLog(storage)).rejects.toThrow(/failed verification.*point-in-time recovery/i)
    expect(storage.singleGets).toEqual([CHECKPOINT_POINTERS])
    expect(storage.multiGetSizes).toEqual([])
  })
})
