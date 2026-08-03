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
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Offer } from 'kei-transaction'

import type { Book, Holder, Listing, MarketFacts } from '../shared/listing'
import type { Reply } from '../shared/social'
import { connect, explain, type Trader } from './market'

const POLL_MS = 2_000

export interface Note {
  text: string
  tone: 'ok' | 'bad'
}

interface MarketState {
  trader: Trader | null
  /** Set only if the wallet could not be opened at all. */
  fatal: string | null
  facts: MarketFacts | null
  kei: bigint
  holdings: Map<string, number>
  mine: Offer[]
  busy: boolean
  note: Note | null
  say(text: string, tone: Note['tone']): void
  dismiss(): void
  /** Run one signed action, keeping the page honest about what is happening. */
  act(what: string, job: () => Promise<void>): Promise<void>
  refresh(): Promise<void>
}

const Ctx = createContext<MarketState | null>(null)

export function MarketProvider({ children }: { children: ReactNode }) {
  const [trader, setTrader] = useState<Trader | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [facts, setFacts] = useState<MarketFacts | null>(null)
  const [kei, setKei] = useState<bigint>(0n)
  const [holdings, setHoldings] = useState<Map<string, number>>(new Map())
  const [mine, setMine] = useState<Offer[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note | null>(null)

  // Read inside the interval so the poll always sees the current wallet without
  // the interval being torn down and rebuilt every time one of these changes.
  const traderRef = useRef<Trader | null>(null)
  traderRef.current = trader

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const opened = await connect()
        if (live) setTrader(opened)
      } catch (error) {
        if (live) setFatal(explain(error))
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

      const [balance, held, open] = await Promise.all([
        active.keiBalance(),
        active.holdings(next.listings.map((listing) => listing.asset)),
        active.mine(),
      ])
      setKei(balance)
      setHoldings(held)
      setMine(open)
    } catch (error) {
      setNote({ text: explain(error), tone: 'bad' })
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

  const act = useCallback(
    async (what: string, job: () => Promise<void>) => {
      if (busy) return
      setBusy(true)
      setNote({ text: `${what}…`, tone: 'ok' })
      try {
        await job()
        setNote({ text: `${what} — done.`, tone: 'ok' })
      } catch (error) {
        setNote({ text: explain(error), tone: 'bad' })
      } finally {
        setBusy(false)
        await refresh()
      }
    },
    [busy, refresh],
  )

  const value = useMemo<MarketState>(
    () => ({ trader, fatal, facts, kei, holdings, mine, busy, note, say, dismiss, act, refresh }),
    [trader, fatal, facts, kei, holdings, mine, busy, note, say, dismiss, act, refresh],
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
  }, [trader, asset])

  useEffect(() => {
    // Clear first, or the previous coin's book is on screen under the new coin's
    // name for one poll — which on a page about prices is a lie, briefly.
    setBook(null)
    setHolders([])
    setReplies([])
    if (!trader || !asset) return

    void reload()
    const timer = setInterval(() => void reload(), POLL_MS)
    return () => clearInterval(timer)
  }, [trader, asset, reload])

  return { book, holders, replies, reload }
}
