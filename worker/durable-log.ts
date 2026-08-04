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

import { canonicalJson, hashBlock, type BlockBody } from '@keicoin/core'

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
  rawEvents: number
  rawBytes: number
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
  // What `event:v1:*` may actually hold in compact mode, which is not what
  // replay folds those rows into. A generation retains the compaction cycle
  // after its predecessor and admits at most one more cycle before the next
  // checkpoint reclaims the older one, so two cycles is the whole working set:
  // 2 * compactAfter rows, and twice replayBytes because that tail may still
  // hold duplicates canonicalisation has not folded away yet. Rows an activated
  // checkpoint already covers are invisible to canonical history, so this is
  // the only bound that a failed cleanup cannot walk past.
  rawEvents: 16,
  rawBytes: 32 * 1024,
}

export const EVENT_PREFIX = 'event:v1:'
export const NEXT_SEQUENCE = 'meta:event-sequence:v1'
export const CHECKPOINT_POINTERS = 'meta:checkpoint:v2'
const CHECKPOINT_PREFIX = 'checkpoint:v2:'
const CHUNK_TARGET_BYTES = 128 * 1024
// A checkpoint is admitted only inside the replay bounds. Account for JSON
// array punctuation as well as event bytes to derive the most chunks the
// writer can legitimately produce. Validate this before constructing keys.
const MAX_CHECKPOINT_CHUNKS =
  LOG_LIMITS.replayBytes + LOG_LIMITS.replayEvents + 1 <= CHUNK_TARGET_BYTES
    ? 1
    : LOG_LIMITS.replayEvents
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

export interface LogUsage {
  events: number
  bytes: number
}

export function logSize(events: readonly StoredEvent[]): LogUsage {
  return {
    events: events.length,
    bytes: events.reduce((total, event) => total + eventBytes(event), 0),
  }
}

/**
 * The rows this object is really holding, read from storage rather than from
 * replay's folded view of them.
 *
 * A checkpoint that activated but could not finish deleting the rows its
 * retained predecessor covers leaves those rows out of every canonical
 * measure: loaded authority is the checkpoint plus the tail after it. They are
 * still persisted bytes, and they are what an admission bound has to count.
 */
export async function measureRawUsage(storage: LogStorage): Promise<LogUsage> {
  const rows = await storage.list<StoredEvent>({ prefix: EVENT_PREFIX })
  return logSize([...rows.values()])
}

