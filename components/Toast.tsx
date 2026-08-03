'use client'

/**
 * What just happened, including when it failed.
 *
 * Ledger refusals land here verbatim, which is the point of the component. "This
 * coin cannot be transferred" is not an error in this demo, it is the demo
 * working — so the failure tone is a border and a colour rather than an
 * apology, and the text is whatever the chain actually said.
 */

import { useEffect } from 'react'

import { useMarket } from '../lib/use-market'

/** Long enough to read a refusal, which is the longest message here. */
const LINGER_MS = 6_000

export function Toast() {
  const { note, dismiss } = useMarket()

  useEffect(() => {
    if (!note) return
    // Keep "…" messages up: they mean a signature is still in flight, and the
    // action that replaces them will clear this itself.
    if (note.text.endsWith('…')) return
    const timer = setTimeout(dismiss, LINGER_MS)
    return () => clearTimeout(timer)
  }, [note, dismiss])

  if (!note) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-5">
      <button
        type="button"
        onClick={dismiss}
        role="status"
        className={`pointer-events-auto max-w-xl rounded-md border px-3.5 py-2.5 text-left text-sm shadow-lg shadow-black/40 ${
          note.tone === 'bad' ? 'border-down/50 bg-[#1a1113] text-[#ffd9d9]' : 'border-line-bright bg-raised text-ink'
        }`}
      >
        {note.text}
      </button>
    </div>
  )
}
