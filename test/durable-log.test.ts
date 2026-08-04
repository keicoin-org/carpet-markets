import { describe, expect, test } from 'bun:test'
import { keyPairFromSeed } from '@keicoin/core'

import {
  CHECKPOINT_POINTERS,
  EVENT_PREFIX,
  canonicalEvents,
  eventKey,
  loadLog,
  readBoundedText,
  writeCheckpoint,
  type LogStorage,
  type StoredEvent,
} from '../worker/durable-log.js'

class MemoryStorage implements LogStorage {
  readonly values = new Map<string, unknown>()
  failPointer = false
  failDelete = false

  async get<T>(key: string): Promise<T | undefined>
  async get<T>(keys: string[]): Promise<Map<string, T>>
  async get<T>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (typeof keyOrKeys === 'string') return structuredClone(this.values.get(keyOrKeys)) as T | undefined
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
    // The same block the ledger already holds, spelled three ways a client or a
    // proxy could legitimately produce, plus one genuinely different block.
    const asPosted = JSON.stringify({ action: 'process', block })
    const reEncoded = JSON.stringify({ action: 'process', block }, null, 2)
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
    for (const [offset, body] of [asPosted, reEncoded, reSigned, distinct].entries()) {
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
    // The first spelling of the block that moved the ledger, and the other
    // block. Re-encoding and re-signing buy nothing.
    expect(compacted.filter((event) => event.kind === 'rpc').map((event) => event.sequence)).toEqual([
      108,
      111,
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
})
