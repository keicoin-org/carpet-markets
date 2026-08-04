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

import { Caveat } from '../../components/Caveat'
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

export function LaunchScreen() {
  const { facts, funds, busy, act, trader } = useMarket()
  const router = useRouter()

  const [symbol, setSymbol] = useState('')
  const [name, setName] = useState('')
  const [blurb, setBlurb] = useState('')
  const [transfer, setTransfer] = useState<TransferPolicy>('open')
  const [touched, setTouched] = useState(false)

  const legend = useId()
  const errorId = useId()
  const feeRaw = useMemo(() => safeFee(facts?.launchFee ?? null), [facts])

  // Trimmed for display only — the strings the registry sends carry all
  // eighteen places, and nothing here is compared against them.
  const parts = useMemo(() => {
    const sent = facts?.launchFeeParts
    if (!sent) return null
    const burn = safeFee(sent.burn)
    const margin = safeFee(sent.margin)
    return burn === null || margin === null ? null : { burn: formatKei(burn, 4), margin: formatKei(margin, 4) }
  }, [facts])

  // The same function the registry validates with, so the message a person gets
  // while typing is the message they would have got after paying.
  const identity = complaint({ symbol, name, blurb })

  // Held back until the form has been touched, so an empty page does not open
  // with a complaint — and the fields do not open marked invalid either.
  const showsError = touched && identity !== null
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
            <Field
              label="Symbol"
              hint="2–10 characters, letters and digits, starting with a letter."
              value={symbol}
              maxLength={10}
              mono
              uppercase
              placeholder="WAGMI"
              invalid={showsError}
              describedBy={showsError ? errorId : undefined}
              onBlur={() => setTouched(true)}
              onChange={(next) => setSymbol(next.toUpperCase())}
            />
            <Field
              label="Name"
              value={name}
              maxLength={40}
              placeholder="We Are All Gonna Make It"
              invalid={showsError}
              describedBy={showsError ? errorId : undefined}
              onBlur={() => setTouched(true)}
              onChange={setName}
            />
          </div>

          <Field
            label="Blurb"
            hint={`One line. ${140 - blurb.length} characters left.`}
            value={blurb}
            maxLength={140}
            placeholder="What is it for?"
            onChange={setBlurb}
          />

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
            <div className="mt-2 field p-3">
              <div className="flex items-baseline gap-2">
                <span className="truncate font-semibold tracking-tight">{preview.symbol}</span>
                <span className="min-w-0 truncate text-xs text-dim">{preview.name}</span>
              </div>
              <div className="mt-1.5">
                <PolicyBadge listing={preview} target="static" />
              </div>
              {preview.blurb && <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-dim">{preview.blurb}</p>}
              <p className="mt-2 font-mono text-[10px] text-fainter tabular">
                never traded · creator holds 100%
              </p>
            </div>
          </section>

          <section className="panel p-3">
            <h2 className="eyebrow">What it costs</h2>
            {/* Every figure here is the registry's own constant, sent with the
                fee it adds up to. They used to be literal strings beside a
                computed total, which is a caption rather than a statement. */}
            <dl className="mt-2 space-y-2 font-mono text-[11px] tabular">
              <Line
                label="Issuance burn"
                value={parts ? `${parts.burn} Kei` : '…'}
                note="destroyed, not collected"
              />
              <Line
                label="Signing margin"
                value={parts ? `${parts.margin} Kei` : '…'}
                note="left on the new issuing account"
              />
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

          {/* The two holes that bite on this screen and nowhere else, stated
              here rather than only in the README (SPEC §9.6, criterion 9). */}
          <section className="panel space-y-2.5 p-3">
            <h2 className="eyebrow">What can go wrong here</h2>
            <Caveat id="one-quote" />
            <Caveat id="unmatched-payments" />
          </section>
        </aside>
      </div>

      {/* The refusal, in the one place somebody will be looking when the button
          does not work: immediately above it. Held back until the form has been
          touched, so an empty page does not open with a complaint. */}
      {blocked && (touched || blocked.code !== 'no-amount') && (
        <p id={errorId} className="text-xs leading-relaxed text-down" role="alert">
          {blocked.sentence}
          {blocked.fix && <span className="ml-1 text-fainter">{blocked.fix}</span>}
        </p>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
        <Link href="/" className="btn-quiet">
          Cancel
        </Link>
        {/* `aria-disabled`, not `disabled`. A disabled button leaves the tab
            order, which takes the reason it is disabled with it — a keyboard
            visitor tabs from the last field straight past the only control that
            would have told them why. It stays focusable, carries the sentence in
            its own accessible name, and refuses on click. */}
        <button
          type="button"
          className={`btn-gold ${blocked ? 'cursor-not-allowed opacity-40' : ''}`}
          aria-disabled={blocked !== null}
          aria-describedby={blocked ? errorId : undefined}
          onClick={submit}
        >
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

/**
 * One labelled input, with its hint as a description rather than as its name.
 *
 * The hint used to sit inside the `<label>`, which makes it part of the
 * accessible *name* rather than a description — and the blurb's hint counts
 * down characters, so the field's name changed on every keystroke and several
 * screen readers re-announced it. It is a sibling now, referenced by
 * `aria-describedby`, which is what that attribute is for.
 *
 * The validation sentence is referenced the same way, so a person who lands on
 * the Symbol field is told what is wrong with it rather than having to find a
 * red line at the other end of the page.
 */
function Field({
  label,
  hint,
  value,
  onChange,
  onBlur,
  placeholder,
  maxLength,
  invalid = false,
  describedBy,
  mono = false,
  uppercase = false,
}: {
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  placeholder?: string
  maxLength?: number
  invalid?: boolean
  describedBy?: string
  mono?: boolean
  uppercase?: boolean
}) {
  const id = useId()
  const hintId = `${id}-hint`
  const described = [hint ? hintId : null, describedBy ?? null].filter(Boolean).join(' ')

  return (
    <div>
      <label htmlFor={id} className="eyebrow block">
        {label}
      </label>
      <input
        id={id}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onBlur={onBlur}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={described || undefined}
        aria-invalid={invalid || undefined}
        className={`field mt-1 w-full px-2.5 py-2 text-sm placeholder:text-fainter ${mono ? 'font-mono' : ''} ${
          uppercase ? 'uppercase' : ''
        }`}
      />
      {hint && (
        <p id={hintId} className="mt-1 text-[10px] text-fainter">
          {hint}
        </p>
      )}
    </div>
  )
}