export function rawLimitError(usage: LogUsage, limits = LOG_LIMITS): ReplayLimitError | undefined {
  if (usage.events <= limits.rawEvents && usage.bytes <= limits.rawBytes) return undefined
  return new ReplayLimitError(
    `The mock market's durable event rows are full (${usage.events}/${limits.rawEvents} rows, ${usage.bytes}/${limits.rawBytes} bytes of persisted event:v1 storage, whatever replay folds them into). No ledger mutation was accepted. Compaction must reclaim the rows an activated checkpoint already covers before this object accepts new authority; reads and the current market state are unaffected.`,
  )
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

/**
 * The identity of the ledger operation a `process` body asks for, if it is one.
 *
 * This is the canonical JSON identity of the complete signed envelope, not the
 * request's bytes. Whitespace and key order therefore cannot buy capacity, but
 * changing or omitting `work` or `signature` is not silently treated as the
 * accepted request. `MockLedger.process` returns a held body hash before it
 * validates those fields, so the Durable Object has to keep this stricter
 * boundary itself.
 *
 * Anything that is not a `process` carrying both signed-envelope fields returns
 * undefined: `faucet` pays out again on every call, and unsigned/arbitrary
 * bodies are left for validation or explicit conflict handling.
 */
export function processInputIdentity(body: string): string | undefined {
  let input: { action?: unknown; block?: unknown }
  try {
    input = JSON.parse(body) as { action?: unknown; block?: unknown }
  } catch {
    return undefined
  }
  if (input?.action !== 'process') return undefined
  if (!input.block || typeof input.block !== 'object' || Array.isArray(input.block)) return undefined

  const block = input.block as Record<string, unknown>
  if (typeof block.work !== 'string' || typeof block.signature !== 'string') return undefined
  try {
    return canonicalJson(block)
  } catch {
    return undefined
  }
}

/**
 * Consensus-body identity is used only to detect a conflicting replay of a
 * block the ledger already holds. It never grants idempotent success: that
 * requires `processInputIdentity()` to match the complete signed envelope.
 */
export function processBlockIdentity(body: string): string | undefined {
  let input: { action?: unknown; block?: unknown }
  try {
    input = JSON.parse(body) as { action?: unknown; block?: unknown }
  } catch {
    return undefined
  }
  if (input?.action !== 'process') return undefined
  if (!input.block || typeof input.block !== 'object' || Array.isArray(input.block)) return undefined

  const { work: _work, signature: _signature, ...blockBody } = input.block as Record<string, unknown>
  try {
    return hashBlock(blockBody as unknown as BlockBody)
  } catch {
    return undefined
  }
}

export async function loadLog(storage: LogStorage): Promise<LoadedLog> {
  const legacy = await storage.list<StoredEvent>({ prefix: EVENT_PREFIX })
  const legacyEvents = sortEvents([...legacy.values()])
  const storedPointers = await storage.get<unknown>(CHECKPOINT_POINTERS)
  if (storedPointers === undefined) return { events: legacyEvents, tailEvents: legacyEvents.length }
  const pointers = checkpointPointerEnvelope(storedPointers)
  if (!pointers) return recoverLegacyOrThrow(legacyEvents)

  const active = await readCheckpoint(storage, pointers.active)
  if (active) {
    const tail = legacyEvents.filter((event) => event.sequence > active.manifest.throughSequence)
    return {
      events: mergeEvents(active.events, tail),
      tailEvents: tail.length,
      checkpoint: active.manifest,
    }
  }

  if (pointers.previous !== undefined) {
    const previous = await readCheckpoint(storage, pointers.previous)
    if (previous) {
      const tail = legacyEvents.filter((event) => event.sequence > previous.manifest.throughSequence)
      return {
        events: mergeEvents(previous.events, tail),
        tailEvents: tail.length,
        checkpoint: previous.manifest,
        recoveredFrom: 'previous',
      }
    }
  }

  // First-generation compaction deliberately retains the complete legacy log,
  // which is the last safe fallback if both checkpoint pointers are unreadable.
  return recoverLegacyOrThrow(legacyEvents)
}

export async function writeCheckpoint(
  storage: LogStorage,
  events: readonly StoredEvent[],
  current: CheckpointManifest | undefined,
): Promise<CheckpointManifest> {
  const compacted = canonicalEvents(events)
  assertWithinReplayLimits(compacted)
  const registryAddress = seedAddress(compacted)
  const storedPointers = await storage.get<unknown>(CHECKPOINT_POINTERS)
  const oldPointers = checkpointPointerEnvelope(storedPointers)
  const knownGenerations = [current?.generation]
  const oldActive = checkpointManifest(oldPointers?.active)
  const oldPrevious = checkpointManifest(oldPointers?.previous)
  if (oldActive) knownGenerations.push(oldActive.generation)
  if (oldPrevious) knownGenerations.push(oldPrevious.generation)
  const priorGeneration = Math.max(...knownGenerations.map((generation) => generation ?? 0))
  if (priorGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new Error('The checkpoint generation counter is exhausted; preserve the Durable Object for migration.')
  }
  const generation = priorGeneration + 1
  const serialized = JSON.stringify(compacted)
  const digest = await sha256(serialized)
  const chunks = chunkEvents(compacted)
  // The checkpoint semantically covers every input through this sequence,
  // including redundant set/reply inputs removed by canonicalisation. Coverage
  // never goes backwards: a successor written from already-canonical history
  // still covers everything its predecessor did, which is what lets it
  // authorise deleting the v1 log that first generation deliberately kept.
  const throughSequence = Math.max(
    events.reduce((last, event) => Math.max(last, event.sequence), -1),
    current?.throughSequence ?? -1,
  )
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
  if (current) await removeCoveredRows(storage, current.throughSequence)
  await removeInactiveCheckpoints(storage, new Set([manifest.generation, current?.generation]))
  return manifest
}

export type ReclaimOutcome =
  /** Cleanup is complete: nothing an activated pointer covers is still stored. */
  | 'reclaimed'
  /** No v2 pointer yet, so no row is covered by anything. */
  | 'no-checkpoint'
  /** One generation only; it deliberately retains the complete v1 log. */
  | 'no-predecessor'
  /** The retained predecessor no longer verifies, so its rows stay. */
  | 'unverified-predecessor'

/**
 * Finish the cleanup an already-activated checkpoint authorises.
 *
 * Deleting the rows the retained predecessor covers is step 5 of the compaction
 * sequence and nothing else, so repeating it after a crash or a failed delete
 * is safe and writes nothing: the same keys, the same authority, no new
 * generation. It is the difference between a transient cleanup failure and
 * permanent raw growth, because a checkpoint that activated and then failed to
 * clean up is indistinguishable from a healthy one at the next boot.
 *
 * It refuses to delete anything unless that predecessor still verifies. Rows it
 * covers are the second recovery path; the active generation is the first.
 * Reclaiming them against a predecessor that can no longer be read would leave
 * exactly one, which is the one thing compaction must never do.
 */
export async function reclaimCoveredRows(storage: LogStorage): Promise<ReclaimOutcome> {
  const storedPointers = await storage.get<unknown>(CHECKPOINT_POINTERS)
  if (storedPointers === undefined) return 'no-checkpoint'
  const pointers = checkpointPointerEnvelope(storedPointers)
  if (!pointers) return 'unverified-predecessor'
  const active = checkpointManifest(pointers.active)
  if (!active) return 'unverified-predecessor'
  if (pointers.previous === undefined) return 'no-predecessor'
  const previous = checkpointManifest(pointers.previous)
  if (
    !previous ||
    previous.generation >= active.generation ||
    previous.throughSequence > active.throughSequence
  ) {
    return 'unverified-predecessor'
  }
  if (!(await readCheckpoint(storage, previous))) return 'unverified-predecessor'
  await removeCoveredRows(storage, previous.throughSequence)
  await removeInactiveCheckpoints(
    storage,
    new Set([active.generation, previous.generation]),
  )
  return 'reclaimed'
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
  untrustedExpected: unknown,
): Promise<{ events: StoredEvent[]; manifest: CheckpointManifest } | undefined> {
  try {
    // Pointer metadata controls both a storage key and an allocation. Trust none
    // of it until every field has a finite, legitimate bound.
    const expected = checkpointManifest(untrustedExpected)
    if (!expected) return undefined
    const storedManifest = await storage.get<unknown>(manifestKey(expected.generation))
    const manifest = checkpointManifest(storedManifest)
    if (!manifest || !sameCheckpointManifest(manifest, expected)) return undefined
    const keys = Array.from({ length: manifest.chunkCount }, (_, index) => chunkKey(manifest.generation, index))
    const rows = await storage.get<StoredEvent[]>(keys)
    if (rows.size !== keys.length) return undefined
    const events: StoredEvent[] = []
    for (const key of keys) {
      const chunk = rows.get(key)
      if (!Array.isArray(chunk) || chunk.length < 1 || chunk.length > manifest.eventCount - events.length) {
        return undefined
      }
      events.push(...chunk)
    }
    if (events.length !== manifest.eventCount) return undefined
    if (logSize(events).bytes !== manifest.eventBytes) return undefined
    if (seedAddress(events) !== manifest.registryAddress) return undefined
    if ((await sha256(JSON.stringify(events))) !== manifest.digest) return undefined
    return { events: sortEvents(events), manifest }
  } catch {
    return undefined
  }
}

function checkpointPointerEnvelope(value: unknown): { active: unknown; previous?: unknown } | undefined {
  if (!isRecord(value) || value.version !== 2 || !Object.hasOwn(value, 'active')) return undefined
  return {
    active: value.active,
    ...(Object.hasOwn(value, 'previous') ? { previous: value.previous } : {}),
  }
}

function checkpointManifest(value: unknown): CheckpointManifest | undefined {
  if (!isRecord(value) || value.version !== 2) return undefined
  const fields = [
    'version',
    'generation',
    'throughSequence',
    'chunkCount',
    'eventCount',
    'eventBytes',
    'digest',
    'registryAddress',
    'createdAt',
  ] as const
  if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    return undefined
  }
  if (!safeInteger(value.generation, 1)) return undefined
  if (!safeInteger(value.throughSequence, 0)) return undefined
  if (!safeInteger(value.chunkCount, 1) || value.chunkCount > MAX_CHECKPOINT_CHUNKS) return undefined
  if (!safeInteger(value.eventCount, 1) || value.eventCount > LOG_LIMITS.replayEvents) return undefined
  if (!safeInteger(value.eventBytes, 1) || value.eventBytes > LOG_LIMITS.replayBytes) return undefined
  if (
    value.chunkCount > value.eventCount ||
    value.eventBytes < value.eventCount ||
    value.throughSequence < value.eventCount - 1
  ) {
    return undefined
  }
  if (typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest)) return undefined
  if (
    typeof value.registryAddress !== 'string' ||
    value.registryAddress.length < 1 ||
    value.registryAddress.length > 128
  ) {
    return undefined
  }
  if (!safeInteger(value.createdAt, 0)) return undefined
  return value as unknown as CheckpointManifest
}

