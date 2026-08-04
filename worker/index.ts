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
  readBoundedText,
  replayLimitError,
  writeCheckpoint,
  type CheckpointManifest,
  type EventInput,
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
      // The explicit phase-2 configuration can migrate an oversized raw v1 log
      // whose canonical accepted authority is still inside the measured bound.
      // Compatibility mode never reaches this write/delete path.
      await this.#compactIfNeeded()
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
    }
    return this.ctx.storage.transaction(async (storage) => {
      const sequence = (await storage.get<number>(NEXT_SEQUENCE)) ?? 0
      const event = { version: 1 as const, sequence, status: 'pending' as const, ...input } as StoredEvent
      const key = eventKey(sequence)
      // Failed events are deleted but this counter is not rewound. Gaps retain
      // the order of later accepted inputs and are intentionally harmless.
      await storage.put({ [key]: event, [NEXT_SEQUENCE]: sequence + 1 })
      return { key, event }
    })
  }

  async #accept(event: StoredEvent): Promise<void> {
    const accepted = { ...event, status: 'accepted' as const }
    await this.ctx.storage.put(eventKey(event.sequence), accepted)
    this.#history.push(accepted)
    this.#authorityBlocked = replayLimitError(canonicalEvents(this.#history))
    this.#tailEvents += 1
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
      ...this.#measure(),
    })
    if (!this.#replaying) await this.#compactIfNeeded()
  }

  async #compactIfNeeded(): Promise<void> {
    if (this.env.CARPET_LOG_MODE !== 'compact' || this.#tailEvents < LOG_LIMITS.compactAfter) return
    if (this.#authorityBlocked) {
      this.#observe('activation-refused', { error: this.#authorityBlocked.message, ...this.#measure() })
      return
    }
    const before = this.#measure()
    const started = Date.now()
    try {
      this.#checkpoint = await writeCheckpoint(this.ctx.storage, this.#history, this.#checkpoint)
      this.#history = canonicalEvents(this.#history)
      this.#tailEvents = 0
      this.#authorityBlocked = undefined
      this.#observe('compaction', {
        ok: true,
        compactionMs: Date.now() - started,
        generation: this.#checkpoint.generation,
        before,
        after: this.#measure(),
      })
    } catch (error) {
      this.#observe('compaction', {
        ok: false,
        compactionMs: Date.now() - started,
        before,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  #measure(): Record<string, unknown> {
    const authority = canonicalEvents(this.#history)
    const size = logSize(authority)
    const raw = logSize(this.#history)
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
      rawEvents: raw.events,
      rawBytes: raw.bytes,
      tailEvents: this.#tailEvents,
      limits: LOG_LIMITS,
      byKind,
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
      if (this.env.CARPET_LOG_MODE === 'compact' && this.#authorityBlocked) {
        return json({ error: this.#authorityBlocked.message }, this.#authorityBlocked.status)
      }
      // Write-ahead is what makes a crash between receipt and application safe.
      // Failed mock blocks are atomic in MockLedger; quote/reply validation runs
      // before their cache writes. Those failures can therefore remove their
      // event without leaving accepted state that a cold replay would omit.
      const stored = await this.#append(input)
      if ('refusal' in stored) return json({ error: stored.refusal.message }, stored.refusal.status)
      try {
        const response = await this.#apply(stored.event, state)
        if (response instanceof Response && (await responseFailure(response))) {
          await this.ctx.storage.delete(stored.key)
        } else {
          await this.#accept(stored.event)
        }
        return response instanceof Response ? response : json(response)
      } catch (error) {
        await this.ctx.storage.delete(stored.key)
        throw error
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
