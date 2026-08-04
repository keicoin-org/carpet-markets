'use client'

/**
 * Where React finds out that a chain exists.
 *
 * One provider owns the wallet, because there is one wallet per browser. It
 * polls the things that are cheap and global — this account's Kei, what it
 * holds, what it has listed, which coins exist, what has settled anywhere — and
 * hands them down. Anything that costs a read per coin is not in here; `useCoin`
 * fetches that for the one coin being looked at, which is the same restraint the
 * pre-React version had and for the same reason. Polling every book on the board
 * every two seconds would make this page the busiest client on the network for
 * no benefit.
 *
 * The wallet is created in an effect, never during render. A static export
 * prerenders these components at build time in Node, where there is no browser
 * storage to hold a seed and no node to talk to, so a wallet built during render
 * would break the build rather than the page.
 *
 * Balances arrive as three separate numbers and stay separate — see
 * `lib/balance.ts`. The one that decides whether a button works is `spendable`,
 * always, because it is the only one the ledger will agree with.
 *
 * Everything this browser signs goes through `act`, which is also what makes the
 * transaction tray possible: a signature is not an event that happens and is
 * gone, it is a record with a phase, and `lib/tx.ts` is the machine it moves
 * through.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Offer, Trade } from 'kei-transaction'

import type { Book, Holder, Listing, MarketFacts } from '../shared/listing'
import type { Reply } from '../shared/social'
import type { Funds, InFlight } from './balance'
import { connect, explain, type Trader } from './market'
import { advance, begin, fail, prune, type Tx, type TxKind } from './tx'

const POLL_MS = 2_000

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
  /** Settled trades across every listed coin, newest first. */
  activity: Trade[]
  /** False once the first read comes back, which is how loading is told from empty. */
  loading: boolean
  funds: Funds
  holdings: Map<string, number>
  mine: Offer[]
  /** True while a signature from this wallet is out. One at a time, deliberately. */
  busy: boolean
  /** Everything signed recently, with what became of it. */
  log: Tx[]
  /** Run one signed action, keeping the page honest about what is happening. */
  act(kind: TxKind, what: string, job: () => Promise<void>, effect?: Effect): Promise<void>
  /** Do it again. Only offered where `lib/tx.ts` says a retry is honest. */
  retry(id: number): Promise<void>
  dismiss(id: number): void
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
  const [activity, setActivity] = useState<Trade[]>([])
  const [loading, setLoading] = useState(true)
  const [chain, setChain] = useState<Chain>(NO_CHAIN)
  const [inFlight, setInFlight] = useState<InFlight[]>([])
  const [holdings, setHoldings] = useState<Map<string, number>>(new Map())
  const [mine, setMine] = useState<Offer[]>([])
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<Tx[]>([])

  // Read inside the interval so the poll always sees the current wallet without
  // the interval being torn down and rebuilt every time one of these changes.
  const traderRef = useRef<Trader | null>(null)
  traderRef.current = trader

  // `busy` guards re-entry, and it is a ref as well as state so that guarding
  // does not put `act` in a new identity on every keystroke elsewhere.
  const busyRef = useRef(false)
  const ticket = useRef(0)

  /**
   * The work behind each record, so a retry can run the same thing again.
   *
   * A ref rather than state: these are closures over component scope, they are
   * never rendered, and putting them in state would re-render the whole tree
   * every time one was filed.
   */
  const jobs = useRef(new Map<number, { kind: TxKind; what: string; job: () => Promise<void>; effect?: Effect }>())

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
      const [confirmed, waiting, held, open, settled] = await Promise.all([
        active.keiBalance(),
        active.incoming(),
        active.holdings(next.listings.map((listing) => listing.asset)),
        active.mine(),
        active.activity().catch(() => [] as Trade[]),
      ])
      setChain({ confirmed, incoming: waiting.kei, arrivals: waiting.arrivals })
      setHoldings(held)
      setMine(open)
      setActivity(settled)
    } catch (error) {
      // A missed poll is not something to shout about — the next one is two
      // seconds away and the page is still showing the last good read. Only a
      // signature failing is worth a record, and that has one already.
      console.warn('carpet: a read did not come back —', explain(error))
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

  // Records age out of the tray on their own — a failure lingers five times as
  // long as a success, because a success is confirmed by the balance moving and
  // a failure is only ever confirmed by somebody reading it.
  useEffect(() => {
    if (log.length === 0) return
    const timer = setInterval(() => setLog((current) => prune(current, Date.now())), 1_000)
    return () => clearInterval(timer)
  }, [log.length])

  const dismiss = useCallback((id: number) => {
    setLog((current) => current.filter((tx) => tx.id !== id))
    jobs.current.delete(id)
  }, [])

  /**
   * One signed action, with what it is expected to do carried alongside it.
   *
   * The expectation goes up on screen immediately and comes down only once the
   * poll that follows the action has returned — so the balance never flickers
   * back to its old value in the gap, and never counts the change twice once
   * the chain reports it. While it is up it is a debt, never a credit: money
   * arriving does not fund the next spend until it has arrived.
   *
   * The phases are `lib/tx.ts`'s and they are not cosmetic. `signing` means
   * nothing has left this browser; `settling` means a block is out and the page
   * is behind; `done` means a read has actually seen it. Only the third is a
   * fact, and only the third is allowed to be phrased as one.
   */
  const run = useCallback(
    async (id: number, kind: TxKind, what: string, job: () => Promise<void>, effect?: Effect, attempt = 1) => {
      busyRef.current = true
      setBusy(true)
      setLog((current) => [...current.filter((tx) => tx.id !== id), begin(id, kind, what, Date.now(), attempt)])
      jobs.current.set(id, { kind, what, job, effect })

      if (effect) {
        setInFlight((list) => [
          ...list.filter((change) => change.id !== id),
          { id, what, kei: effect.kei ?? 0n, coins: new Map(effect.coins ?? []) },
        ])
      }

      let broke: string | null = null
      try {
        await job()
        setLog((current) => current.map((tx) => (tx.id === id ? advance(tx, 'settling', Date.now()) : tx)))
      } catch (error) {
        broke = explain(error)
      } finally {
        // Keep the wallet locked until reconciliation finishes. Releasing it
        // before this read lets a second signature race the refresh and makes
        // both actions reason from the same pre-settlement snapshot.
        try {
          await refresh()
        } finally {
          setInFlight((list) => list.filter((change) => change.id !== id))
          setLog((current) =>
            current.map((tx) =>
              tx.id !== id ? tx : broke === null ? advance(tx, 'done', Date.now()) : fail(tx, broke, Date.now()),
            ),
          )
          if (broke === null) jobs.current.delete(id)
          busyRef.current = false
          setBusy(false)
        }
      }
    },
    [refresh],
  )

  const act = useCallback(
    async (kind: TxKind, what: string, job: () => Promise<void>, effect?: Effect) => {
      if (busyRef.current) return
      await run(++ticket.current, kind, what, job, effect)
    },
    [run],
  )

  const retry = useCallback(
    async (id: number) => {
      if (busyRef.current) return
      const filed = jobs.current.get(id)
      const previous = log.find((tx) => tx.id === id)
      if (!filed || !previous) return
      await run(id, filed.kind, filed.what, filed.job, filed.effect, previous.attempts + 1)
    },
    [log, run],
  )

  const funds = useMemo<Funds>(() => ({ ...chain, inFlight }), [chain, inFlight])

  const value = useMemo<MarketState>(
    () => ({
      trader,
      fatal,
      facts,
      activity,
      loading,
      funds,
      holdings,
      mine,
      busy,
      log,
      act,
      retry,
      dismiss,
      refresh,
    }),
    [trader, fatal, facts, activity, loading, funds, holdings, mine, busy, log, act, retry, dismiss, refresh],
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

/** This wallet's own open offers for one coin, and how many units they lock up. */
export function useMyOffers(asset: string | null): { offers: Offer[]; locked: number } {
  const { mine } = useMarket()
  return useMemo(() => {
    const offers = asset ? mine.filter((offer) => offer.give.asset === asset) : []
    return { offers, locked: offers.reduce((total, offer) => total + offer.give.amount, 0) }
  }, [mine, asset])
}

interface CoinState {
  book: Book | null
  holders: Holder[]
  replies: Reply[]
  /** True until the first read for this asset comes back, empty or not. */
  loading: boolean
  /** Set when a read failed and there is nothing cached to show instead. */
  problem: string | null
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
  const [problem, setProblem] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!trader || !asset) return
    const [nextBook, nextHolders, nextReplies] = await Promise.all([
      trader.book(asset).then(
        (value) => ({ value, error: null as string | null }),
        (error: unknown) => ({ value: null, error: explain(error) }),
      ),
      trader.holders(asset).catch(() => [] as Holder[]),
      trader.replies(asset).catch(() => [] as Reply[]),
    ])
    // A failed read keeps the last good book rather than blanking the page. An
    // order book that vanishes for one poll and comes back is worse than one
    // that is two seconds old and says so.
    if (nextBook.value) setBook(nextBook.value)
    setProblem(nextBook.value ? null : nextBook.error)
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
    setProblem(null)
    setLoading(true)
    if (!trader || !asset) return

    void reload()
    const timer = setInterval(() => void reload(), POLL_MS)
    return () => clearInterval(timer)
  }, [trader, asset, reload])

  return { book, holders, replies, loading, problem, reload }
}
