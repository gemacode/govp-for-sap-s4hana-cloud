import type { SapInboundDelivery, SapOutboundDelivery } from './types.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
});

function deliveryKey(pathname: string) {
  const decoded = decodeURIComponent(pathname);
  return decoded.match(/A_(?:Outb|Inb)DeliveryHeader\('([^']+)'\)/)?.[1]?.replaceAll("''", "'");
}

export function createSapS4Simulator(seed?: { outbound?: SapOutboundDelivery[]; inbound?: SapInboundDelivery[] }) {
  const outbound = new Map((seed?.outbound ?? []).map((item) => [item.DeliveryDocument, structuredClone(item)]));
  const inbound = new Map((seed?.inbound ?? []).map((item) => [item.DeliveryDocument, structuredClone(item)]));
  const patches = new Map<string, Record<string, string>>();
  let patchFailures = 0;
  let requests = 0;

  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    requests += 1;
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init.method ?? 'GET';
    const key = deliveryKey(url.pathname);
    if (method === 'GET' && url.pathname.includes('A_OutbDeliveryHeader') && key) {
      const value = outbound.get(key);
      if (!value) return json({ error: { message: { value: 'Outbound Delivery not found' } } }, 404);
      const headers = new Headers(init.headers);
      const responseHeaders: Record<string, string> = headers.get('x-csrf-token')?.toLowerCase() === 'fetch' ? { 'x-csrf-token': 'sim-csrf-token', etag: 'W/"1"' } : {};
      return json({ d: structuredClone(value) }, 200, responseHeaders);
    }
    if (method === 'PATCH' && url.pathname.includes('A_OutbDeliveryHeader') && key) {
      if (patchFailures > 0) {
        patchFailures -= 1;
        return json({ error: { message: { value: 'Temporary SAP failure' } } }, 503);
      }
      const headers = new Headers(init.headers);
      if (headers.get('x-csrf-token') !== 'sim-csrf-token') return json({ error: { message: { value: 'CSRF token invalid' } } }, 403);
      patches.set(key, JSON.parse(String(init.body ?? '{}')) as Record<string, string>);
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && url.pathname.includes('A_InbDeliveryHeader') && key) {
      const value = inbound.get(key);
      return value ? json({ d: structuredClone(value) }) : json({ error: { message: { value: 'Inbound Delivery not found' } } }, 404);
    }
    return json({ error: { message: { value: 'Route not simulated' } } }, 404);
  };

  return {
    fetch,
    putOutbound: (delivery: SapOutboundDelivery) => outbound.set(delivery.DeliveryDocument, structuredClone(delivery)),
    putInbound: (delivery: SapInboundDelivery) => inbound.set(delivery.DeliveryDocument, structuredClone(delivery)),
    failNextPatches: (count = 1) => { patchFailures = Math.max(0, count); },
    patchedFields: (deliveryDocument: string) => structuredClone(patches.get(deliveryDocument)),
    requestCount: () => requests,
  };
}
