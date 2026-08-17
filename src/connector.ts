import { createHash } from 'node:crypto';
import type { GovpExchangeClient } from '@gemacode/govp-connector-kit';
import type { SapApiClient } from './sap-client.js';
import type {
  EventResult,
  GovpLinkStore,
  SapBusinessEvent,
  SapConnectorConfig,
  SapDeliveryItem,
  SapInboundDelivery,
  SapOutboundDelivery,
  StoredGovpLink,
} from './types.js';

function items(value: SapOutboundDelivery | SapInboundDelivery): SapDeliveryItem[] {
  const relation = value.to_DeliveryDocumentItem;
  if (Array.isArray(relation)) return relation;
  return relation?.results ?? [];
}

function canonicalEvidence(delivery: SapOutboundDelivery) {
  return {
    deliveryDocument: delivery.DeliveryDocument,
    actualGoodsMovementDate: delivery.ActualGoodsMovementDate ?? null,
    goodsMovementStatus: delivery.OverallGoodsMovementStatus ?? null,
    shipToParty: delivery.ShipToParty ?? null,
    items: items(delivery).map((item) => ({
      item: item.DeliveryDocumentItem,
      material: item.Material ?? null,
      batch: item.Batch ?? null,
      quantity: item.ActualDeliveryQuantity ?? null,
      unit: item.DeliveryQuantityUnit ?? null,
      plant: item.Plant ?? null,
      storageLocation: item.StorageLocation ?? null,
    })).sort((left, right) => left.item.localeCompare(right.item)),
  };
}

export function deliveryEvidenceSha256(delivery: SapOutboundDelivery) {
  return createHash('sha256').update(JSON.stringify(canonicalEvidence(delivery))).digest('hex');
}

function posted(delivery: SapOutboundDelivery) {
  return delivery.OverallGoodsMovementStatus === 'C' || Boolean(delivery.ActualGoodsMovementDate);
}

function validFieldName(value: string | undefined) {
  if (!value) return undefined;
  if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value)) throw new TypeError(`Nombre de campo SAP no válido: ${value}`);
  return value;
}

function eventTime(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError('El evento SAP necesita una fecha ISO válida.');
  return parsed;
}

export function deliveryValidUntil(delivery: SapOutboundDelivery, validityDays: number) {
  if (!delivery.ActualGoodsMovementDate) {
    throw new TypeError('ActualGoodsMovementDate es obligatorio para emitir un GOVP determinista.');
  }
  const movementAt = /^\d{4}-\d{2}-\d{2}$/.test(delivery.ActualGoodsMovementDate)
    ? Date.parse(`${delivery.ActualGoodsMovementDate}T00:00:00.000Z`)
    : Date.parse(delivery.ActualGoodsMovementDate);
  if (!Number.isFinite(movementAt)) throw new TypeError('ActualGoodsMovementDate debe ser una fecha ISO válida.');
  return new Date(movementAt + validityDays * 86_400_000).toISOString();
}

export class SapS4HanaGovpConnector {
  private readonly config: Required<Pick<SapConnectorConfig, 'mode' | 'systemId' | 'issuerName'>> & SapConnectorConfig;

  constructor(
    config: SapConnectorConfig,
    private readonly sap: SapApiClient,
    private readonly exchange: GovpExchangeClient,
    private readonly store: GovpLinkStore,
  ) {
    this.config = {
      ...config,
      mode: config.mode,
      systemId: config.systemId.trim(),
      issuerName: config.issuerName.trim(),
      govpCodeField: validFieldName(config.govpCodeField),
      govpStatusField: validFieldName(config.govpStatusField),
      govpVerifyUrlField: validFieldName(config.govpVerifyUrlField),
    };
    if (!this.config.systemId || !this.config.issuerName) throw new TypeError('systemId e issuerName son obligatorios.');
    if (!Number.isInteger(this.config.validityDays ?? 365) || (this.config.validityDays ?? 365) < 1) {
      throw new TypeError('validityDays debe ser un entero positivo.');
    }
  }

