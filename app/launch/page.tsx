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
 *
 * They are real radio inputs. They were buttons carrying `aria-pressed`, which
 * announces three independent toggles — for the one control on the site that is
 * a permanent choice between three things, the arrow keys and the "2 of 3" are
 * worth the styling.
 *
 * The preview beside them is not decoration. The coin's mark is derived from an
 * asset id that does not exist yet, so it cannot be shown truthfully — what the
 * preview does show is the card as the board will render it, with the badge that
 * every buyer will see first, next to the choice that fixes it.
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { PolicyBadge } from '../../components/PolicyBadge'
import { formatKei, parseKei } from '../../shared/format'
import { cleanIdentity, LAUNCH_SUPPLY, type Listing, type TransferPolicy } from '../../shared/listing'
import { launchBlocker } from '../../lib/refusals'
import type { Trader } from '../../lib/market'
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

/**
 * How long to wait for a paid-for coin to appear on the board.
 *
 * The registry issues on the payment arriving, not on the request returning, and
 * there is no endpoint that reports whether it worked — so the only honest
 * confirmation is the coin turning up in `facts`. Twenty seconds is far longer
 * than a mock chain needs and short enough that a person is still watching.
 */
const APPEARS_WITHIN_MS = 20_000

export default function Launch() {
  const { facts, funds, busy, act, trader } = useMarket()
  const router = useRouter()

  const [symbol, setSymbol] = useState('')
  const [name, setName] = useState('')
  const [blurb, setBlurb] = useState('')
  const [transfer, setTransfer] = useState<TransferPolicy>('open')
  const [touched, setTouched] = useState(false)

  const legend = useId()
  const feeRaw = useMemo(() => safeFee(facts?.launchFee ?? null), [facts])

  // The same function the registry validates with, so the message a person gets
  // while typing is the message they would have got after paying.
  const identity = complaint({ symbol, name, blurb })
  const blocked = launchBlocker({
    funds,
    fee: feeRaw,
    identity,
    you: trader?.address ?? null,
    busy,
  })

  const preview: Listing = {
    asset: 'preview',
    symbol: symbol.trim().toUpperCase() || 'TICKER',
    name: name.trim() || 'Your coin',
    blurb: blurb.trim(),
    issuer: 'kei_preview',
    creator: trader?.address ?? 'kei_preview',
    transfer,
    supply: LAUNCH_SUPPLY,
    launchedAt: Date.now(),
  }

  const submit = (): void => {
    setTouched(true)
    if (blocked || !trader) return

    void act(
      'launch',
      `Launching ${preview.symbol}`,
      async () => {
        const quote = await trader.launch({ symbol, name, blurb, transfer })
        const listed = await appear(trader, quote.symbol)
        if (!listed) {
          throw new Error(
            `${quote.symbol} was paid for and has not appeared on the board yet. The fee buys a burn, so it is not refundable, and the board is the only place that will confirm it.`,
          )
        }
        router.push(`/coin?asset=${encodeURIComponent(listed.asset)}`)
      },
      { kei: feeRaw === null ? 0n : -feeRaw },
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <Link href="/" className="inline-block font-mono text-[11px] text-fainter hover:text-gold">
        ← board
      </Link>

      <div>
        <h1 className="text-2xl font-bold tracking-tight">Launch a coin</h1>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-dim">
          You are minted the entire supply — {LAUNCH_SUPPLY.toLocaleString('en')} units — and every coin anybody else
          ends up with comes out of that pile through an offer somebody accepted.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        <div className="min-w-0 space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Symbol" hint="2–10 characters, letters and digits, starting with a letter.">
              <input
                value={symbol}
                maxLength={10}
                onBlur={() => setTouched(true)}
                onChange={(event) => setSymbol(event.target.value.toUpperCase())}
                placeholder="WAGMI"
                className="w-full rounded-md border border-line bg-panel px-2.5 py-2 font-mono text-sm uppercase placeholder:text-fainter focus:border-line-bright"
              />
            </Field>
            <Field label="Name">
              <input
                value={name}
                maxLength={40}
                onBlur={() => setTouched(true)}
                onChange={(event) => setName(event.target.value)}
                placeholder="We Are All Gonna Make It"
                className="w-full rounded-md border border-line bg-panel px-2.5 py-2 text-sm placeholder:text-fainter focus:border-line-bright"
              />
            </Field>
          </div>

          <Field label="Blurb" hint={`One line. ${140 - blurb.length} characters left.`}>
            <input
              value={blurb}
              maxLength={140}
              onChange={(event) => setBlurb(event.target.value)}
              placeholder="What is it for?"
              className="w-full rounded-md border border-line bg-panel px-2.5 py-2 text-sm placeholder:text-fainter focus:border-line-bright"
            />
          </Field>

          <fieldset aria-labelledby={legend}>
            <legend id={legend} className="eyebrow">
              Who may move it — chosen once, fixed forever
            </legend>
            <div className="mt-2 grid gap-2">
              {CHOICES.map((choice) => (
                <label
                  key={choice.value}
                  className={`block cursor-pointer rounded-lg border p-3 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-gold ${
                    transfer === choice.value ? choice.tone : 'border-line bg-panel hover:border-line-bright'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="transfer"
                      value={choice.value}
                      checked={transfer === choice.value}
                      onChange={() => setTransfer(choice.value)}
                      className="sr-only"
                    />
                    <span
                      className={`inline-block size-2 rounded-full ${
                        transfer === choice.value ? 'bg-gold' : 'bg-line-bright'
                      }`}
                      aria-hidden
                    />
                    <span className="text-sm font-semibold">{choice.title}</span>
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-dim">{choice.body}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <aside className="min-w-0 space-y-4 lg:sticky lg:top-16">
          <section className="panel p-3">
            <h2 className="eyebrow">What a buyer will see first</h2>
            <div className="mt-2 rounded-md border border-line bg-floor p-3">
              <div className="flex items-baseline gap-2">
                <span className="truncate font-semibold tracking-tight">{preview.symbol}</span>
                <span className="min-w-0 truncate text-xs text-dim">{preview.name}</span>
              </div>
              <div className="mt-1.5">
                <PolicyBadge listing={preview} />
              </div>
              {preview.blurb && <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-dim">{preview.blurb}</p>}
              <p className="mt-2 font-mono text-[10px] text-fainter tabular">
                never traded · creator holds 100%
              </p>
            </div>
          </section>

          <section className="panel p-3">
            <h2 className="eyebrow">What it costs</h2>
            <dl className="mt-2 space-y-2 font-mono text-[11px] tabular">
              <Line label="Issuance burn" value="1 Kei" note="destroyed, not collected" />
              <Line label="Signing margin" value="0.1 Kei" note="left on the new issuing account" />
              <Line
                label="Total"
                value={feeRaw === null ? '…' : `${formatKei(feeRaw, 4)} Kei`}
                note="flat, however many coins are already listed"
                strong
              />
            </dl>
            <p className="mt-2 text-[10px] leading-relaxed text-fainter">
              The burn escalates per issuing account (SPEC §5.6.5) and every coin here gets a fresh one, so a launch
              pays that account’s first burn and never anybody else’s. It is not refundable, because a burn is not
              reversible.
            </p>
          </section>
        </aside>
      </div>

      {/* The refusal, in the one place somebody will be looking when the button
          does not work: immediately above it. Held back until the form has been
          touched, so an empty page does not open with a complaint. */}
      {blocked && (touched || blocked.code !== 'no-amount') && (
        <p className="text-xs leading-relaxed text-down" role="status">
          {blocked.sentence}
          {blocked.fix && <span className="ml-1 text-fainter">{blocked.fix}</span>}
        </p>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
        <Link href="/" className="btn-quiet">
          Cancel
        </Link>
        <button type="button" className="btn-gold" disabled={blocked !== null} onClick={submit}>
          {busy ? 'Launching…' : 'Pay the fee and launch'}
        </button>
      </div>

      <p className="text-[11px] leading-relaxed text-fainter">
        The fee is paid first and the coin is issued when it lands, so there is a moment after you press this where the
        registry has your Kei and not yet your coin. This page waits for the coin rather than sending you off as though
        it already existed, and if it does not arrive it says so instead of offering to pay again.
      </p>
    </div>
  )
}

function Line({
  label,
  value,
  note,
  strong = false,
}: {
  label: string
  value: string
  note: string
  strong?: boolean
}) {
  return (
    <div className={strong ? 'border-t border-line pt-2' : ''}>
      <div className="flex items-baseline justify-between gap-2">
        <dt className="text-fainter">{label}</dt>
        <dd className={strong ? 'text-gold' : 'text-dim'}>{value}</dd>
      </div>
      {/* The note under the figure rather than beside it. Inline, it wrapped
          between the label and its own number at every width worth caring
          about, and a price list that wraps mid-row reads as broken. */}
      <p className="mt-0.5 text-[10px] leading-snug text-fainter">{note}</p>
    </div>
  )
}

/** What is wrong with the identity as typed, or null when nothing is. */
function complaint(input: { symbol: string; name: string; blurb: string }): string | null {
  if (!input.symbol.trim() && !input.name.trim()) return 'A coin needs a symbol and a name.'
  try {
    cleanIdentity(input)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Wait for a paid-for coin to turn up on the board.
 *
 * Polls the registry rather than the provider's copy, because this runs inside
 * the action and the provider's next refresh is behind it.
 */
async function appear(trader: Trader, symbol: string): Promise<Listing | null> {
  const deadline = Date.now() + APPEARS_WITHIN_MS
  for (;;) {
    const listed = await trader
      .facts()
      .then((next) => next.listings.find((listing) => listing.symbol === symbol) ?? null)
      .catch(() => null)
    if (listed) return listed
    if (Date.now() > deadline) return null
    await new Promise((resume) => setTimeout(resume, 500))
  }
}

/** The fee as raw, tolerating a registry that has not answered yet. */
function safeFee(fee: string | null): bigint | null {
  if (fee === null) return null
  try {
    return parseKei(fee)
  } catch {
    return null
  }
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
