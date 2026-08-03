'use client'

/**
 * What just happened, including when it failed.
 *
 * Ledger refusals land here verbatim, which is the point of the component. "This
 * coin cannot be transferred" is not an error in this demo, it is the demo
 * working — so the failure tone is a border and a colour rather than an
 * apology, and the text is whatever the chain actually said.
 *
 * A refusal is announced assertively and everything else politely, because a
 * screen reader interrupting itself to say "Buying 1,000 CARPET…" is worse than
 * useless while a refusal that waits its turn can be missed entirely.
 */

import { useEffect } from 'react'

import { useMarket } from '../lib/use-market'

/** Long enough to read a refusal, which is the longest message here. */
const LINGER_MS = 6_000

const TONES = {
  busy: 'border-line-bright bg-raised text-dim',
  ok: 'border-line-bright bg-raised text-ink',
  bad: 'border-down/50 bg-[#1a1113] text-[#ffd9d9]',
} as const

export function Toast() {
  const { note, dismiss } = useMarket()
  const tone = note?.tone

  useEffect(() => {
    // Keep the in-flight message up: it means a signature is still out, and
    // whatever replaces it will clear this itself.
    if (!tone || tone === 'busy') return
    const timer = setTimeout(dismiss, LINGER_MS)
    return () => clearTimeout(timer)
  }, [note, tone, dismiss])

  if (!note) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-5">
      <button
        type="button"
        onClick={dismiss}
        role={note.tone === 'bad' ? 'alert' : 'status'}
        aria-live={note.tone === 'bad' ? 'assertive' : 'polite'}
        className={`pointer-events-auto flex max-w-xl items-center gap-2.5 rounded-md border px-3.5 py-2.5 text-left text-sm shadow-lg shadow-black/40 ${TONES[note.tone]}`}
      >
        {note.tone === 'busy' && <Spinner />}
        <span>{note.text}</span>
        <span className="sr-only"> (select to dismiss)</span>
      </button>
    </div>
  )
}

/** Motion, for the one state that is a wait rather than an outcome. */
function Spinner() {
  return (
    <span
      aria-hidden
      className="size-3 shrink-0 animate-spin rounded-full border border-line-bright border-t-gold motion-reduce:animate-none"
    />
  )
}
