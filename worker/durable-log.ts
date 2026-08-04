/**
 * Versioned, bounded authority for the mock Durable Object.
 *
 * The deployed v1 format is one `event:v1:*` row per accepted input.  A v2
 * checkpoint is deliberately still a replay checkpoint, not a serialization
 * of MockLedger internals: it contains the same accepted inputs, split into
 * small immutable chunks and covered by SHA-256.  That keeps upgrades honest
 * while @keicoin/core has no supported state export/import API.
 *
 * Checkpoints retain one verified predecessor and the v1 tail after it.  If the
 * active generation is incomplete or corrupt, boot can recover from the prior
 * generation plus that tail.  Inactive chunks are never authoritative.
 */

export type EventInput =
  | { at: number; kind: 'seed'; registryAddress: string }
  | { at: number; kind: 'rpc'; body: string }
  | { at: number; kind: 'launch'; body: { address: string } & Record<string, unknown> }
  | { at: number; kind: 'watch'; address: string }
  | {
      at: number
      kind: 'reply'
      body: { asset: string; author: string; body: string; at: number; signature: string }
    }

export type StoredEvent = EventInput & {
  version: 1
  sequence: number
  status: 'pending' | 'accepted'
}

export interface LogLimits {
  requestBytes: number
  replayEvents: number
  replayBytes: number
  compactAfter: number
}

export const LOG_LIMITS: LogLimits = {
  // The largest accepted event in the measured first-buy + payment workload is
  // 836 bytes. Roughly 4.9x headroom permits envelope evolution without reading
  // an unbounded request into the isolate.
  requestBytes: 4 * 1024,
  // A 15-event mixed replay is measured in the real Workers runtime and remains
  // below the documented 60 s cold target. Both dimensions are hard admission
  // bounds; neither is silently truncated.
  replayEvents: 16,
  replayBytes: 16 * 1024,
  compactAfter: 8,
}

export const EVENT_PREFIX = 'event:v1:'
export const NEXT_SEQUENCE = 'meta:event-sequence:v1'
export const CHECKPOINT_POINTERS = 'meta:checkpoint:v2'
const CHECKPOINT_PREFIX = 'checkpoint:v2:'
const CHUNK_TARGET_BYTES = 128 * 1024
const REPLIES_PER_ASSET = 100

export interface CheckpointManifest {
  version: 2
  generation: number
  throughSequence: number
  chunkCount: number
  eventCount: number
  eventBytes: number
  digest: string
  registryAddress: string
  createdAt: number
}

interface CheckpointPointers {
  version: 2
  active: CheckpointManifest
  previous?: CheckpointManifest
}

export interface LoadedLog {
  events: StoredEvent[]
  tailEvents: number
  checkpoint?: CheckpointManifest
  recoveredFrom?: 'previous' | 'legacy'
}

interface LogTransaction {
  put<T>(key: string, value: T): Promise<void>
  put<T>(entries: Record<string, T>): Promise<void>
}

export interface LogStorage extends LogTransaction {
  get<T = unknown>(key: string): Promise<T | undefined>
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>
  delete(keys: string[]): Promise<number>
  transaction<T>(closure: (transaction: LogTransaction) => Promise<T>): Promise<T>
}

export class ReplayLimitError extends Error {
  constructor(message: string, readonly status = 507) {
    super(message)
  }
}

export function eventKey(sequence: number): string {
  return `${EVENT_PREFIX}${sequence.toString().padStart(12, '0')}`
}

export function eventBytes(event: StoredEvent): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength
}

export function logSize(events: readonly StoredEvent[]): { events: number; bytes: number } {
  return {
    events: events.length,
    bytes: events.reduce((total, event) => total + eventBytes(event), 0),
  }
}

export function assertWithinReplayLimits(events: readonly StoredEvent[], limits = LOG_LIMITS): void {
  const error = replayLimitError(events, limits)
  if (error) throw error
}

export function replayLimitError(
  events: readonly StoredEvent[],
  limits = LOG_LIMITS,
): ReplayLimitError | undefined {
  const size = logSize(events)
  if (size.events > limits.replayEvents || size.bytes > limits.replayBytes) {
    return new ReplayLimitError(
      `The mock market replay log is full (${size.events}/${limits.replayEvents} events, ${size.bytes}/${limits.replayBytes} bytes). No ledger mutation was accepted. An operator must preserve and migrate the current checkpoint before raising this measured safety bound.`,
    )
  }
  return undefined
}

/**
 * Only discard inputs with explicitly idempotent or bounded/set-like semantics.
 * Distinct ledger RPC and launch ordering are never rewritten.
 */
