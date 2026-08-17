import { beforeEach, describe, expect, it } from 'vitest';
import { GovpExchangeClient, registerConnector } from '@gemacode/govp-connector-kit';
import { createExchangeSimulator } from '@gemacode/govp-connector-kit/simulator';
import {
  MemoryGovpLinkStore,
  SapApiClient,
  SapS4HanaGovpConnector,
  createSapS4Simulator,
  deliveryValidUntil,
  deliveryEvidenceSha256,
  oauthClientCredentials,
  type SapBusinessEvent,
  type SapOutboundDelivery,
} from './index.js';

const outbound = (status = 'C'): SapOutboundDelivery => ({
  DeliveryDocument: '80000001',
  ActualGoodsMovementDate: status === 'C' ? '2026-08-16T00:00:00Z' : null,
  OverallGoodsMovementStatus: status,
  ShipToParty: '1000001',
  to_DeliveryDocumentItem: { results: [
    { DeliveryDocument: '80000001', DeliveryDocumentItem: '20', Material: 'MAT-B', Batch: 'LOT-2', ActualDeliveryQuantity: '2', DeliveryQuantityUnit: 'EA' },
    { DeliveryDocument: '80000001', DeliveryDocumentItem: '10', Material: 'MAT-A', Batch: 'LOT-1', ActualDeliveryQuantity: '1', DeliveryQuantityUnit: 'EA' },
  ] },
});

const event = (overrides: Partial<SapBusinessEvent> = {}): SapBusinessEvent => ({
  id: 'evt-80000001-1',
  time: '2026-08-16T12:00:00.000Z',
  type: 'sap.s4.beh.outbounddelivery.v1.OutboundDelivery.Changed.v1',
  source: '/default/sap.s4.beh/000000000000000000',
  data: { DeliveryDocument: '80000001' },
  ...overrides,
});

