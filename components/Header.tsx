'use client'

/**
 * The bar. A wordmark, and the wallet that signs everything.
 *
 * There is no sign-in button because there is no account to sign in to. The
 * address shown here was generated in this browser on the first visit and its
 * key has never left; the faucet is next to it because on a mock chain an empty
 * wallet is a dead end and filling one costs nothing.
 *
 * The balance is two numbers wearing one label everywhere else on the internet.
 * The big one is what can be spent this instant. Anything owed or halfway is a
 * second, quieter figure beside it — never added into the first, because the
 * ledger will not add it either.
 */

import Link from 'next/link'

import { KEI_RAW, formatKei, shortAddress } from '../shared/format'
import { projected, spendable, settling } from '../lib/balance'
import { useMarket } from '../lib/use-market'

export function Header() {
  const { trader, facts, funds, busy, act } = useMarket()

  const now = spendable(funds)
  const soon = projected(funds)
  const moving = settling(funds) && soon !== now

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-floor/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <Link href="/" className="group flex items-baseline gap-2">
          <span className="text-[15px] font-bold tracking-tight group-hover:text-gold">Carpet Markets</span>
          <span className="hidden font-mono text-[10px] text-fainter sm:inline">
            {facts ? `${facts.network} · ${facts.listings.length} listed` : 'connecting…'}
          </span>
        </Link>

        <div className="ml-auto flex items-center gap-2.5">
          {trader && (
            <span
              title={trader.address}
              aria-label={`This browser's wallet, ${trader.address}`}
              className="hidden font-mono text-[11px] text-fainter sm:inline"
            >
              {shortAddress(trader.address)}
            </span>
          )}

          <p className="flex flex-col items-end leading-none">
            <span className="font-mono text-sm tabular">
              <span className="text-gold">{formatKei(now, 4)}</span>
              <span className="ml-1 text-fainter">Kei</span>
              <span className="sr-only"> confirmed and spendable</span>
            </span>
            {moving && (
              <span className="mt-0.5 font-mono text-[10px] text-dim tabular" aria-live="polite">
                {formatKei(soon, 4)} once settled
                <span className="sr-only">
                  , which includes {funds.arrivals} arrival{funds.arrivals === 1 ? '' : 's'} not yet signed for and
                  cannot be spent until it is
                </span>
              </span>
            )}
          </p>

          <button
            type="button"
            className="btn-quiet px-2 py-1 text-xs"
            disabled={busy || !trader}
            onClick={() =>
              void act('Topping up', () => trader?.topUp() ?? Promise.resolve(), { kei: 25n * KEI_RAW })
            }
          >
            Faucet
          </button>

          <Link href="/launch" className="btn-gold px-2.5 py-1 text-xs">
            <span className="sm:hidden">Launch</span>
            <span className="hidden sm:inline">Launch a coin</span>
          </Link>
        </div>
      </div>
    </header>
  )
}
