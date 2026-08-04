# Durable mock log: bounds, checkpoints, and recovery

The public mock has one authority: accepted inputs in the named `Floor` Durable
Object. The ledger, registry, and reply threads in memory are disposable and are
rebuilt from that authority after eviction.

This change adds a **replay checkpoint**, not a `MockLedger` state snapshot.
That distinction is operationally important. `@keicoin/core` 0.3.0 has no
supported export/import API for the mock ledger, so the checkpoint stores the
same accepted inputs in immutable, hash-verified chunks. It reduces row
overhead, folds only state with proven set/bounded-tail semantics, and gives the
log a hard admission bound once compaction is explicitly enabled. It cannot
collapse the signed block history into a constant-size ledger state. When that
canonical bound is reached, reads continue and a mutation is refused before its
pending WAL row is written. A retry of an already accepted signed `process`
block is the exception: the ledger returns the prior hash without allocating
another sequence or WAL row.

## Measured envelope and limits

Measured on 2026-08-04 on Windows with Bun 1.3.0,
`@cloudflare/vitest-pool-workers` 0.20.1, Wrangler 4.118.0, and workerd
1.20260730.1. The workload is `test/worker-runtime/floor.runtime.ts` running in
the Workers runtime against the configured SQLite-backed `FLOOR`, not the fast
fake-storage harness.

| Workload | Accepted events | Serialized bytes | Cold replay |
|---|---:|---:|---:|
| deterministic six-coin seed | 1 | 164 | 26.230-26.368 s |
| seed + first buy/reply + eight ordinary signed payment blocks | 15 | 8,930 | 28.291-30.018 s |
| seed + 15 unique watches, active checkpoint | 16 | 1,930 | 34.622 s |
| same 16-event authority, damaged active generation and predecessor recovery | 16 | 1,930 | 33.173 s |

Across those six cold samples, p50 was 29.155 s, p95 was 34.622 s, and max was
34.622 s (nearest-rank p95; this is a small reproducibility fixture, not a load
test). The measured accepted event sizes in the first-buy flow were: seed 164
bytes, watch 157 bytes, reply 461 bytes, and RPC 228-836 bytes. The runtime test
fills the final mixed boundary with ordinary signed send/receive blocks; its
current numbers must be copied here if that fixture changes.

The policy is deliberately below the platform's storage ceiling:

- request body: 4,096 bytes (about 4.9 times the largest measured accepted RPC);
- replay authority: 16 accepted events and 16,384 serialized bytes;
- persisted compact-mode `event:v1` working set: 16 rows and 32,768 bytes;
- automatic checkpoint: every 8 accepted tail events;
- cold replay target: at most 60 seconds in the pinned runtime workload.

In `compact` mode both replay dimensions apply to the canonical accepted
authority, after safe process/watch/reply folding. The separate raw dimensions
are measured from the actual persisted `event:v1` prefix before every new
mutation, including rows an active checkpoint covers and replay no longer sees.
Raw legacy duplicates and a removable pending WAL row therefore cannot brick
boot, while persistent cleanup failure cannot grow hidden rows across evictions.
The event that reaches the 8-event checkpoint threshold remains accepted in v1
authority, but if generation verification, pointer activation, or cleanup fails,
later new mutations get HTTP 507 without allocating a sequence or row. An exact
complete-envelope retry of an accepted `process` block remains available because
it needs no new authority. There is no silent
truncation. An over-limit compact-mode mutation likewise gets HTTP 507 and says
that the ledger did not accept it; an oversized request gets HTTP 413 before a
durable row is written in either mode. The limits are small because the
deterministic bootstrap already owns most of the cold-start budget. Raising them
requires a new runtime measurement or a supported `MockLedger` state import,
not only more Durable Object storage.

## Storage protocol

The deployed rows remain readable:

- `event:v1:<sequence>`: pending/accepted WAL event;
- `meta:event-sequence:v1`: monotonic sequence, including harmless gaps.

Checkpoint-aware versions additionally use:

- `checkpoint:v2:<generation>:chunk:<index>`: immutable arrays of accepted v1
  events, each targeted below 128 KiB;
- `checkpoint:v2:<generation>:manifest`: event count/bytes, public registry
  identity, covered sequence, chunk count, and SHA-256;
- `meta:checkpoint:v2`: one atomic pointer containing the active and previous
  verified manifests.

The compaction sequence is:

1. Canonicalise accepted signed `process` retries, duplicate `watch` inputs, and
   replies older than the existing 100-per-asset thread tail. A `process` retry
   is identified by canonical JSON of the complete block envelope, including
   `work` and `signature`, so whitespace/key order cannot buy a second row but an
   unsigned or conflicting envelope is never silently granted success. A body
   the ledger already holds with a different envelope is explicitly refused
   before WAL admission. Never rewrite distinct RPC, seed, or launch order.
2. Write immutable chunks and their manifest as an inactive generation.
3. Validate every manifest field against the replay schema and its hard chunk
   bound before deriving chunk keys, then read every chunk back and verify count,
   bytes, registry identity, and digest. Corrupt active metadata falls back to a
   separately verified predecessor or the complete v1 seed log without making
   an attacker-sized key allocation or multi-key read.