export function canonicalEvents(events: readonly StoredEvent[]): StoredEvent[] {
  const accepted = events.filter((event) => event.status === 'accepted')
  const firstWatch = new Map<string, number>()
  const firstProcess = new Map<string, number>()
  const keptReplies = new Set<number>()
  const replies = new Map<string, StoredEvent[]>()

  for (const event of accepted) {
    if (event.kind === 'watch' && !firstWatch.has(event.address)) firstWatch.set(event.address, event.sequence)
    if (event.kind === 'rpc') {
      const process = processInputIdentity(event.body)
      if (process !== undefined && !firstProcess.has(process)) firstProcess.set(process, event.sequence)
    }
    if (event.kind === 'reply') {
      const thread = replies.get(event.body.asset) ?? []
      thread.push(event)
      thread.sort((left, right) => {
        if (left.kind !== 'reply' || right.kind !== 'reply') return left.sequence - right.sequence
        return left.body.at - right.body.at || left.sequence - right.sequence
      })
      while (thread.length > REPLIES_PER_ASSET) thread.shift()
      replies.set(event.body.asset, thread)
    }
  }
  for (const thread of replies.values()) for (const event of thread) keptReplies.add(event.sequence)

  return accepted.filter((event) => {
    if (event.kind === 'watch') return firstWatch.get(event.address) === event.sequence
    if (event.kind === 'rpc') {
      const process = processInputIdentity(event.body)
      if (process !== undefined) return firstProcess.get(process) === event.sequence
    }
    if (event.kind === 'reply') return keptReplies.has(event.sequence)
    return true
  })
}

/** Exact accepted process bodies are ledger-idempotent and need one authority row. */
export function processInputIdentity(body: string): string | undefined {
  try {
    const input = JSON.parse(body) as { action?: unknown; block?: unknown }
    return input.action === 'process' && input.block !== null && typeof input.block === 'object'
      ? body
      : undefined
  } catch {
    return undefined
  }
}

export async function loadLog(storage: LogStorage): Promise<LoadedLog> {
  const legacy = await storage.list<StoredEvent>({ prefix: EVENT_PREFIX })
  const legacyEvents = sortEvents([...legacy.values()])
  const pointers = await storage.get<CheckpointPointers>(CHECKPOINT_POINTERS)
  if (!pointers || pointers.version !== 2) return { events: legacyEvents, tailEvents: legacyEvents.length }

  const active = await readCheckpoint(storage, pointers.active)
  if (active) {
    const tail = legacyEvents.filter((event) => event.sequence > pointers.active.throughSequence)
    return {
      events: mergeEvents(active, tail),
      tailEvents: tail.length,
      checkpoint: pointers.active,
    }
  }

  if (pointers.previous) {
    const previous = await readCheckpoint(storage, pointers.previous)
    if (previous) {
      const tail = legacyEvents.filter((event) => event.sequence > pointers.previous!.throughSequence)
      return {
        events: mergeEvents(previous, tail),
        tailEvents: tail.length,
        checkpoint: pointers.previous,
        recoveredFrom: 'previous',
      }
    }
  }

  // First-generation compaction deliberately retains the complete legacy log,
  // which is the last safe fallback if both checkpoint pointers are unreadable.
  if (legacyEvents.some((event) => event.kind === 'seed')) {
    return { events: legacyEvents, tailEvents: legacyEvents.length, recoveredFrom: 'legacy' }
  }
  throw new Error(
    'The active and previous mock checkpoints failed verification and no complete v1 seed log remains. Restore the named Durable Object with point-in-time recovery; do not reset it.',
  )
}

export async function writeCheckpoint(
  storage: LogStorage,
  events: readonly StoredEvent[],
  current: CheckpointManifest | undefined,
): Promise<CheckpointManifest> {
  const compacted = canonicalEvents(events)
  assertWithinReplayLimits(compacted)
  const registryAddress = seedAddress(compacted)
  const oldPointers = await storage.get<CheckpointPointers>(CHECKPOINT_POINTERS)
  const generation =
    Math.max(
      current?.generation ?? 0,
      oldPointers?.active.generation ?? 0,
      oldPointers?.previous?.generation ?? 0,
    ) + 1
  const serialized = JSON.stringify(compacted)
  const digest = await sha256(serialized)
  const chunks = chunkEvents(compacted)
  // The checkpoint semantically covers every input through this sequence,
  // including redundant set/reply inputs removed by canonicalisation.
  const throughSequence = events.reduce((last, event) => Math.max(last, event.sequence), -1)
  const size = logSize(compacted)
  const manifest: CheckpointManifest = {
    version: 2,
    generation,
    throughSequence,
    chunkCount: chunks.length,
    eventCount: size.events,
    eventBytes: size.bytes,
    digest,
    registryAddress,
    createdAt: Date.now(),
  }

  await storage.transaction(async (transaction) => {
    const rows: Record<string, StoredEvent[] | CheckpointManifest> = {
      [manifestKey(generation)]: manifest,
    }
    chunks.forEach((chunk, index) => {
      rows[chunkKey(generation, index)] = chunk
    })
    await transaction.put(rows)
  })

  const verified = await readCheckpoint(storage, manifest)
  if (!verified) throw new Error(`Checkpoint generation ${generation} failed verification before activation.`)

  await storage.put(CHECKPOINT_POINTERS, {
    version: 2,
    active: manifest,
    ...(current ? { previous: current } : {}),
  } satisfies CheckpointPointers)

  // Keep the predecessor and every v1 row after it. That is a complete recovery
  // path if the newly active generation becomes unreadable.
  if (current) {
    const legacy = await storage.list<StoredEvent>({ prefix: EVENT_PREFIX })
    const removable = [...legacy.entries()]
      .filter(([, event]) => event.sequence <= current.throughSequence)
      .map(([key]) => key)
    await deleteKeys(storage, removable)
  }
  await removeInactiveCheckpoints(storage, new Set([manifest.generation, current?.generation]))
  return manifest
}

