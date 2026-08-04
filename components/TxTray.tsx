'use client'

/**
 * What this browser has signed lately, and what became of it.
 *
 * The version of this that was a toast could show one thing at a time and said
 * `Buying 1,000 CARPET — done.` for both "the block is out" and "a read has seen
 * it", which are two seconds and one important difference apart. A market page
 * cannot round those together: the first is a claim about this browser and the
 * second is a claim about the chain.
 *
 * So each signature is a row with a phase, and the phases mean exactly what
 * `lib/tx.ts` says they mean. Signing is a spinner and nothing has left. Settling
 * is a block on the network and a balance on screen that is behind it. Done is
 * the only one phrased as a fact.
 *
 * Failures are the reason this is a tray rather than a line. A ledger refusal is
 * not an outage — "this coin cannot be transferred" is the demo working — so a
 * failed row carries the chain's own words, the one next move that is actually
 * available, and a retry button *only* where trying again is honest.
 */

import { pending, retryable, type Tx } from '../lib/tx'
import { useMarket } from '../lib/use-market'

const PHASE: Record<Tx['phase'], { label: string; className: string }> = {
  signing: { label: 'signing', className: 'text-dim' },
  settling: { label: 'settling', className: 'text-gold' },
  done: { label: 'settled', className: 'text-up' },
  failed: { label: 'refused', className: 'text-down' },
}

export function TxTray() {
  const { log, retry, dismiss, busy } = useMarket()
  if (log.length === 0) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-4">
      <ul className="pointer-events-auto flex w-full max-w-md flex-col gap-1.5" aria-label="Recent actions">
        {log.map((tx) => (
          <Row key={tx.id} tx={tx} busy={busy} onRetry={() => void retry(tx.id)} onDismiss={() => dismiss(tx.id)} />
        ))}
      </ul>
    </div>
  )
}

function Row({
  tx,
  busy,
  onRetry,
  onDismiss,
}: {
  tx: Tx
  busy: boolean
  onRetry: () => void
  onDismiss: () => void
}) {
  const phase = PHASE[tx.phase]
  const broken = tx.phase === 'failed'

  return (
    <li
      // A refusal interrupts; a phase change waits its turn. A screen reader
      // talking over itself to say "settling" is worse than useless, and a
      // refusal that waits can be missed entirely.
      role={broken ? 'alert' : 'status'}
      aria-live={broken ? 'assertive' : 'polite'}
      className={`rounded-md border px-3 py-2 shadow-lg shadow-black/50 ${
        broken ? 'border-down/50 bg-[#1a1113]' : 'border-line-bright bg-raised'
      }`}
    >
      <div className="flex items-center gap-2">
        {pending(tx) && <Spinner />}
        <span className={`min-w-0 flex-1 truncate text-sm ${broken ? 'text-[#ffd9d9]' : 'text-ink'}`}>{tx.what}</span>
        <span className={`shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] ${phase.className}`}>
          {phase.label}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss: ${tx.what}`}
          className="shrink-0 rounded px-1 text-fainter hover:text-ink"
        >
          ×
        </button>
      </div>

      {tx.phase === 'settling' && (
        <p className="mt-1 text-[11px] leading-relaxed text-fainter">
          The block is on the network. Your balance below catches up on the next read.
        </p>
      )}

      {broken && tx.problem && (
        <p className="mt-1 text-xs leading-relaxed text-[#ffd9d9]">{tx.problem}</p>
      )}

      {broken && tx.recovery && (
        <div className="mt-1.5 flex items-start justify-between gap-2">
          <p className="text-[11px] leading-relaxed text-dim">{tx.recovery.hint}</p>
          {retryable(tx) && (
            <button
              type="button"
              disabled={busy}
              onClick={onRetry}
              className="shrink-0 rounded border border-line-bright px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink transition-colors hover:border-gold hover:text-gold disabled:cursor-not-allowed disabled:opacity-40"
            >
              {tx.attempts > 1 ? `Try again (${tx.attempts})` : 'Try again'}
            </button>
          )}
        </div>
      )}
    </li>
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
