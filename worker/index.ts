/**
 * Carpet Markets, on Cloudflare, at keicoin.org/examples/carpet-markets.
 *
 * The mock ledger, registry index and signed threads live in one Durable Object.
 * A versioned event log in that object's storage is authoritative; the classes
 * in memory are disposable caches rebuilt by replay after eviction. This is
 * still one mock node, not a network, and every demo coin is worth nothing.
 */

import { DurableObject } from 'cloudflare:workers'
import { randomSeed, type KeiNode } from 'kei-transaction'

import { DEMO_REGISTRY_SEED, seedDemo } from '../server/demo.js'
import { openChain, type ChainSource } from '../server/network.js'
import { ListingError } from '../shared/listing.js'
import { NetworkRefused } from '../shared/network.js'
import { ReplyError } from '../shared/social.js'
import { RegistryError, startRegistry, type Registry } from '../server/registry.js'
import { Threads, type PostReply } from '../server/social.js'
import {
  LOG_LIMITS,
  NEXT_SEQUENCE,
  ReplayLimitError,
  canonicalEvents,
  eventBytes,
  eventKey,
  loadLog,
  logSize,
  measureRawUsage,
  processBlockIdentity,
  processInputIdentity,
  rawLimitError,
  readBoundedText,
  reclaimCoveredRows,
  replayLimitError,
  writeCheckpoint,
  type CheckpointManifest,
  type EventInput,
  type LoadedLog,
  type LogUsage,
  type StoredEvent,
} from './durable-log.js'

interface Env {
  ASSETS: Fetcher
  FLOOR: DurableObjectNamespace<Floor>
  /** Optional stable registry seed. Changing it requires resetting DO storage. */
  CARPET_SEED?: string
  /** `mock` (default) or `testnet`; `mainnet` is refused on boot. */
  CARPET_NETWORK?: string
  /** Node URL when `CARPET_NETWORK=testnet`. */
  CARPET_NODE?: string
  /** Two-release migration gate: `compat` first, then explicitly `compact`. */
  CARPET_LOG_MODE?: string
}
const MOUNT = '/examples/carpet-markets'

function apiPath(url: URL): string | null {
  const path = url.pathname.startsWith(MOUNT) ? url.pathname.slice(MOUNT.length) : url.pathname
  return path === '/rpc' || path.startsWith('/market/') ? path : null
}

