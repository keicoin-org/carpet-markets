'use client'

/**
 * Which chain this is, at length, with the mainnet question answered.
 *
 * It is a page rather than a modal because the answer does not fit in one, and
 * because "what is underneath this" is the question a person should be able to
 * link somebody else to. The badge in the bar points here from every screen.
 *
 * The third card is the point of the page. "Make it mainnet-ready" is how the
 * request keeps arriving, and the answer is not a schedule — it is four gates in
 * SPEC §15 and §17 that no amount of front-end work touches, plus a fifth that
 * is about this demo specifically. A disabled option that will not say why reads
 * as unfinished work. This one says why, in the words of the sections that own
 * each gate, so the claim is checkable rather than atmospheric.
 */

import Link from 'next/link'

import { MAINNET_GATES, NETWORKS, type NetworkMode } from '../../shared/network'
import { useMarket } from '../../lib/use-market'

export default function NetworkPage() {
  const { facts } = useMarket()
  const current = facts?.chain

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/" className="inline-block font-mono text-[11px] text-fainter hover:text-gold">
        ← board
      </Link>

      <header>
        <h1 className="text-2xl font-bold tracking-tight">What is under this page</h1>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-dim">
          Every offer, settlement and cancel here is a block signed by a key in this browser. Which ledger those blocks
          go to is the only thing that changes between the modes below, and the badge in the bar always says which one
          is live — it is read off the server rather than compiled into the page, so it cannot be out of date with the
          thing it describes.
        </p>
      </header>

      {current && (
        <section className="panel border-gold/30 bg-gold/[0.04] p-4">
          <h2 className="eyebrow text-gold/80">Right now</h2>
          <p className="mt-1.5 text-sm text-ink">{NETWORKS[current.mode].label}</p>
          <p className="mt-1 text-sm leading-relaxed text-dim">{NETWORKS[current.mode].summary}</p>
          <dl className="mt-3 grid gap-2 font-mono text-[11px] tabular sm:grid-cols-3">
            <Fact label="Node" value={current.node ?? 'in this process'} />
            <Fact label="SDK network" value={current.sdkNetwork} />
            <Fact label="Survives a restart" value={current.ephemeral ? 'no' : 'yes'} />
          </dl>
        </section>
      )}

      <div className="space-y-3">
        {(['mock', 'testnet', 'mainnet'] as NetworkMode[]).map((mode) => (
          <Mode key={mode} mode={mode} live={current?.mode === mode} />
        ))}
      </div>

      <section className="panel p-4">
        <h2 className="text-sm font-semibold">Why mainnet is not a setting</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-dim">
          The demo refuses `mainnet` by name, before anything opens a socket, in the same way `Kei.server()` refuses to
          run in a browser. It is not a missing feature with a ticket behind it. Five things gate it and four of them
          are arguments rather than builds:
        </p>
        <ul className="mt-3 space-y-3">
          {MAINNET_GATES.map((gate) => (
            <li key={gate.gate} className="border-l-2 border-line pl-3">
              <p className="text-sm text-ink">
                {gate.gate}
                <span className="ml-2 font-mono text-[10px] text-fainter">SPEC {gate.spec}</span>
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-dim">{gate.why}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel p-4">
        <h2 className="text-sm font-semibold">Checking this rather than believing it</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-dim">
          The claim that a network can carry this market is checkable in one command, against whatever node you point
          it at. It walks the whole path a launch and a trade take — faucet, issue, mint, offer, accept, cancel, price
          history — and finishes with a refusal it expects the ledger to make.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md border border-line bg-floor p-3 font-mono text-[11px] text-dim">
          bun run probe:testnet
        </pre>
        <p className="mt-2 text-[11px] leading-relaxed text-fainter">
          `NETWORK.md` in the repository carries the last run of it, with the node’s answers.
        </p>
      </section>
    </div>
  )
}

function Mode({ mode, live }: { mode: NetworkMode; live: boolean }) {
  const network = NETWORKS[mode]
  return (
    <section
      className={`panel p-4 ${live ? 'border-line-bright' : ''} ${network.selectable ? '' : 'opacity-80'}`}
      aria-current={live ? 'true' : undefined}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className={`text-sm font-semibold ${network.tone === 'refused' ? 'text-down' : 'text-ink'}`}>
          {network.label}
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-fainter">
          {live ? 'live here' : network.selectable ? 'available' : 'refused'}
        </span>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-dim">{network.detail}</p>
    </section>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-0.5 truncate text-dim" title={value}>
        {value}
      </dd>
    </div>
  )
}