export async function readBoundedText(request: Request, maxBytes = LOG_LIMITS.requestBytes): Promise<string> {
  const claimed = Number(request.headers.get('content-length'))
  if (Number.isFinite(claimed) && claimed > maxBytes) throw requestTooLarge(maxBytes)
  if (!request.body) return ''

  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        throw requestTooLarge(maxBytes)
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function requestTooLarge(maxBytes: number): ReplayLimitError {
  return new ReplayLimitError(
    `That request is larger than the mock market's ${maxBytes}-byte durable-input limit. Nothing was written.`,
    413,
  )
}

async function readCheckpoint(
  storage: LogStorage,
  expected: CheckpointManifest,
): Promise<StoredEvent[] | undefined> {
  try {
    const manifest = await storage.get<CheckpointManifest>(manifestKey(expected.generation))
    if (!manifest || JSON.stringify(manifest) !== JSON.stringify(expected)) return undefined
    const keys = Array.from({ length: manifest.chunkCount }, (_, index) => chunkKey(manifest.generation, index))
    const rows = await storage.get<StoredEvent[]>(keys)
    if (rows.size !== keys.length) return undefined
    const events = keys.flatMap((key) => rows.get(key) ?? [])
    if (events.length !== manifest.eventCount) return undefined
    if (logSize(events).bytes !== manifest.eventBytes) return undefined
    if (seedAddress(events) !== manifest.registryAddress) return undefined
    if ((await sha256(JSON.stringify(events))) !== manifest.digest) return undefined
    return sortEvents(events)
  } catch {
    return undefined
  }
}

function chunkEvents(events: readonly StoredEvent[]): StoredEvent[][] {
  const chunks: StoredEvent[][] = []
  let chunk: StoredEvent[] = []
  let bytes = 2
  for (const event of events) {
    const next = eventBytes(event) + (chunk.length === 0 ? 0 : 1)
    if (chunk.length > 0 && bytes + next > CHUNK_TARGET_BYTES) {
      chunks.push(chunk)
      chunk = []
      bytes = 2
    }
    chunk.push(event)
    bytes += next
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}

function seedAddress(events: readonly StoredEvent[]): string {
  const seed = events.find(
    (event): event is StoredEvent & { kind: 'seed'; registryAddress: string } => event.kind === 'seed',
  )
  if (!seed) throw new Error('A replay checkpoint cannot be created without its public registry identity.')
  return seed.registryAddress
}

function mergeEvents(checkpoint: readonly StoredEvent[], tail: readonly StoredEvent[]): StoredEvent[] {
  const bySequence = new Map<number, StoredEvent>()
  for (const event of [...checkpoint, ...tail]) bySequence.set(event.sequence, event)
  return sortEvents([...bySequence.values()])
}

function sortEvents(events: StoredEvent[]): StoredEvent[] {
  return events.sort((left, right) => left.sequence - right.sequence)
}

function manifestKey(generation: number): string {
  return `${CHECKPOINT_PREFIX}${generation.toString().padStart(8, '0')}:manifest`
}

function chunkKey(generation: number, index: number): string {
  return `${CHECKPOINT_PREFIX}${generation.toString().padStart(8, '0')}:chunk:${index.toString().padStart(4, '0')}`
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function deleteKeys(storage: LogStorage, keys: string[]): Promise<void> {
  for (let offset = 0; offset < keys.length; offset += 128) {
    await storage.delete(keys.slice(offset, offset + 128))
  }
}

async function removeInactiveCheckpoints(storage: LogStorage, keep: Set<number | undefined>): Promise<void> {
  const rows = await storage.list({ prefix: CHECKPOINT_PREFIX })
  const removable = [...rows.keys()].filter((key) => {
    const generation = Number(key.slice(CHECKPOINT_PREFIX.length).split(':', 1)[0])
    return !keep.has(generation)
  })
  await deleteKeys(storage, removable)
}