function sameCheckpointManifest(left: CheckpointManifest, right: CheckpointManifest): boolean {
  return (
    left.version === right.version &&
    left.generation === right.generation &&
    left.throughSequence === right.throughSequence &&
    left.chunkCount === right.chunkCount &&
    left.eventCount === right.eventCount &&
    left.eventBytes === right.eventBytes &&
    left.digest === right.digest &&
    left.registryAddress === right.registryAddress &&
    left.createdAt === right.createdAt
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function recoverLegacyOrThrow(legacyEvents: StoredEvent[]): LoadedLog {
  if (legacyEvents.some((event) => event.kind === 'seed')) {
    return { events: legacyEvents, tailEvents: legacyEvents.length, recoveredFrom: 'legacy' }
  }
  throw new Error(
    'The active and previous mock checkpoints failed verification and no complete v1 seed log remains. Restore the named Durable Object with point-in-time recovery; do not reset it.',
  )
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

/**
 * Cleanup is verified the same way the new generation was: by reading storage
 * back. A delete that reports success and leaves the rows behind is a cleanup
 * failure, and saying so is what stops the next boot from treating the object
 * as reclaimed and writing another generation on top of the same rows.
 */
async function removeCoveredRows(storage: LogStorage, throughSequence: number): Promise<void> {
  const removable = await coveredRowKeys(storage, throughSequence)
  if (removable.length === 0) return
  await deleteKeys(storage, removable)
  const surviving = await coveredRowKeys(storage, throughSequence)
  if (surviving.length > 0) {
    throw new Error(
      `Cleanup left ${surviving.length} event:v1 rows that the retained checkpoint through sequence ${throughSequence} already covers.`,
    )
  }
}

async function coveredRowKeys(storage: LogStorage, throughSequence: number): Promise<string[]> {
  const rows = await storage.list<StoredEvent>({ prefix: EVENT_PREFIX })
  return [...rows.entries()]
    .filter(([, event]) => event.sequence <= throughSequence)
    .map(([key]) => key)
}

async function removeInactiveCheckpoints(storage: LogStorage, keep: Set<number | undefined>): Promise<void> {
  const removable = await inactiveCheckpointKeys(storage, keep)
  if (removable.length === 0) return
  await deleteKeys(storage, removable)
  const surviving = await inactiveCheckpointKeys(storage, keep)
  if (surviving.length > 0) {
    throw new Error(
      `Cleanup left ${surviving.length} rows of checkpoint generations that are neither active nor its retained predecessor.`,
    )
  }
}

async function inactiveCheckpointKeys(
  storage: LogStorage,
  keep: Set<number | undefined>,
): Promise<string[]> {
  const rows = await storage.list({ prefix: CHECKPOINT_PREFIX })
  return [...rows.keys()].filter((key) => {
    const generation = Number(key.slice(CHECKPOINT_PREFIX.length).split(':', 1)[0])
    return !keep.has(generation)
  })
}
