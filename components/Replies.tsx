'use client'

/**
 * The thread, and the one disclaimer on this page that is load-bearing.
 *
 * Everything else here is a block. This is not, and a launchpad is exactly the
 * place where a comment box gets mistaken for a record — "dev said he's not
 * selling" is the most expensive sentence in the genre. So the panel states what
 * it is at the top rather than in a tooltip: the registry stores this, the
 * registry can lose it, and consensus has never seen it.
 *
 * What the signature buys is narrower and worth having on its own. A reply is
 * signed by the wallet that wrote it, so nobody can post as the creator, and a
 * creator's promise is at least provably theirs. It still is not a commitment
 * the chain can enforce, and the badge below says exactly that much and no more.
 */

import { useState } from 'react'

import { formatAge, shortAddress } from '../shared/format'
import type { Listing } from '../shared/listing'
import type { Reply } from '../shared/social'
import { REPLY_MAX } from '../shared/social'
import { useMarket } from '../lib/use-market'

export function Replies({
  listing,
  replies,
  onPosted,
}: {
  listing: Listing
  replies: Reply[]
  onPosted: () => void
}) {
  const { trader, busy, act } = useMarket()
  const [draft, setDraft] = useState('')

  const post = (): void => {
    const text = draft
    void act('Posting', async () => {
      await trader?.reply(listing.asset, text)
      setDraft('')
      onPosted()
    })
  }

  return (
    <section className="panel p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="eyebrow">Replies</h3>
        <span
          title="Replies are stored by the registry, not written to the chain. They are signed, so authorship is provable; they are not blocks, so consensus knows nothing about them and they are lost when the chain resets."
          className="cursor-help rounded border border-line px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-fainter"
        >
          off-chain · signed
        </span>
      </div>

      {replies.length === 0 ? (
        <p className="py-4 text-center text-xs text-fainter">Nothing said about this one yet.</p>
      ) : (
        <ul className="mt-2.5 max-h-80 space-y-2.5 overflow-y-auto pr-1">
          {replies.map((reply) => {
            const author =
              reply.author === listing.creator ? 'creator' : reply.author === trader?.address ? 'you' : null
            return (
              <li key={reply.id} className="border-l-2 border-line pl-2.5">
                <div className="flex items-baseline gap-1.5">
                  <span
                    title={reply.author}
                    className={`font-mono text-[10px] ${reply.author === trader?.address ? 'text-gold' : 'text-fainter'}`}
                  >
                    {shortAddress(reply.author, 4)}
                  </span>
                  {author && (
                    <span
                      className={`rounded border px-1 font-mono text-[9px] uppercase tracking-[0.08em] ${
                        author === 'creator' ? 'border-gold/50 text-gold' : 'border-line text-fainter'
                      }`}
                    >
                      {author}
                    </span>
                  )}
                  <span className="ml-auto font-mono text-[10px] text-fainter tabular">{formatAge(reply.at)}</span>
                </div>
                <p className="mt-0.5 break-words text-xs leading-snug text-dim">{reply.body}</p>
              </li>
            )
          })}
        </ul>
      )}

      <div className="mt-3 border-t border-line pt-3">
        <textarea
          value={draft}
          rows={2}
          maxLength={REPLY_MAX}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && draft.trim()) post()
          }}
          aria-label={`Reply about ${listing.symbol}. Signed with your wallet key.`}
          placeholder="Say something. It will be signed with your wallet key."
          className="w-full resize-y rounded-md border border-line bg-floor px-2.5 py-2 text-xs placeholder:text-fainter focus:border-line-bright"
        />
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] text-fainter tabular">
            {draft.length}/{REPLY_MAX}
          </span>
          <button
            type="button"
            disabled={busy || !draft.trim() || !trader}
            onClick={post}
            className="btn-quiet px-2.5 py-1 text-xs"
          >
            Sign and post
          </button>
        </div>
      </div>
    </section>
  )
}