  async handleOutboundEvent(event: SapBusinessEvent): Promise<EventResult> {
    if (!event.id || !event.data?.DeliveryDocument) throw new TypeError('Evento SAP incompleto.');
    const deliveryDocument = event.data.DeliveryDocument;
    const prior = await this.store.get(deliveryDocument);
    if (prior?.eventId === event.id || prior?.code) {
      return { deliveryDocument, eventId: event.id, outcome: 'duplicate', code: prior.code, verifyUrl: prior.verifyUrl };
    }
    if (prior && eventTime(event.time) < eventTime(prior.eventTime)) {
      return { deliveryDocument, eventId: event.id, outcome: 'ignored' };
    }

    const delivery = await this.sap.getOutboundDelivery(deliveryDocument);
    if (!posted(delivery)) return { deliveryDocument, eventId: event.id, outcome: 'not_posted' };

    if (this.config.mode === 'observe') {
      await this.store.save({ deliveryDocument, eventId: event.id, eventTime: event.time, status: 'observed', attempts: 0 });
      return { deliveryDocument, eventId: event.id, outcome: 'observed' };
    }

    const systemHash = createHash('sha256').update(this.config.systemId).digest('hex').slice(0, 16);
    const validUntil = deliveryValidUntil(delivery, this.config.validityDays ?? 365);
    const result = await this.exchange.issue({
      issuer: { name: this.config.issuerName },
      subject: {
        type: 'shipment',
        id: deliveryDocument,
        name: `SAP Outbound Delivery ${deliveryDocument}`,
        description: `${items(delivery).length} posiciones expedidas`,
      },
      requirement: 'Demuestra la salida de mercancías de una entrega en SAP S/4HANA Cloud mediante una huella de sus datos logísticos mínimos.',
      evidence: [{ label: 'Huella canónica de la entrega de salida SAP', sha256: deliveryEvidenceSha256(delivery) }],
      validUntil,
      source: { platform: 'sap_s4hana_cloud', externalId: `outbound-delivery-${deliveryDocument}` },
    }, `sap-s4:${systemHash}:delivery:${deliveryDocument}`);

    const record: StoredGovpLink = {
      deliveryDocument,
      eventId: event.id,
      eventTime: event.time,
      code: result.govp.code,
      verifyUrl: result.govp.verifyUrl,
      govp: result.govp,
      status: 'issued',
      attempts: 0,
    };
    await this.store.save(record);
    return this.persistLink(record);
  }

  private fields(record: StoredGovpLink) {
    return Object.fromEntries([
      this.config.govpCodeField && record.code ? [this.config.govpCodeField, record.code] : undefined,
      this.config.govpStatusField ? [this.config.govpStatusField, 'issued'] : undefined,
      this.config.govpVerifyUrlField && record.verifyUrl ? [this.config.govpVerifyUrlField, record.verifyUrl] : undefined,
    ].filter((entry): entry is [string, string] => Boolean(entry)));
  }

  private async persistLink(record: StoredGovpLink): Promise<EventResult> {
    const fields = this.fields(record);
    if (!Object.keys(fields).length) {
      const linked = { ...record, status: 'linked' as const };
      await this.store.save(linked);
      return { deliveryDocument: record.deliveryDocument, eventId: record.eventId, outcome: 'linked', code: record.code, verifyUrl: record.verifyUrl };
    }
    try {
      await this.sap.patchOutboundGovp(record.deliveryDocument, fields);
      const linked = { ...record, status: 'linked' as const, attempts: record.attempts + 1, lastError: undefined };
      await this.store.save(linked);
      return { deliveryDocument: record.deliveryDocument, eventId: record.eventId, outcome: 'linked', code: record.code, verifyUrl: record.verifyUrl };
    } catch (error) {
      const pending = { ...record, status: 'link_pending' as const, attempts: record.attempts + 1, lastError: error instanceof Error ? error.message : 'Error SAP desconocido.' };
      await this.store.save(pending);
      return { deliveryDocument: record.deliveryDocument, eventId: record.eventId, outcome: 'link_pending', code: record.code, verifyUrl: record.verifyUrl };
    }
  }

  async reconcileLinks() {
    const results: EventResult[] = [];
    for (const record of await this.store.pending()) results.push(await this.persistLink(record));
    return results;
  }

  async verifyInboundDelivery(deliveryDocument: string, code: string) {
    const delivery = await this.sap.getInboundDelivery(deliveryDocument);
    const verification = await this.exchange.verify(code);
    return {
      deliveryDocument: delivery.DeliveryDocument,
      itemCount: items(delivery).length,
      code,
      valid: verification.verification.status === 'valid' && verification.verification.integrityValid,
      reasonCode: verification.verification.reasonCode,
      verification,
    };
  }
}
