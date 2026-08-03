'use client'

/**
 * Launch a coin.
 *
 * The three policy cards are the most consequential control in this project, so
 * they are the largest thing on the page rather than a select tucked under the
 * name field. Choosing one is choosing whether the coin can ever have a market,
 * and it is chosen exactly once — the chain fixes it at issuance and there is no
 * later screen where it can be edited, by the creator or by anybody.
 *
 * The default is `open`, which is the dangerous one. That is deliberate: it is
 * the policy every coin on every launchpad in this shape actually has, and a
 * demo that defaulted to the safe option would be flattering the genre rather
 * than showing it.
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { ReactNode } from 'react'

import { formatKei, parseKei } from '../../shared/format'
import type { TransferPolicy } from '../../shared/listing'
import { useMarket } from '../../lib/use-market'

const CHOICES: { value: TransferPolicy; title: string; body: string; tone: string }[] = [
  {
    value: 'open',
    title: 'Open',
    tone: 'border-down/50 bg-down/[0.06]',
    body: 'Anybody can trade it, so it has a real order book. You are minted the whole supply and nothing stops you selling it into that book at any pace you like. Buyers can see this before they buy.',
  },
  {
    value: 'issuer-only',
    title: 'Issuer only',
    tone: 'border-line-bright bg-raised',
    body: 'Units move only to or from the issuing account. No offer between two holders is a valid block, so there is no player-to-player market and cannot be one.',
  },
  {
    value: 'none',
    title: 'Soulbound',
    tone: 'border-up/45 bg-up/[0.06]',
    body: 'Nothing moves, ever. It cannot be sold, by you or by anybody. Enforced by the chain, immutably, from issuance.',
  },
]

export default function Launch() {
  const { facts, busy, act, trader } = useMarket()
  const router = useRouter()

  const [symbol, setSymbol] = useState('')
  const [name, setName] = useState('')
  const [blurb, setBlurb] = useState('')
  const [transfer, setTransfer] = useState<TransferPolicy>('open')

  const fee = facts?.launchFee ?? '0'

  const submit = (): void => {
    void act('Launching', async () => {
      await trader?.launch({ symbol, name, blurb, transfer })
      router.push('/')
    })
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Link href="/" className="inline-block font-mono text-[11px] text-fainter hover:text-gold">
        ← board
      </Link>

      <div>
        <h1 className="text-2xl font-bold tracking-tight">Launch a coin</h1>
        <p className="mt-2 text-sm leading-relaxed text-dim">
          This costs {formatKei(parseKei(fee), 4)} Kei and almost all of it is burned rather than collected. It is the
          same for everybody and does not go up as more coins are listed: each one is issued by a fresh account, so a
          launch pays that account’s first burn and nothing else.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Symbol" hint="2–10 characters, letters and digits, starting with a letter.">
          <input
            value={symbol}
            maxLength={10}
            onChange={(event) => setSymbol(event.target.value.toUpperCase())}
            placeholder="WAGMI"
            className="w-full rounded-md border border-line bg-panel px-2.5 py-2 font-mono text-sm uppercase placeholder:text-fainter focus:border-line-bright focus:outline-none"
          />
        </Field>
        <Field label="Name">
          <input
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            placeholder="We Are All Gonna Make It"
            className="w-full rounded-md border border-line bg-panel px-2.5 py-2 text-sm placeholder:text-fainter focus:border-line-bright focus:outline-none"
          />
        </Field>
      </div>

      <Field label="Blurb" hint="One line. 140 characters.">
        <input
          value={blurb}
          maxLength={140}
          onChange={(event) => setBlurb(event.target.value)}
          placeholder="What is it for?"
          className="w-full rounded-md border border-line bg-panel px-2.5 py-2 text-sm placeholder:text-fainter focus:border-line-bright focus:outline-none"
        />
      </Field>

      <fieldset>
        <legend className="eyebrow">Who may move it — chosen once, fixed forever</legend>
        <div className="mt-2 grid gap-2">
          {CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              aria-pressed={transfer === choice.value}
              onClick={() => setTransfer(choice.value)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                transfer === choice.value ? choice.tone : 'border-line bg-panel hover:border-line-bright'
              }`}
            >
              <span className="flex items-center gap-2">
                <span
                  className={`inline-block size-2 rounded-full ${
                    transfer === choice.value ? 'bg-gold' : 'bg-line-bright'
                  }`}
                  aria-hidden
                />
                <span className="text-sm font-semibold">{choice.title}</span>
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-dim">{choice.body}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
        <Link href="/" className="btn-quiet">
          Cancel
        </Link>
        <button
          type="button"
          className="btn-gold"
          disabled={busy || !trader || !symbol.trim() || name.trim().length < 2}
          onClick={submit}
        >
          Pay the fee and launch
        </button>
      </div>

      <p className="text-[11px] leading-relaxed text-fainter">
        The fee is paid first and the coin is issued when it lands, so there is a moment after you press this where the
        board has your Kei and not yet your coin. It is not refundable, because the burn it pays for is not reversible.
      </p>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <span className="mt-1 block">{children}</span>
      {hint && <span className="mt-1 block text-[10px] text-fainter">{hint}</span>}
    </label>
  )
}
