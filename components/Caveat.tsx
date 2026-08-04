/**
 * One of the demo's known holes, rendered where it bites.
 *
 * SPEC §9.6 criterion 9 asks for exactly this and says why the README is not
 * enough: nobody reading an order book is reading the README. The sentences live
 * in `shared/caveats.ts` so the set is checkable — `test/caveats.test.ts` fails
 * if a registered hole has no render site — and so that the same limit reads
 * identically wherever it appears.
 *
 * Deliberately quiet type on a left rule rather than a warning box. These are not
 * warnings: an account-list-bounded book is the correct behaviour of a chain that
 * ships no indexer, and dressing it as an error would teach the wrong lesson
 * about the design it demonstrates.
 */

import { caveat, type CaveatId } from '../shared/caveats'

export function Caveat({ id, className = '' }: { id: CaveatId; className?: string }) {
  const hole = caveat(id)
  return (
    <p className={`border-l-2 border-line pl-2.5 text-[11px] leading-relaxed text-fainter ${className}`}>
      {hole.says}
      {hole.spec && <span className="ml-1 whitespace-nowrap font-mono text-[10px]">({hole.spec})</span>}
    </p>
  )
}
