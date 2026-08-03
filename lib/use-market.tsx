'use client'

/**
 * Where React finds out that a chain exists.
 *
 * One provider owns the wallet, because there is one wallet per browser. It
 * polls the things that are cheap and global — this account's Kei, what it
 * holds, what it has listed, which coins exist — and hands them down. Anything
 * that costs a read per coin is not in here; `useCoin` fetches that for the one
 * coin being looked at, which is the same restraint the pre-React version had
 * and for the same reason. Polling every book on the board every two seconds
 * would make this page the busiest client on the network for no benefit.
 *
 * The wallet is created in an effect, never during render. A static export
 * prerenders these components at build time in Node, where there is no browser
 * storage to hold a seed and no node to talk to, so a wallet built during render
 * would break the build rather than the page.
 *
 * Balances arrive as three separate numbers and stay separate — see
 * `lib/balance.ts`. The one that decides whether a button works is `spendable`,
 * always, because it is the only one the ledger will agree with.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Offer } from 'kei-transaction'

import type { Book, Holder, Listing, MarketFacts } from '../shared/listing'
import type { Reply } from '../shared/social'
import { NO_FUNDS, type Funds, type InFlight } from './balance'
import { connect, explain, type Trader } from './market'

const POLL_MS = 2_000

export interface Note {
  text: string
  /** `busy` stays up until it is replaced; the other two time out. */
  tone: 'ok' | 'bad' | 'busy'
}

/** What an action is expected to do, shown before the chain confirms it did. */
export interface Effect {
  /** Signed raw Kei. Negative for a spend. */
  kei?: bigint
  /** Signed whole units, by asset. */
  coins?: Iterable<readonly [string, number]>
}

interface MarketState {
  trader: Trader | null
  /** Set only if the wallet could not be opened at all. */
  fatal: string | null
  facts: MarketFacts | null
  /** Null until the first read comes back, which is how loading is told from empty. */
  loading: boolean
  funds: Funds
  holdings: Map<string, number>
  mine: Offer[]
  busy: boolean
  note: Note | null
  say(text: string, tone: Note['tone']): void
  dismiss(): void
  /** Run one signed action, keeping the page honest about what is happening. */
  act(what: string, job: () => Promise<void>, effect?: Effect): Promise<void>
  refresh(): Promise<void>
}

interface Chain {
  confirmed: bigint
  incoming: bigint
  arrivals: number
}

const NO_CHAIN: Chain = { confirmed: 0n, incoming: 0n, arrivals: 0 }

const Ctx = createContext<MarketState | null>(null)

