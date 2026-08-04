import { HttpNode } from '@keicoin/core'

export interface FloorLike {
  fetch(request: Request): Promise<Response>
}

export function call(floor: FloorLike, path: string, body?: unknown): Promise<Response> {
  return floor.fetch(
    new Request(`https://example.test/examples/carpet-markets${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }),
  )
}

export async function answer<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { error?: string } & T
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

export function nodeFor(floor: FloorLike): HttpNode {
  return new HttpNode({
    url: 'https://example.test/examples/carpet-markets/rpc',
    network: 'mock',
    pollInterval: 60_000,
    fetch: ((input, init) => floor.fetch(new Request(input, init))) as typeof fetch,
  })
}