export class Floor extends DurableObject<Env> {
  #booting: Promise<{ registry: Registry; chain: ChainSource }> | undefined
  #now = Date.now()
  #threads = new Threads(() => this.#now)
  readonly #stored: Promise<Awaited<ReturnType<typeof loadLog>>>
  readonly #mutations = new Queue()
  #history: StoredEvent[] = []
  #tailEvents = 0
  #checkpoint: CheckpointManifest | undefined
  #acceptedWindow: { at: number; bytes: number }[] = []
  #replaying = true
  #authorityBlocked: ReplayLimitError | undefined
  #compactionBlocked: ReplayLimitError | undefined
  #acceptanceBlocked: ReplayLimitError | undefined
  /** Persisted `event:v1:*` rows and bytes, measured from storage. */
  #rawUsage: LogUsage = { events: 0, bytes: 0 }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Storage initialization only: crypto, chain construction and replay remain
    // outside blockConcurrencyWhile so the gate never contains long work.
    this.#stored = ctx.blockConcurrencyWhile(async () => {
      return loadLog(ctx.storage)
    })
  }

  #ready(): Promise<{ registry: Registry; chain: ChainSource }> {
    this.#booting ??= (async () => {
      const logMode = this.env.CARPET_LOG_MODE ?? 'compat'
      if (logMode !== 'compat' && logMode !== 'compact') {
        throw new Error(
          `CARPET_LOG_MODE must be "compat" or "compact"; received ${JSON.stringify(logMode)}. No mock ledger traffic was accepted.`,
        )
      }
      const bootStarted = Date.now()
      const chain = await openChain({
        network: this.env.CARPET_NETWORK,
        node: this.env.CARPET_NODE,
        durable: true,
      })

      // Testnet is somebody else's persistent chain. It remains a pass-through;
      // local DO storage must not be presented as authority for remote state.
      if (chain.sdkNetwork !== 'mock') {
        const registry = await startRegistry({
          seed: this.env.CARPET_SEED ?? randomSeed(),
          node: chain.node,
          network: chain.sdkNetwork,
          chain: chain.facts,
          replyCount: (asset) => this.#threads.count(asset),
        })
        return { registry, chain }
      }

      const loaded = await this.#stored
      const stored = loaded.events
      this.#checkpoint = loaded.checkpoint
      this.#tailEvents = loaded.tailEvents
      const registrySeed = this.env.CARPET_SEED ?? DEMO_REGISTRY_SEED
      const registry = await startRegistry({
        seed: registrySeed,
        node: chain.node,
        network: chain.sdkNetwork,
        chain: chain.facts,
        replyCount: (asset) => this.#threads.count(asset),
        now: () => this.#now,
      })
      const state = { registry, chain }

      const seedEvent = stored.find(
        (event): event is StoredEvent & { kind: 'seed'; registryAddress: string } => event.kind === 'seed',
      )
      if (stored.length > 0 && !seedEvent) {
        registry.close()
        throw new Error('The stored mock event log has no seed record. Reset the named carpet-markets Durable Object storage.')
      }
      if (seedEvent && seedEvent.registryAddress !== registry.address) {
        registry.close()
        throw new Error(
          'CARPET_SEED does not match this mock market\'s stored public registry identity. Restore the prior setting or reset the named carpet-markets Durable Object storage before changing it.',
        )
      }

      if (stored.length === 0) {
        const seeded = await this.#append({ kind: 'seed', registryAddress: registry.address, at: Date.now() })
        if ('refusal' in seeded) throw seeded.refusal
        try {
          await this.#apply(seeded.event, state)
          await this.#accept(seeded.event)
        } catch (error) {
          await this.ctx.storage.delete(seeded.key)
          registry.close()
          throw error
        }
      } else {
        try {
          for (const event of stored) {
            try {
              const response = await this.#apply(event, state)
              if (response instanceof Response) {
                const failure = await responseFailure(response)
                if (failure) {
                  if (event.status === 'pending') {
                    await this.ctx.storage.delete(eventKey(event.sequence))
                    continue
                  }
                  throw new Error(`Persisted ${event.kind} event ${event.sequence} failed replay: ${failure}`)
                }
              }
              if (event.status === 'pending') await this.#accept(event)
              else this.#history.push(event)
            } catch (error) {
              if (event.status === 'pending' && expectedRejection(error)) {
                await this.ctx.storage.delete(eventKey(event.sequence))
                continue
              }
              throw error
            }
          }
        } catch (error) {
          registry.close()
          throw error
        }
      }

      this.#now = Date.now()
      this.#tailEvents = this.#checkpoint
        ? this.#history.filter((event) => event.sequence > this.#checkpoint!.throughSequence).length
        : this.#history.length
      this.#authorityBlocked = replayLimitError(canonicalEvents(this.#history))
      this.#rawUsage = await measureRawUsage(this.ctx.storage)
      this.#replaying = false
      const replayMs = Date.now() - bootStarted
      this.#observe('replay', {
        replayMs,
        checkpointGeneration: this.#checkpoint?.generation ?? null,
        recoveredFrom: loaded.recoveredFrom ?? null,
        mode: this.env.CARPET_LOG_MODE ?? 'compat',
        admissionBlocked: this.#authorityBlocked?.message ?? null,
        ...this.#measure(),
      })
      // Cleanup is the one compaction step that can fail after its pointer is
      // already authoritative, and the next boot cannot tell that object from a
      // healthy one. Finishing it here, before anything is admitted, is what
      // makes a transient failure transient. It writes nothing.
      await this.#reclaimCovered(loaded)
      // The explicit phase-2 configuration can migrate an oversized raw v1 log
      // whose canonical accepted authority is still inside the measured bound.
      // Compatibility mode never reaches this write/delete path.
      await this.#compactAndReclaim()
      return state
    })()
    return this.#booting
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = apiPath(url)
    if (!path) return new Response('Not found', { status: 404 })

    let registry: Registry
    let chain: ChainSource
    try {
      ;({ registry, chain } = await this.#ready())
    } catch (error) {
      this.#booting = undefined
      // A failed replay may have populated part of an in-memory thread cache.
      // The durable log remains authoritative, so a retry starts that cache over.
      this.#threads = new Threads(() => this.#now)
      this.#history = []
      this.#replaying = true
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: message }, error instanceof NetworkRefused ? 503 : 500)
    }

    if (path === '/rpc') {
      if (chain.sdkNetwork !== 'mock') return chain.rpc(request)
      let body: string
      try {
        body = await readBoundedText(request)
      } catch (error) {
        if (error instanceof ReplayLimitError) return json({ error: error.message }, error.status)
        throw error
      }
      let action: unknown
      try {
        action = (JSON.parse(body) as { action?: unknown }).action
      } catch {
        return chain.rpc(rebuiltRequest(request, body))
      }
      if (action !== 'process' && action !== 'faucet') return chain.rpc(rebuiltRequest(request, body))
      try {
        return await this.#mutate({ kind: 'rpc', body, at: Date.now() }, { registry, chain })
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          error instanceof ReplayLimitError ? error.status : 500,
        )
      }
    }

    try {
      switch (path) {
        case '/market/facts':
          return json(await registry.facts())
        case '/market/book':
          return json(await registry.book(url.searchParams.get('asset') ?? ''))
        case '/market/holders':
          return json({ holders: await registry.holders(url.searchParams.get('asset') ?? '') })
        case '/market/activity': {
          const asked = Number(url.searchParams.get('limit') ?? 24)
          return json({ trades: await registry.activity(Number.isFinite(asked) ? asked : 24) })
        }
        case '/market/replies':
          return json({ replies: this.#threads.list(url.searchParams.get('asset') ?? '') })
        case '/market/reply': {
          const body = await read<PostReply>(request)
          if (!registry.listing(body.asset)) throw new ListingError('That coin is not listed here.')
          if (chain.sdkNetwork !== 'mock') return json(await this.#threads.add(body))
          return this.#mutate({ kind: 'reply', body, at: Date.now() }, { registry, chain })
        }
        case '/market/launch': {
          const body = await read<{ address: string } & Record<string, unknown>>(request)
          if (chain.sdkNetwork !== 'mock') return json(await registry.quoteLaunch(body.address, body))
          return this.#mutate({ kind: 'launch', body, at: Date.now() }, { registry, chain })
        }
        case '/market/watch': {
          const { address } = await read<{ address: string }>(request)
          if (chain.sdkNetwork !== 'mock') {
            registry.watch(address)
            return json({ watching: true })
          }
          return this.#mutate({ kind: 'watch', address, at: Date.now() }, { registry, chain })
        }
        default:
          return new Response('Not found', { status: 404 })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const theirs = error instanceof ListingError || error instanceof RegistryError || error instanceof ReplyError
      return json({ error: message }, error instanceof ReplayLimitError ? error.status : theirs ? 400 : 500)
    }
  }

  async #append(
    input: EventInput,
  ): Promise<{ key: string; event: StoredEvent } | { refusal: ReplayLimitError }> {
    // Admission happens outside storage.transaction(). Workerd treats an error
    // escaping a transaction callback as an aborted storage turn even when the
    // caller later catches it. The mutation queue makes this projection stable,
    // and the real sequence changes the serialized size by only bounded digits.
    const projected = {
      version: 1 as const,
      sequence: Number.MAX_SAFE_INTEGER,
      status: 'accepted' as const,
      ...input,
    } as StoredEvent
    if (this.env.CARPET_LOG_MODE === 'compact') {
      const refusal = replayLimitError(canonicalEvents([...this.#history, projected]))
      if (refusal) return { refusal }
      // Then what this object is really holding. Replay folds duplicates and
      // drops every row an activated checkpoint covers, so canonical history
      // cannot see the rows a failed cleanup left behind. Storage can, and it
      // is the only measure that survives eviction with them.
      this.#rawUsage = await measureRawUsage(this.ctx.storage)
      const rawRefusal = rawLimitError({
        events: this.#rawUsage.events + 1,
        bytes: this.#rawUsage.bytes + eventBytes(projected),
      })
      if (rawRefusal) return { refusal: rawRefusal }
    }
    const stored = await this.ctx.storage.transaction(async (storage) => {
      const sequence = (await storage.get<number>(NEXT_SEQUENCE)) ?? 0
      const event = { version: 1 as const, sequence, status: 'pending' as const, ...input } as StoredEvent
      const key = eventKey(sequence)
      // Failed events are deleted but this counter is not rewound. Gaps retain
      // the order of later accepted inputs and are intentionally harmless.
      await storage.put({ [key]: event, [NEXT_SEQUENCE]: sequence + 1 })
      return { key, event }
    })
    this.#rawUsage = {
      events: this.#rawUsage.events + 1,
      bytes: this.#rawUsage.bytes + eventBytes(stored.event),
    }
    return stored
  }

  async #accept(event: StoredEvent): Promise<void> {
    const accepted = { ...event, status: 'accepted' as const }
    await this.ctx.storage.put(eventKey(event.sequence), accepted)
    this.#history.push(accepted)
    this.#authorityBlocked = replayLimitError(canonicalEvents(this.#history))
    this.#tailEvents += 1
    // The row was counted when it was written; accepting it only rewrites the
    // status in place. Replay re-measures from storage, so its accounting here
    // is discarded rather than doubled.
    this.#rawUsage = {
      events: this.#rawUsage.events,
      bytes: this.#rawUsage.bytes + eventBytes(accepted) - eventBytes(event),
    }
    const bytes = eventBytes(accepted)
    const now = Date.now()
    this.#acceptedWindow.push({ at: now, bytes })
    this.#acceptedWindow = this.#acceptedWindow.filter((entry) => now - entry.at < 60_000)
    this.#observe('accepted', {
      kind: accepted.kind,
      acceptedBytes: bytes,
      acceptedBytesLastMinute: this.#acceptedWindow.reduce((total, entry) => total + entry.bytes, 0),
      storageOperations: 2,
      storageKeyWrites: 3,
      // Compact-mode admission reads the persisted v1 prefix once before it
      // allocates anything, so raw pressure is storage's answer, not memory's.
      admissionListReads: this.env.CARPET_LOG_MODE === 'compact' ? 1 : 0,
      ...this.#measure(),
    })
    if (!this.#replaying) await this.#compactAndReclaim()
  }

  /**
   * Compact, then the single further pass a first generation can need.
   *
   * The first generation deliberately retains the complete v1 log, so only its
   * verified successor authorises deleting those rows: an oversized legacy log
   * reclaims on the second generation, never the first. A refused or failed
   * compaction returns false and stops there — this is one extra pass, not a
   * retry, and never a loop.
   */
  async #compactAndReclaim(): Promise<void> {
    if (!(await this.#compactIfNeeded())) return
    if (this.#rawPressure()) await this.#compactIfNeeded()
  }

  /**
   * Whether the persisted v1 rows still leave room for another accepted row.
   *
   * Measured with one maximum-size input of headroom, so compaction reclaims
   * before the raw bound has to refuse anything an operator would call
   * ordinary. Compaction is what reclaims; the bound is what holds when it
   * cannot.
   */
  #rawPressure(): boolean {
    return (
      rawLimitError({
        events: this.#rawUsage.events + 1,
        bytes: this.#rawUsage.bytes + LOG_LIMITS.requestBytes,
      }) !== undefined
    )
  }

  async #compactIfNeeded(): Promise<boolean> {
    if (this.env.CARPET_LOG_MODE !== 'compact' || this.#compactionBlocked) return false
    if (this.#tailEvents < LOG_LIMITS.compactAfter && !this.#rawPressure()) return false
    if (this.#authorityBlocked) {
      this.#observe('activation-refused', { error: this.#authorityBlocked.message, ...this.#measure() })
      return false
    }
    const before = this.#measure()
    const started = Date.now()
    try {
      this.#checkpoint = await writeCheckpoint(this.ctx.storage, this.#history, this.#checkpoint)
      this.#history = canonicalEvents(this.#history)
      this.#tailEvents = 0
      this.#rawUsage = await measureRawUsage(this.ctx.storage)
      this.#authorityBlocked = undefined
      this.#observe('compaction', {
        ok: true,
        compactionMs: Date.now() - started,
        generation: this.#checkpoint.generation,
        before,
        after: this.#measure(),
      })
      return true
    } catch (error) {
      try {
        this.#rawUsage = await measureRawUsage(this.ctx.storage)
      } catch {
        // Preserve the last known conservative value; the failure record below
        // still says compaction did not complete and admission stays closed.
      }
      this.#compactionBlocked = new ReplayLimitError(
        `The mock market could not compact its durable replay tail: ${
          error instanceof Error ? error.message : String(error)
        }. No further ledger mutation was accepted; preserve the named Durable Object and repair compaction before retrying.`,
      )
      this.#observe('compaction', {
        ok: false,
        compactionMs: Date.now() - started,
        before,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  /**
   * Retry the cleanup an already-activated checkpoint authorises, once, at boot.
   *
   * Only when this boot replayed from the active generation itself: if it fell
   * back to the predecessor or to the legacy log, those v1 rows are the
   * authority being read and nothing may delete them. A failure fails closed
   * rather than growing, and no new generation is written on top of rows the
   * object has just proved it cannot remove.
   */
  async #reclaimCovered(loaded: LoadedLog): Promise<void> {
    if (this.env.CARPET_LOG_MODE !== 'compact') return
    if (!loaded.checkpoint || loaded.recoveredFrom) return
    const started = Date.now()
    try {
      const outcome = await reclaimCoveredRows(this.ctx.storage)
      this.#rawUsage = await measureRawUsage(this.ctx.storage)
      this.#observe('reclaim', {
        ok: true,
        outcome,
        reclaimMs: Date.now() - started,
        ...this.#measure(),
      })
    } catch (error) {
      try {
        this.#rawUsage = await measureRawUsage(this.ctx.storage)
      } catch {
        // Preserve the last known value while the durable failure stays latched.
      }
      this.#compactionBlocked = new ReplayLimitError(
        `The mock market could not reclaim the durable rows its active checkpoint already covers: ${
          error instanceof Error ? error.message : String(error)
        }. No further ledger mutation was accepted; preserve the named Durable Object and repair storage cleanup before retrying.`,
      )
      this.#observe('reclaim', {
        ok: false,
        reclaimMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
        ...this.#measure(),
      })
    }
  }

  #measure(): Record<string, unknown> {
    const authority = canonicalEvents(this.#history)
    const size = logSize(authority)
    const byKind: Record<string, { events: number; bytes: number }> = {}
    for (const event of authority) {
      const current = byKind[event.kind] ?? { events: 0, bytes: 0 }
      current.events += 1
      current.bytes += eventBytes(event)
      byKind[event.kind] = current
    }
    return {
      events: size.events,
      bytes: size.bytes,
      // Persisted `event:v1:*`, measured from storage rather than inferred from
      // replay. In-memory history is the checkpoint plus its tail, so it cannot
      // describe migration cost or the rows a failed cleanup is still holding.
      rawEvents: this.#rawUsage.events,
      rawBytes: this.#rawUsage.bytes,
      tailEvents: this.#tailEvents,
      limits: LOG_LIMITS,
      byKind,
    }
  }

  /** A rejected mutation's WAL row is deleted, so it stops counting as stored. */
  #discardRaw(event: StoredEvent): void {
    this.#rawUsage = {
      events: this.#rawUsage.events - 1,
      bytes: this.#rawUsage.bytes - eventBytes(event),
    }
  }

  #observe(action: string, fields: Record<string, unknown>): void {
    console.log(JSON.stringify({ service: 'carpet-markets', component: 'durable-log', action, ...fields }))
  }

  async #mutate(
    input: EventInput,
    state: { registry: Registry; chain: ChainSource },
  ): Promise<Response> {
    return this.#mutations.run(async () => {
      const process = acceptedProcessMatch(input, this.#history)
      if (process?.kind === 'retry') {
        const retry = process.event
        try {
          const response = await this.#apply(retry, state)
          this.#observe('idempotent-retry', {
            sequence: retry.sequence,
            ...this.#measure(),
          })
          return response instanceof Response ? response : json(response)
        } finally {
          this.#now = Date.now()
        }
      }
      if (process?.kind === 'conflict') {
        return json(
          {
            error:
              'That block body is already accepted, but this work/signature envelope differs from the accepted request. Resend the same complete signed block; no durable mutation was written.',
          },
          409,
        )
      }
      if (this.env.CARPET_LOG_MODE === 'compact') {
        const blocked = this.#compactionBlocked ?? this.#authorityBlocked
        if (blocked) return json({ error: blocked.message }, blocked.status)
      }
      // Application precedes the pending -> accepted storage rewrite. If that
      // rewrite failed, this live instance has already applied authority that a
      // same-instance retry could apply twice. Reads and exact accepted process
      // retries remain safe, but all new mutations wait for cold replay to
      // reconcile the retained pending row.
      if (this.#acceptanceBlocked) {
        return json({ error: this.#acceptanceBlocked.message }, this.#acceptanceBlocked.status)
      }
      // Write-ahead is what makes a crash between receipt and application safe.
      // Failed mock blocks are atomic in MockLedger; quote/reply validation runs
      // before their cache writes. Those failures can therefore remove their
      // event without leaving accepted state that a cold replay would omit.
      const stored = await this.#append(input)
      if ('refusal' in stored) return json({ error: stored.refusal.message }, stored.refusal.status)
      try {
        let response: Response | unknown
        try {
          response = await this.#apply(stored.event, state)
        } catch (error) {
          // Every application exception is raised before the corresponding mock
          // ledger/thread mutation commits. Only that proven-atomic failure may
          // remove its WAL row.
          await this.ctx.storage.delete(stored.key)
          this.#discardRaw(stored.event)
          throw error
        }
        if (response instanceof Response && (await responseFailure(response))) {
          // MockLedger returns its rejected response atomically, before mutation.
          await this.ctx.storage.delete(stored.key)
          this.#discardRaw(stored.event)
          return response
        }
        try {
          await this.#accept(stored.event)
        } catch (error) {
          // Application succeeded. The pending WAL is now the sole durable path
          // that lets a fresh instance reproduce and accept this mutation once.
          // Never delete it, and never let this already-mutated instance apply a
          // retry or any later mutation on top of unresolved authority.
          this.#acceptanceBlocked = new ReplayLimitError(
            `The mock market applied a mutation but could not mark its durable WAL row accepted: ${
              error instanceof Error ? error.message : String(error)
            }. The pending row was preserved; retry after a cold restart can recover it exactly once.`,
            503,
          )
          return json({ error: this.#acceptanceBlocked.message }, this.#acceptanceBlocked.status)
        }
        return response instanceof Response ? response : json(response)
      } finally {
        this.#now = Date.now()
      }
    })
  }

  async #apply(
    event: StoredEvent,
    state: { registry: Registry; chain: ChainSource },
  ): Promise<Response | unknown> {
    this.#now = event.at
    switch (event.kind) {
      case 'seed':
        await seedDemo({
          node: state.chain.node as KeiNode,
          registry: state.registry,
          threads: this.#threads,
          now: event.at,
        })
        return { seeded: true }
      case 'rpc': {
        const response = await state.chain.rpc(
          new Request('https://durable.invalid/rpc', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: event.body,
          }),
        )
        if (!(await responseFailure(response))) await state.registry.flush()
        return response
      }
      case 'launch':
        return state.registry.quoteLaunch(event.body.address, event.body)
      case 'watch':
        state.registry.watch(event.address)
        return { watching: true }
      case 'reply':
        if (!state.registry.listing(event.body.asset)) throw new ListingError('That coin is not listed here.')
        return this.#threads.add(event.body)
    }
  }
}