export function MarketProvider({ children }: { children: ReactNode }) {
  const [trader, setTrader] = useState<Trader | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [facts, setFacts] = useState<MarketFacts | null>(null)
  const [loading, setLoading] = useState(true)
  const [chain, setChain] = useState<Chain>(NO_CHAIN)
  const [inFlight, setInFlight] = useState<InFlight[]>([])
  const [holdings, setHoldings] = useState<Map<string, number>>(new Map())
  const [mine, setMine] = useState<Offer[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note | null>(null)

  // Read inside the interval so the poll always sees the current wallet without
  // the interval being torn down and rebuilt every time one of these changes.
  const traderRef = useRef<Trader | null>(null)
  traderRef.current = trader

  // `busy` guards re-entry, and it is a ref as well as state so that guarding
  // does not put `act` in a new identity on every keystroke elsewhere.
  const busyRef = useRef(false)
  const ticket = useRef(0)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const opened = await connect()
        if (live) setTrader(opened)
      } catch (error) {
        if (live) {
          setFatal(explain(error))
          setLoading(false)
        }
      }
    })()
    return () => {
      live = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const active = traderRef.current
    if (!active) return
    try {
      const next = await active.facts()
      setFacts(next)

      // Before reading balances, not after. Coins bought through a settlement
      // are a receivable until this wallet signs for them (SPEC §5.6.3), and
      // reading first shows a holder nothing, correctly, about the wrong moment.
      await active.sync()

      // And `incoming` after the sync, not before: anything read before it has
      // just been claimed by it, and would be counted once as confirmed and
      // again as on its way. What is left here is genuinely still owed.
      const [confirmed, waiting, held, open] = await Promise.all([
        active.keiBalance(),
        active.incoming(),
        active.holdings(next.listings.map((listing) => listing.asset)),
        active.mine(),
      ])
      setChain({ confirmed, incoming: waiting.kei, arrivals: waiting.arrivals })
      setHoldings(held)
      setMine(open)
    } catch (error) {
      setNote({ text: explain(error), tone: 'bad' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!trader) return
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [trader, refresh])

  const say = useCallback((text: string, tone: Note['tone']) => setNote({ text, tone }), [])
  const dismiss = useCallback(() => setNote(null), [])

  /**
   * One signed action, with what it is expected to do carried alongside it.
   *
   * The expectation goes up on screen immediately and comes down only once the
   * poll that follows the action has returned — so the balance never flickers
   * back to its old value in the gap, and never counts the change twice once
   * the chain reports it. While it is up it is a debt, never a credit: money
   * arriving does not fund the next spend until it has arrived.
   */
  const act = useCallback(
    async (what: string, job: () => Promise<void>, effect?: Effect) => {
      if (busyRef.current) return
      busyRef.current = true
      setBusy(true)
      setNote({ text: `${what}…`, tone: 'busy' })

      const id = ++ticket.current
      if (effect) {
        setInFlight((list) => [
          ...list,
          { id, what, kei: effect.kei ?? 0n, coins: new Map(effect.coins ?? []) },
        ])
      }

      try {
        await job()
        setNote({ text: `${what} — done.`, tone: 'ok' })
      } catch (error) {
        setNote({ text: explain(error), tone: 'bad' })
      } finally {
        // Keep the wallet locked until reconciliation finishes. Releasing it
        // before this read lets a second signature race the refresh and makes
        // both actions reason from the same pre-settlement snapshot.
        try {
          await refresh()
        } finally {
          setInFlight((list) => list.filter((change) => change.id !== id))
          busyRef.current = false
          setBusy(false)
        }
      }
    },
    [refresh],
  )

  const funds = useMemo<Funds>(() => ({ ...chain, inFlight }), [chain, inFlight])

  const value = useMemo<MarketState>(
    () => ({ trader, fatal, facts, loading, funds, holdings, mine, busy, note, say, dismiss, act, refresh }),
    [trader, fatal, facts, loading, funds, holdings, mine, busy, note, say, dismiss, act, refresh],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useMarket(): MarketState {
  const value = useContext(Ctx)
  if (!value) throw new Error('useMarket was called outside the MarketProvider.')
  return value
}

/** Find one listing on the board, or null while the board is still loading. */
export function useListing(asset: string | null): Listing | null {
  const { facts } = useMarket()
  if (!asset) return null
  return facts?.listings.find((listing) => listing.asset === asset) ?? null
}

interface CoinState {
  book: Book | null
  holders: Holder[]
  replies: Reply[]
  /** True until the first read for this asset comes back, empty or not. */
  loading: boolean
  reload(): Promise<void>
}

/**
 * Everything that costs a read per coin, for the one coin on screen.
 *
 * Polls on the same beat as the board. The three requests go together because
 * they are all stale at the same moment — somebody accepting an offer changes
 * the book and the holders in one block — and staggering them would show a
 * holder count that disagreed with the trade above it.
 */
export function useCoin(asset: string | null): CoinState {
  const { trader } = useMarket()
  const [book, setBook] = useState<Book | null>(null)
  const [holders, setHolders] = useState<Holder[]>([])
  const [replies, setReplies] = useState<Reply[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!trader || !asset) return
    const [nextBook, nextHolders, nextReplies] = await Promise.all([
      trader.book(asset).catch(() => null),
      trader.holders(asset).catch(() => []),
      trader.replies(asset).catch(() => []),
    ])
    setBook(nextBook)
    setHolders(nextHolders)
    setReplies(nextReplies)
    setLoading(false)
  }, [trader, asset])

  useEffect(() => {
    // Clear first, or the previous coin's book is on screen under the new coin's
    // name for one poll — which on a page about prices is a lie, briefly.
    setBook(null)
    setHolders([])
    setReplies([])
    setLoading(true)
    if (!trader || !asset) return

    void reload()
    const timer = setInterval(() => void reload(), POLL_MS)
    return () => clearInterval(timer)
  }, [trader, asset, reload])

  return { book, holders, replies, loading, reload }
}
