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

interface Env {
  ASSETS: Fetcher
  FLOOR: DurableObjectNamespace<Floor>
  /** Optional stable registry seed. Changing it requires resetting DO storage. */
  CARPET_SEED?: string
  /** `mock` (default) or `testnet`; `mainnet` is refused on boot. */
  CARPET_NETWORK?: string
  /** Node URL when `CARPET_NETWORK=testnet`. */
  CARPET_NODE?: string
}

type EventInput =
  | { at: number; kind: 'seed'; registryAddress: string }
  | { at: number; kind: 'rpc'; body: string }
  | { at: number; kind: 'launch'; body: { address: string } & Record<string, unknown> }
  | { at: number; kind: 'watch'; address: string }
  | { at: number; kind: 'reply'; body: PostReply }

type StoredEvent = EventInput & { version: 1; sequence: number; status: 'pending' | 'accepted' }

const EVENT_PREFIX = 'event:v1:'
const NEXT_SEQUENCE = 'meta:event-sequence:v1'
const MOUNT = '/examples/carpet-markets'

function eventKey(sequence: number): string {
  return `${EVENT_PREFIX}${sequence.toString().padStart(12, '0')}`
}

function apiPath(url: URL): string | null {
  const path = url.pathname.startsWith(MOUNT) ? url.pathname.slice(MOUNT.length) : url.pathname
  return path === '/rpc' || path.startsWith('/market/') ? path : null
}

export class Floor extends DurableObject<Env> {
  #booting: Promise<{ registry: Registry; chain: ChainSource }> | undefined
  #now = Date.now()
  #threads = new Threads(() => this.#now)
  readonly #stored: Promise<StoredEvent[]>
  readonly #mutations = new Queue()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Storage initialization only: crypto, chain construction and replay remain
    // outside blockConcurrencyWhile so the gate never contains long work.
    this.#stored = ctx.blockConcurrencyWhile(async () => {
      const rows = await ctx.storage.list<StoredEvent>({ prefix: EVENT_PREFIX })
      return [...rows.values()].sort((a, b) => a.sequence - b.sequence)
    })
  }

  #ready(): Promise<{ registry: Registry; chain: ChainSource }> {
    this.#booting ??= (async () => {
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

      const stored = await this.#stored
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
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: message }, error instanceof NetworkRefused ? 503 : 500)
    }

    if (path === '/rpc') {
      if (chain.sdkNetwork !== 'mock') return chain.rpc(request)
      const body = await request.clone().text()
      let action: unknown
      try {
        action = (JSON.parse(body) as { action?: unknown }).action
      } catch {
        return chain.rpc(request)
      }
      if (action !== 'process' && action !== 'faucet') return chain.rpc(request)
      try {
        return await this.#mutate({ kind: 'rpc', body, at: Date.now() }, { registry, chain })
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500)
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
      return json({ error: message }, theirs ? 400 : 500)
    }
  }

  async #append(input: EventInput): Promise<{ key: string; event: StoredEvent }> {
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
    await this.ctx.storage.put(eventKey(event.sequence), { ...event, status: 'accepted' })
  }

  async #mutate(
    input: EventInput,
    state: { registry: Registry; chain: ChainSource },
  ): Promise<Response> {
    return this.#mutations.run(async () => {
      // Write-ahead is what makes a crash between receipt and application safe.
      // Failed mock blocks are atomic in MockLedger; quote/reply validation runs
      // before their cache writes. Those failures can therefore remove their
      // event without leaving accepted state that a cold replay would omit.
      const stored = await this.#append(input)
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
    return (await request.json()) as T
  } catch {
    throw new ListingError('That request was not JSON.')
  }
}
