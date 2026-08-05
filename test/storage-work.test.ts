/**
 * The storage cost of one accepted mutation, counted rather than asserted.
 *
 * Issue #8 asks for "Durable Object storage reads/writes and rows per accepted
 * mutation" as evidence, and the first version of that metric answered with the
 * literal `3` and `3` — a figure somebody arrived at by reading `#append` and
 * `#accept` once. Two things were wrong with it. It was already inaccurate, and
 * more importantly a literal cannot go stale loudly: any later change to either
 * method would have left it both wrong and entirely plausible.
 *
 * So the test here is not "the number is 5". Pinning the figure would recreate
 * the same defect one layer out, in a file that fails instead of a dashboard
 * that lies. What is asserted is the property that makes the metric worth
 * publishing: **what the object reports is what the object did.** The counting
 * happens in `countingStorage`; this drives a real mutation through the fake
 * Durable Object, counts the calls that reach storage from the outside, and
 * requires the two to agree.
 *
 * A change that adds a storage call to the write path therefore moves both
 * numbers and stays green, which is correct — and a change that reports a
 * hard-coded or partially-wired figure moves only one, and fails.
 */

import { expect, mock, test } from 'bun:test'

mock.module('cloudflare:workers', () => ({
  DurableObject: class<Environment> {
    readonly ctx: unknown
    readonly env: Environment

    constructor(ctx: unknown, env: Environment) {
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

interface Counted {
  operations: number
  keyWrites: number
}

/**
 * Storage that keeps its own tally, arrived at independently of the worker's.
 *
 * The rules are the ones `countingStorage` documents — a call is an operation, a
 * key written or deleted is a key write, a transaction is an operation plus
 * whatever happens inside it — restated here rather than imported, because a
 * tally that shared its implementation with the thing it checks would agree with
 * it however wrong both were.
 */
class TallyingStorage {
  readonly values = new Map<string, unknown>()
  readonly counted: Counted = { operations: 0, keyWrites: 0 }

  async get<T>(key: string): Promise<T | undefined>
  async get<T>(keys: string[]): Promise<Map<string, T>>
  async get<T>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
    this.counted.operations += 1
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
    this.counted.operations += 1
    this.counted.keyWrites += Object.keys(entries).length
    for (const [key, entry] of Object.entries(entries)) this.values.set(key, structuredClone(entry))
  }

  async delete(key: string): Promise<boolean>
  async delete(keys: string[]): Promise<number>
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    this.counted.operations += 1
    if (typeof keyOrKeys === 'string') {
      this.counted.keyWrites += 1
      return this.values.delete(keyOrKeys)
    }
    this.counted.keyWrites += keyOrKeys.length
    let deleted = 0
    for (const key of keyOrKeys) if (this.values.delete(key)) deleted += 1
    return deleted
  }

  async list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    this.counted.operations += 1
    const rows = [...this.values.entries()]
      .filter(([key]) => key.startsWith(options.prefix ?? ''))
      .sort(([left], [right]) => left.localeCompare(right))
    return new Map(rows) as Map<string, T>
  }

  async transaction<T>(callback: (storage: TallyingStorage) => Promise<T>): Promise<T> {
    this.counted.operations += 1
    return callback(this)
  }
}

class FakeState {
  constructor(readonly storage: TallyingStorage) {}

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback()
  }
}

interface Observation {
  action: string
  storageOperations?: number
  storageKeyWrites?: number
  admissionListReads?: number
}

/**
 * Drive one accepted mutation and hand back what storage did and what the object
 * said it did.
 *
 * `/market/watch` is the mutation chosen because it is the cheapest one that
 * still goes through the whole write path: admission, the WAL append, the status
 * rewrite and the read-back that proves it landed. A launch or a signed block
 * would exercise the ledger as well, which is cost this metric is not about.
 */
async function mutate(env: Record<string, string>): Promise<{ storage: Counted; observed: Observation }> {
  const storage = new TallyingStorage()
  const floor = new Floor(new FakeState(storage), env)
  const observations: Observation[] = []
  const log = console.log

  // The metric is a log line, so reading it means reading the log. Restored in a
  // `finally` so a failing assertion does not leave the suite mute.
  console.log = (line: unknown) => {
    try {
      const entry = JSON.parse(String(line)) as Observation
      if (entry.action) observations.push(entry)
    } catch {
      log(line)
    }
  }

  try {
    // Boot first, outside the measurement. Replay reads storage, and its reads
    // are reported as `replayMs` and `rawEvents` rather than as the cost of a
    // mutation nobody has made yet.
    await floor.fetch(new Request('https://example.test/examples/carpet-markets/market/facts'))
    // The deterministic bootstrap is itself a run of accepted mutations, so both
    // tallies start from after it. What is measured is one mutation a caller made.
    observations.length = 0
    const before = { ...storage.counted }

    const response = await floor.fetch(
      new Request('https://example.test/examples/carpet-markets/market/watch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: 'kei_storage_work_is_counted' }),
      }),
    )
    expect(response.ok).toBe(true)

    const accepted = observations.filter((entry) => entry.action === 'accepted')
    expect(accepted).toHaveLength(1)

    return {
      storage: {
        operations: storage.counted.operations - before.operations,
        keyWrites: storage.counted.keyWrites - before.keyWrites,
      },
      observed: accepted[0]!,
    }
  } finally {
    console.log = log
  }
}

test('an accepted mutation reports the storage work it actually did', async () => {
  const { storage, observed } = await mutate({ CARPET_NETWORK: 'mock' })

  expect(observed.storageOperations).toBe(storage.operations)
  expect(observed.storageKeyWrites).toBe(storage.keyWrites)

  // Enough of a mutation to be worth measuring at all: a write path that touched
  // storage zero times would satisfy the equality above and mean nothing.
  expect(storage.operations).toBeGreaterThan(0)
  expect(storage.keyWrites).toBeGreaterThan(0)
}, 60_000)

test('compact mode reports the admission read it does, and default mode does not', async () => {
  const plain = await mutate({ CARPET_NETWORK: 'mock' })
  const compact = await mutate({ CARPET_NETWORK: 'mock', CARPET_LOG_MODE: 'compact' })

  expect(compact.observed.storageOperations).toBe(compact.storage.operations)
  expect(compact.observed.storageKeyWrites).toBe(compact.storage.keyWrites)

  // Compact mode lists the persisted `event:v1:*` prefix before it allocates
  // anything, so it costs one operation more than default mode. That the two
  // differ at all is what a constant could never have shown.
  expect(compact.observed.admissionListReads).toBe(1)
  expect(plain.observed.admissionListReads).toBe(0)
  expect(compact.storage.operations).toBe(plain.storage.operations + 1)
  expect(compact.observed.storageOperations).toBe((plain.observed.storageOperations ?? 0) + 1)
}, 120_000)
