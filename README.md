# Carpet Markets

A coin launchpad, in the pump.fun shape: anybody can launch a token in one
click, it trades against a bonding curve, the price goes up while people buy and
down while they sell, and if enough money ends up in the reserve the coin
graduates and leaves.

The difference is the deed.

```sh
bun install
bun run dev          # http://localhost:7788
```

> **This is a demo.** The chain underneath is an in-memory mock served by the
> same process. It dies when you stop the server, every coin you can launch on it
> is worthless by construction, and that is exactly what makes it safe to show
> you how a rug pull works from the inside.

## The point

Every coin here has a **deed**: one item, minted to whoever launched it. The deed
is the authority to take the reserve, and taking the reserve means sending the
deed back to the market. So "can this coin be rugged?" is not a promise anybody
makes. It is the deed's transfer policy — chosen at launch, enforced by
consensus, and immutable afterwards (SPEC §5.4):

| | The deed | What it means |
|---|---|---|
| **Carpet** | `transfer: 'open'` | It can be sent back. The reserve can be taken. It probably will be. |
| **Nailed down** | `transfer: 'none'` | Soulbound. There is no message anybody can sign that moves the reserve out. |

A database can hold the same flag. A developer can edit the row. That is the
whole difference, and it is why the rug is a mechanic in this game rather than a
warning printed above it: a player can read the badge, buy the carpet coin
anyway, watch the creator empty it, and check afterwards that the chain said so
the entire time.

The market never claims a coin is safe. It shows you what was issued.

## The loop

| | |
|---|---|
| **Launch** | Name a coin, pick its deed, pay the fee. You get the deed. |
| **Buy** | Send Kei. The curve prices it, the market mints, the change comes back. |
| **Sell** | Send coins back. The curve pays you and the coins are burned. |
| **Graduate** | Cross 10 Kei of reserve and the curve closes for good. Holders get a badge. |
| **Rug** | Send the deed back. The whole reserve is yours. Only if the deed transfers. |

### The curve

Linear in supply — `price = 0.00000006 + 0.00000000006 × sold` — over a million
coins, so the last one costs about a thousand times the first and filling the
whole curve takes about 30 Kei. Linear rather than the constant-product curve an
AMM would use, because you can check this one by hand.

There is no spread and no fee. Buying `n` and selling `n` back returns exactly
what it cost, which `test/curve.test.ts` asserts, because a market maker that
quietly skimmed would be a more realistic toy and a worse explanation.

The reserve is never a running total. It is recomputed from supply every time it
matters, so a dropped update makes a payout wrong by nothing instead of by an
accumulated drift.

### The launch fee is real

Issuing an asset burns Kei, and the nth asset an account issues burns n Kei
(SPEC §5.6.5). A launch issues two — the coin and its deed — so it costs the nth
burn plus the (n+1)th, and **every launch on this market costs more than the last
one, forever**. The first is about 3 Kei. The fiftieth is over 100.

That is charged to the launcher because it is real: the Kei is destroyed, not
collected. It is also the only reason this market cannot become the thing it is
making fun of — there is no rate limit that works on free keypairs, but issuance
is the one cost an account cannot shed.

### Why graduation exists

A graduated coin is out of the building. The curve closes, the reserve is locked
for everybody including the deed holder, and the coin only moves between players
from then on — which it can, because its transfer policy said so at issuance and
nothing has changed since.

It is delivered as **one** commit covering every holder, which each of them then
claims from their own chain (SPEC §5.5). A mint per holder would put the whole
market behind one account's chain and the queue would become the game.

## Where things are

```
shared/curve.ts       the bonding curve. Pure, integer, and the only place a price is decided.
shared/listing.ts     the wire shape, and what a valid coin identity is.
server/market.ts      the issuer: coins, deeds, the curve, the rug. The whole backend.
server/main.ts        one Bun server: the mock node at /rpc, the market at /market/*, the client at /
src/market-client.ts  every line of Kei in the client.
src/main.ts           the market floor.
src/ui.ts             elements and the chart.
```

`src/market-client.ts` is the file to read if you are here to learn the SDK.
`server/market.ts` is the file to read if you are here to learn what a game
server still has to do when it does not own the money.

## No database

There is no `users` table, no `balances` table, no `holdings` table, and no save
file. Who holds which coin is a question the chain answers, and asking it is
`balanceOf`.

What is in memory is the part the chain has no opinion about: which coins exist,
who launched them, and which quotes are outstanding. Stop the process and that is
gone — along with the mock chain it was describing, so nothing is left dangling.

## Three things worth stealing

Written down because each one cost an afternoon.

- **A payment event carries a JS number.** `PaymentEvent.amount` is a `double`,
  and a double cannot hold eighteen decimal places: a fee of exactly 7.1 Kei
  arrives as `7.099999999999999645`. An equality check against a quote therefore
  rejects real payments. Quote conservatively, accept a documented dust
  tolerance, charge from your own arithmetic, and refund the change.
- **Minted coins are a receivable, not a balance.** They are owed until the
  recipient's wallet signs for them. Selling before `sync()` fails with
  "balance is 0", which is correct and reads like a bug in the market.
- **A commit publishes a root; it does not deliver anything.** The entitlement is
  worth nothing until the holder gets a proof and writes their own claim. Someone
  has to hand the proof over — here that is `GET /market/claims`.

## Honest about what this is not

- **Nothing here is worth anything**, on purpose. There is no mainnet, and a game
  about rug pulls is not the place to find out what one feels like with money in
  it.
- **The market has one open quote per address.** A Kei transfer carries no memo,
  so an arriving payment says only who sent it and how much; that is enough
  exactly when an address has one outstanding quote. Two browser tabs racing is
  a thing you can do to yourself. The honest fix is a memo field in the wire
  format, not a cleverer guess on this side.
- **The market keeps unmatched payments.** Send it Kei answering no quote and it
  stays there. Reflexively refunding whoever sends money would make the market
  return its own working capital to the faucet on startup.
- **The rug is not an exploit and not a bug.** It is the documented behaviour of
  a transferable deed. If you would like it to be impossible, that is the other
  radio button, and it is impossible at the ledger rather than here.
- **A graduated coin has no market.** The curve is closed and Kei's swap desk is
  not merged yet, so it transfers peer-to-peer and nothing quotes it. That is
  what graduating actually means in a game with no exchange to graduate to.

## Checks

```sh
bun test          # the curve, and the whole economy against a real ledger
bun run typecheck
```

`test/market.test.ts` is where the claim on the badge is either true or
marketing. It asserts at the ledger that a soulbound deed cannot be sent back,
that a transferable one empties the reserve to whoever holds it, and that a
holder of a rugged coin still holds every coin they bought — because they always
did, and owning them never meant they were worth anything.

MIT.
