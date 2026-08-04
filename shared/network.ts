/**
 * Which chain this is, said out loud.
 *
 * The most expensive thing a demo like this can do is be vague about what is
 * underneath it. A launchpad is a genre in which people lose money, and a page
 * that lets somebody wonder whether the coins are real has already failed at the
 * only part that is not a joke. So the network is not a build-time constant
 * buried in a config: it is a value the server reports, the client renders in the
 * bar, and this file describes in words that do not need a footnote.
 *
 * Three modes exist and only two can be selected.
 *
 *   mock      A single-process chain. Local dev resets; the deployed demo
 *             replays its Durable Object event log after eviction.
 *   testnet   A real Kei network, over HTTP, with real blocks and real
 *             consensus — and coins that are still worth nothing, because a
 *             testnet is a testnet.
 *   mainnet   Refused. Not "not yet implemented" — refused, on the record, with
 *             the reasons named. See `MAINNET_GATES`.
 *
 * `scripts/testnet-probe.ts` is the other half of this file: it checks whether a
 * given node can actually carry the market before anybody points the demo at it,
 * and `readiness` here is what turns its steps into an answer.
 */

export type NetworkMode = 'mock' | 'testnet' | 'mainnet'

/** The project's one public node (SPEC §15, "Public node policy"). */
export const PUBLIC_TESTNET_RPC = 'https://testnet.keicoin.org/rpc'

export interface NetworkDescription {
  mode: NetworkMode
  /** Two or three words, for a badge in a bar that is already crowded. */
  label: string
  /** One sentence, complete on its own, for a tooltip or a card. */
  summary: string
  /** The paragraph, for the page that has room to be honest at length. */
  detail: string
  /** Whether coins on it can be traded with somebody else's blocks. */
  peerToPeer: boolean
  /** Whether the demo will run against it at all. */
  selectable: boolean
  /** Loud, quiet, or refused — what a badge should look like. */
  tone: 'mock' | 'live' | 'refused'
}

export const NETWORKS: Record<NetworkMode, NetworkDescription> = {
  mock: {
    mode: 'mock',
    label: 'Mock chain',
    summary:
      'The chain under this page is a same-process mock. The deployed demo replays its no-value state after eviction; local development resets when stopped.',
    detail:
      'Blocks are real blocks and the ledger enforces every rule this demo makes a claim about — the transfer policy, the swap lock, the issuance burn. It is not a network: one process holds the whole ledger, nobody else validates anything, and there is no consensus to disagree with it. The deployed Worker rebuilds that mock from a Durable Object event log after eviction; deleting that object resets it, and local development still resets when its process stops. Persistence does not give these coins value or make the mock mainnet-ready.',
    peerToPeer: true,
    selectable: true,
    tone: 'mock',
  },
  testnet: {
    mode: 'testnet',
    label: 'Public testnet',
    summary:
      'Real blocks on the shared public Kei testnet, validated by a node this page does not run. The coins are still worth nothing.',
    detail:
      'Every offer, settlement and cancel on this page is a block on a network other people can read, written by a key in this browser and validated by a node the project runs on one box. That makes the market genuinely peer-to-peer and the price genuinely somebody else’s agreement. It does not make anything valuable: a testnet is a testnet, the faucet hands out Kei to anybody who asks, and the node is explicitly best-effort with no uptime promise (SPEC §15). Value on it is a misunderstanding, not an achievement.',
    peerToPeer: true,
    selectable: true,
    tone: 'live',
  },
  mainnet: {
    mode: 'mainnet',
    label: 'Mainnet — refused',
    summary:
      'This demo refuses to run against mainnet, and mainnet is not open. Both of those are deliberate and neither is a schedule.',
    detail:
      'A launchpad is the worst possible first thing to put on a real network: it is the one demo whose entire subject is people losing money, and it is defensible as satire precisely because the coins are worthless (SPEC §9.6). Separately, Kei mainnet is gated on questions that no amount of front-end work touches — see `MAINNET_GATES`. A configuration flag that quietly pointed this at a real network would be a bug, not a feature.',
    peerToPeer: true,
    selectable: false,
    tone: 'refused',
  },
}

/**
 * Why the mainnet option is disabled, in the words of the thing that disables it.
 *
 * Written out rather than linked because a disabled control that will not say
 * why reads as unfinished work, and this is not unfinished work — it is a
 * decision. Each entry names the section that owns it, so the claim is checkable
 * rather than atmospheric.
 */