class Queue {
  #tail: Promise<unknown> = Promise.resolve()

  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(job, job)
    this.#tail = next.catch(() => undefined)
    return next
  }
}

function acceptedProcessMatch(
  input: EventInput,
  history: readonly StoredEvent[],
): { kind: 'retry'; event: StoredEvent } | { kind: 'conflict' } | undefined {
  if (input.kind !== 'rpc') return undefined
  const blockIdentity = processBlockIdentity(input.body)
  if (blockIdentity === undefined) return undefined
  const envelopeIdentity = processInputIdentity(input.body)
  let conflict = false
  for (const event of history) {
    if (event.status !== 'accepted' || event.kind !== 'rpc') continue
    if (processBlockIdentity(event.body) !== blockIdentity) continue
    if (
      envelopeIdentity !== undefined &&
      processInputIdentity(event.body) === envelopeIdentity
    ) {
      return { kind: 'retry', event }
    }
    conflict = true
  }
  return conflict ? { kind: 'conflict' } : undefined
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (apiPath(url)) {
      const floor = env.FLOOR.get(env.FLOOR.idFromName('carpet-markets'))
      return floor.fetch(request)
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

async function responseFailure(response: Response): Promise<string | undefined> {
  if (!response.ok) return (await response.clone().text()) || `HTTP ${response.status}`
  try {
    const body = (await response.clone().json()) as { error?: unknown }
    return typeof body?.error === 'string' ? body.error : undefined
  } catch {
    return undefined
  }
}

function expectedRejection(error: unknown): boolean {
  return error instanceof ListingError || error instanceof RegistryError || error instanceof ReplyError
}

async function read<T>(request: Request): Promise<T> {
  try {
    return JSON.parse(await readBoundedText(request)) as T
  } catch (error) {
    if (error instanceof ReplayLimitError) throw error
    throw new ListingError('That request was not JSON.')
  }
}

function rebuiltRequest(request: Request, body: string): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body }),
  })
}