4. Atomically switch the one pointer, retaining the old active manifest as the
   predecessor.
5. Delete only v1 rows covered by that retained predecessor, then remove
   generations older than active/previous.

A crash before step 4 leaves v1/the old pointer authoritative. A crash after
step 4 leaves the new verified generation authoritative. On the next compact
boot, a verified active/predecessor pair retries only the idempotent cleanup it
already authorises before admitting traffic; a persistent cleanup error latches
HTTP 507 again, so eviction cannot reopen unbounded writes. If the active chunks
later fail verification, boot uses the previous checkpoint plus the surviving
v1 tail and skips cleanup. Pending WAL events remain in that tail and retain the
existing accept-or-delete replay behavior.

Application and WAL acceptance are also separate failure boundaries. The Floor
normally holds one serving authority. If pinned `MockLedger` returns a late
refusal after consuming a receivable, that authority is removed from service and
closed, and accepted durable history is replayed into a fresh replacement before
the rejected pending row may be deleted. Mock reads share the mutation queue, so
they see the replacement or HTTP 503, never the rejected side effect. Failure to
rebuild or to verify deletion preserves the pending row and latches new mutations
until recovery. Boot replay uses the same rebuild-before-delete order and returns
only a fresh accepted-history authority (or no authority) if cleanup remains
unresolved. Once application succeeds, failure to rewrite its row from `pending`
to `accepted` also never deletes that row: reads remain available, the applied
instance refuses further new mutations with HTTP 503, and a later cold instance
applies the retained pending row once before completing acceptance.

## Two-release rollout and rollback floor

`wrangler.jsonc` intentionally ships `CARPET_LOG_MODE="compat"`. Do not change
that in the first deployment. The only accepted values are exact `compat` and
`compact`; a missing value defaults to `compat`, while any other value refuses
traffic before writing mock authority.

1. Deploy the checkpoint-aware code in `compat`. It reads v1 and v2, preserves
   ordinary user mutations in the existing v1 WAL, applies only the 4 KiB input
   bound, and emits canonical **and raw** counts/bytes. It does not checkpoint or
   delete an accepted row. Record the Worker version and verify ordinary
   first-buy/eviction behavior.
2. Make that exact checkpoint-aware Worker version the rollback floor. A version
   older than this change must not be selected after compaction begins because
   it cannot read a v2 checkpoint.
3. Inspect live logs before changing configuration. Canonical accepted authority
   must be at or below 16 events and 16,384 bytes, and measured replay must be
   below 60 seconds. If any condition fails, do **not** enable compaction; keep
   `compat` and require a higher measured bound or a state-snapshot migration.
4. In a separate reviewed configuration deployment, change the mode to
   `compact`. The binary rechecks the canonical bound before activation. If it
   is over, reads remain available, activation emits `activation-refused`, no
   checkpoint/deletion occurs, and new mutations return 507 until configuration
   returns to `compat`. Observe two successful generations before calling
   storage reclaimed; the first generation intentionally keeps the complete v1
   log. If that legacy log is already beyond the compact raw bound but remains
   canonically safe, boot writes and verifies the immediate successor generation
   needed to reclaim it before admitting a new mutation.
5. Roll back only to the checkpoint-aware floor (with `compat` if compaction
   needs to pause). It reads the active checkpoint and continues appending a v1
   tail without deleting more history.

Every boot and accepted mutation emits structured `durable-log` records. Raw
metrics describe migration cost; `events`/`bytes` describe canonical authority.
Alert
on replay time approaching 60 seconds, either replay bound approaching 80%, any
`compaction` record with `ok:false`, or `recoveredFrom` being non-null. Records
include event count/bytes by kind, accepted bytes for the request and trailing
minute, actual persisted raw rows/bytes, tail count, checkpoint generation,
replay time, and all active limits. `reclaim` records distinguish completed,
skipped, and failed post-activation cleanup. After a failed compaction or
reclamation, preserve the object and repair the cause; new mutations deliberately
remain fail-closed until a later cold boot can verify and finish the authorised
cleanup or checkpoint successfully.

## Recovery and reset

If the active generation is unreadable, first confirm the automatic predecessor
recovery record and stop compaction by returning to the checkpoint-aware
`compat` configuration. Preserve the object before changing anything. If both
manifests fail verification and a complete v1 seed log remains, boot uses it. If
neither authority is complete, restore the object with Cloudflare Durable
Object point-in-time recovery to a bookmark/time before the failed write and
verify the public registry address plus the full lifecycle test.

Deleting/resetting the named object is not compaction. It loses the mock chain,
all launches, offers, trades, discovered accounts, signed replies, and the
stored public registry identity. It is an explicit emergency product decision,
not an automatic recovery step.

## What unlocks a larger service

A future `@keicoin/core` API can export a canonical JSON-safe `MockLedger`
snapshot and import it only after schema/version/digest validation. With that
API, Carpet Markets can checkpoint ledger state and retain a short signed tail,
then compare listings, asset IDs, books, trades, holders, replies, and a new
first buy before advancing the pointer. Until then, this bounded replay
checkpoint is intentionally a small no-value demo policy, not a scalable ledger
database.