export const MAINNET_GATES: { spec: string; gate: string; why: string }[] = [
  {
    spec: '§15.2',
    gate: 'Validator distribution',
    why: 'Ten or more unaffiliated representative operators, no single operator above 33% of online weight, and the project itself below 34%. Until then Kei is a testnet with real branding and no real value belongs on it.',
  },
  {
    spec: '§15.1',
    gate: 'Threshold modelling',
    why: 'The 51% quorum and 66% approval that gate a reserve release were chosen before anybody modelled turnout, against a supply that is 72% project-held at launch. They are parameters, and they have not been set.',
  },
  {
    spec: '§15.3',
    gate: 'Stale proposals',
    why: 'A proposal that never reaches quorum stays votable indefinitely, and both levers that bound it — one live proposal at a time, and withdrawal — are held by the party seeking the release.',
  },
  {
    spec: '§17',
    gate: 'The legal conversation',
    why: 'Anything cash-out shaped ships disabled until it has happened. Mainnet is when value becomes real, so mainnet is when that stops being hypothetical.',
  },
  {
    spec: '§9.6',
    gate: 'A launchpad is the wrong first thing',
    why: 'Even with every gate above cleared, this particular demo would not be the thing to put on a real network. It is a joke about losing money and it needs the coins to be worthless to stay one.',
  },
]

/** The mode name, or `undefined` if the string is not one. */
export function parseMode(input: unknown): NetworkMode | undefined {
  return input === 'mock' || input === 'testnet' || input === 'mainnet' ? input : undefined
}

export class NetworkRefused extends Error {}

/**
 * Turn whatever the environment says into a mode the demo will actually run.
 *
 * Mainnet throws rather than falling back, in the same way `Kei.server()` refuses
 * a browser (SPEC §6.3): a misconfiguration that silently degrades is a
 * misconfiguration nobody finds. An unknown name throws for the same reason —
 * `CARPET_NETWORK=tesnet` quietly serving a mock is exactly the failure this
 * whole file exists to prevent.
 */
export function resolveMode(input: unknown): NetworkMode {
  if (input === undefined || input === null || input === '') return 'mock'
  const mode = parseMode(input)
  if (!mode) {
    throw new NetworkRefused(
      `"${String(input)}" is not a network. This demo runs on "mock" or "testnet"; see shared/network.ts.`,
    )
  }
  if (mode === 'mainnet') {
    throw new NetworkRefused(
      'Carpet Markets refuses to run against mainnet. A launchpad is the worst possible first thing to put on a real ' +
        'network — it is the one demo whose entire subject is people losing money, and it is defensible as satire only ' +
        'while the coins are worthless (SPEC §9.6). Kei mainnet is separately gated on questions no front end touches: ' +
        `${MAINNET_GATES.map((gate) => `${gate.gate} (SPEC ${gate.spec})`).join(', ')}.`,
    )
  }
  return mode
}

/**
 * What the client is told about the chain it is talking to.
 *
 * It travels with `/market/facts` rather than being baked into the bundle,
 * because the bundle is built once and the server it is served beside can be
 * pointed somewhere else afterwards. A badge derived from a build-time constant
 * would keep saying "mock" the first time somebody deployed it against a real
 * node, which is the single most damaging thing it could get wrong.
 */
export interface NetworkFacts {
  mode: NetworkMode
  /** What the SDK calls it, which is not always what this file calls it. */
  sdkNetwork: string
  /** The node URL, when there is one to name. Null for an in-process mock. */
  node: string | null
  /** Whether this serving mode loses its ledger when its process is replaced. */
  ephemeral: boolean
}

// ------------------------------------------------------------- readiness report

export interface ProbeStep {
  id: string
  what: string
  ok: boolean
  detail: string
  ms: number
}

export interface ProbeReport extends ProbeVerdict {
  node: string
  at: number
  ms: number
  vendor: string | null
  network: string | null
  steps: ProbeStep[]
}

export interface ProbeVerdict {
  ready: boolean
  verdict: string
  missing: string[]
}

/**
 * The steps a network has to pass before this demo can honestly run on it.
 *
 * This list is the definition of "the M5 swap calls work here", and it is a list
 * rather than a boolean because the failures are not interchangeable. A node
 * that serves `swap_info` and has a dry faucet needs somebody to fund an
 * address; a node that does not serve `swap_info` needs a different node.
 */
export const REQUIRED_STEPS: readonly string[] = [
  'rpc.version',
  'rpc.work_thresholds',
  'rpc.swap_info',
  'sdk.connect',
  'rpc.faucet',
  'op.issue',
  'op.mint',
  'op.swap_offer',
  'op.offers_read',
  'op.swap_accept',
  'op.swap_cancel',
  'op.price',
  'policy.soulbound',
]

export function readiness(steps: readonly ProbeStep[]): ProbeVerdict {
  const passed = new Set(steps.filter((step) => step.ok).map((step) => step.id))
  const missing = REQUIRED_STEPS.filter((id) => !passed.has(id))

  if (missing.length === 0) {
    return {
      ready: true,
      verdict:
        'this node carries the whole market path: issue, mint, offer, accept, cancel, price history, and the policy refusal',
      missing,
    }
  }

  return {
    ready: false,
    verdict: `${missing.length} required step${missing.length === 1 ? '' : 's'} did not pass: ${missing.join(', ')}`,
    missing,
  }
}