describe('GOVP for SAP S/4HANA Cloud', () => {
  let sapSimulator: ReturnType<typeof createSapS4Simulator>;
  let exchangeSimulator: ReturnType<typeof createExchangeSimulator>;

  beforeEach(() => {
    sapSimulator = createSapS4Simulator({
      outbound: [outbound()],
      inbound: [{ DeliveryDocument: '18000001', Supplier: '2000001', to_DeliveryDocumentItem: { results: [{ DeliveryDocument: '18000001', DeliveryDocumentItem: '10', Material: 'MAT-A' }] } }],
    });
    exchangeSimulator = createExchangeSimulator();
  });

  async function connector(mode: 'observe' | 'issue' = 'issue', fields = true, validityDays?: number) {
    const registration = await registerConnector('http://localhost', { platform: 'sap_s4hana_cloud', label: 'SAP CI', siteUrl: 'https://example.invalid' }, exchangeSimulator.fetch);
    const exchange = new GovpExchangeClient({ baseUrl: 'http://localhost', token: registration.apiToken, fetch: exchangeSimulator.fetch, retryBaseMs: 0 });
    const sap = new SapApiClient({ baseUrl: 'http://localhost', auth: async () => ({ Authorization: 'Bearer sim' }), fetch: sapSimulator.fetch, retryBaseMs: 0 });
    const store = new MemoryGovpLinkStore();
    const instance = new SapS4HanaGovpConnector({
      mode,
      systemId: 'SAP-CI-1',
      issuerName: 'Empresa SAP ficticia',
      validityDays,
      ...(fields ? { govpCodeField: 'YY1_GOVPCode_DLH', govpStatusField: 'YY1_GOVPStatus_DLH', govpVerifyUrlField: 'YY1_GOVPVerifyURL_DLH' } : {}),
    }, sap, exchange, store);
    return { instance, store, exchange };
  }

  it('genera una huella estable aunque SAP devuelva las posiciones en otro orden', () => {
    const original = outbound();
    const reversed = structuredClone(original);
    const relation = reversed.to_DeliveryDocumentItem as { results: Array<{ ActualDeliveryQuantity?: string }> };
    relation.results = [...relation.results].reverse();
    expect(deliveryEvidenceSha256(original)).toBe(deliveryEvidenceSha256(reversed));
    relation.results[0]!.ActualDeliveryQuantity = '99';
    expect(deliveryEvidenceSha256(original)).not.toBe(deliveryEvidenceSha256(reversed));
  });

  it('mantiene Observe como modo seguro por defecto operativo', async () => {
    const { instance, store } = await connector('observe');
    await expect(instance.handleOutboundEvent(event())).resolves.toMatchObject({ outcome: 'observed' });
    expect((await store.get('80000001'))?.code).toBeUndefined();
    expect(sapSimulator.patchedFields('80000001')).toBeUndefined();
  });

  it('emite, enlaza en campos de extensibilidad y evita duplicados', async () => {
    const { instance, exchange } = await connector();
    const first = await instance.handleOutboundEvent(event());
    expect(first).toMatchObject({ outcome: 'linked', deliveryDocument: '80000001' });
    expect(first.code).toMatch(/^SIM-/);
    expect(sapSimulator.patchedFields('80000001')).toEqual({
      YY1_GOVPCode_DLH: first.code,
      YY1_GOVPStatus_DLH: 'issued',
      YY1_GOVPVerifyURL_DLH: first.verifyUrl,
    });
    await expect(instance.handleOutboundEvent(event())).resolves.toMatchObject({ outcome: 'duplicate', code: first.code });
    await expect(exchange.verify(first.code!)).resolves.toMatchObject({ verification: { status: 'valid', reasonCode: 'GOVP_VALID' } });
  });

  it('mantiene idéntica la vigencia aunque el reintento suceda en otro momento', () => {
    expect(deliveryValidUntil(outbound(), 30)).toBe('2026-09-15T00:00:00.000Z');
    expect(deliveryValidUntil(structuredClone(outbound()), 30)).toBe(deliveryValidUntil(outbound(), 30));
  });

  it('rechaza periodos de vigencia inválidos antes de operar', async () => {
    await expect(connector('issue', true, 0)).rejects.toThrow('validityDays');
  });

  it('no emite antes de contabilizar la salida de mercancías', async () => {
    sapSimulator.putOutbound(outbound('A'));
    const { instance, store } = await connector();
    await expect(instance.handleOutboundEvent(event())).resolves.toMatchObject({ outcome: 'not_posted' });
    expect(await store.get('80000001')).toBeUndefined();
  });

  it('ignora eventos fuera de orden sin reemplazar el estado más reciente', async () => {
    const { instance, store } = await connector('observe');
    await instance.handleOutboundEvent(event({ id: 'newer', time: '2026-08-16T13:00:00Z' }));
    await expect(instance.handleOutboundEvent(event({ id: 'older', time: '2026-08-16T11:00:00Z' }))).resolves.toMatchObject({ outcome: 'ignored' });
    expect((await store.get('80000001'))?.eventId).toBe('newer');
  });

  it('reconcilia un enlace SAP fallido sin volver a emitir el GOVP', async () => {
    sapSimulator.failNextPatches(3);
    const { instance, store } = await connector();
    const first = await instance.handleOutboundEvent(event());
    expect(first.outcome).toBe('link_pending');
    const code = first.code;
    await expect(instance.reconcileLinks()).resolves.toEqual([expect.objectContaining({ outcome: 'linked', code })]);
    expect((await store.get('80000001'))?.status).toBe('linked');
  });

  it('comprueba un GOVP al recibir una entrega entrante', async () => {
    const { instance } = await connector('issue', false);
    const issued = await instance.handleOutboundEvent(event());
    await expect(instance.verifyInboundDelivery('18000001', issued.code!)).resolves.toMatchObject({
      deliveryDocument: '18000001', itemCount: 1, valid: true, reasonCode: 'GOVP_VALID',
    });
  });

  it('cachea el token OAuth de comunicación SAP', async () => {
    let calls = 0;
    const fetch = async () => { calls += 1; return new Response(JSON.stringify({ access_token: 'sap-token', expires_in: 300 }), { headers: { 'Content-Type': 'application/json' } }); };
    const auth = oauthClientCredentials({ tokenUrl: 'https://auth.example/token', clientId: 'id', clientSecret: 'secret', fetch });
    await expect(auth()).resolves.toEqual({ Authorization: 'Bearer sap-token' });
    await expect(auth()).resolves.toEqual({ Authorization: 'Bearer sap-token' });
    expect(calls).toBe(1);
  });
});
