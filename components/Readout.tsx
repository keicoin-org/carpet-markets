/**
 * A figure, or the reason there is not one.
 *
 * One component for every number on the coin page, because the alternative is
 * eleven grid cells each deciding for itself what to do when the chain has
 * nothing to say — and two of them decided `0`, on a page whose argument is that
 * it does not invent numbers (SPEC §9.6, criterion 4).
 *
 * The three states get three renderings and none of them is a bare figure:
 *
 *   pending  a dash in the faintest ink, marked `aria-busy`. Two seconds at most,
 *            and never confusable with an answer, because it is not one.
 *   absent   the sentence, in words, in the slot where the number would be.
 *            "never traded", not "—", and certainly not "0".
 *   known    the figure, tabular so a ticking board does not reflow.
 *
 * The hint on every metric is real prose and it is not hidden in a `title`: a
 * tooltip is unreachable by keyboard and invisible on a phone, and these explain
 * where a number came from, which is the part a reader is entitled to. It is in
 * the disclosure under the grid instead — one tab stop for eleven definitions.
 */

import type { Metric, MetricContext } from '../lib/metrics'
import type { Reading } from '../lib/readings'

export function Readout({ metric, context }: { metric: Metric; context: MetricContext }) {
  const reading = metric.read(context)
  return (
    <div className="min-w-0">
      <dt className="eyebrow truncate" title={metric.hint}>
        {metric.label}
      </dt>
      <dd className="mt-0.5 min-w-0">
        <Value reading={reading} personal={metric.personal === true} />
      </dd>
    </div>
  )
}

function Value({ reading, personal }: { reading: Reading<string>; personal: boolean }) {
  if (reading.state === 'pending') {
    return (
      <span className="font-mono text-sm text-fainter tabular" aria-busy="true">
        <span aria-hidden>—</span>
        <span className="sr-only">still reading</span>
      </span>
    )
  }

  if (reading.state === 'absent') {
    // Not `tabular`: this is a sentence, and tabular figures on prose widen the
    // spaces. Not `text-down` either — an absence is not an error.
    return <span className="block break-words font-mono text-sm text-fainter">{reading.why}</span>
  }

  return (
    <span className={`block break-words font-mono text-sm tabular ${personal ? 'text-gold' : 'text-ink'}`}>
      {reading.value}
    </span>
  )
}

/**
 * What every figure above reads, once, for whoever wants to know.
 *
 * Collapsed by default because the board is dense and the definitions are for
 * the second visit. Open, it is the only place on the page that says which of
 * these numbers came off a settled block and which came off an intention.
 */
export function ReadoutKey({ metrics }: { metrics: readonly Metric[] }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer select-none text-fainter hover:text-dim">What each of these reads</summary>
      <dl className="mt-2 space-y-1.5 border-l border-line pl-3">
        {metrics.map((entry) => (
          <div key={entry.id}>
            <dt className="eyebrow">{entry.label}</dt>
            <dd className="mt-0.5 leading-relaxed text-fainter">{entry.hint}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
