import type { GovpReference } from '@gemacode/govp-connector-kit';

export type SapConnectorMode = 'observe' | 'issue';

export type SapDeliveryItem = {
  DeliveryDocument: string;
  DeliveryDocumentItem: string;
  Material?: string;
  Batch?: string;
  ActualDeliveryQuantity?: string;
  DeliveryQuantityUnit?: string;
  Plant?: string;
  StorageLocation?: string;
};

export type SapOutboundDelivery = {
  DeliveryDocument: string;
  ActualGoodsMovementDate?: string | null;
  OverallGoodsMovementStatus?: string | null;
  ShipToParty?: string;
  SoldToParty?: string;
  to_DeliveryDocumentItem?: { results?: SapDeliveryItem[] } | SapDeliveryItem[];
};

export type SapInboundDelivery = {
  DeliveryDocument: string;
  GoodsMovementType?: string;
  Supplier?: string;
  to_DeliveryDocumentItem?: { results?: SapDeliveryItem[] } | SapDeliveryItem[];
};

export type SapBusinessEvent = {
  id: string;
  time: string;
  type: string;
  source: string;
  data: { DeliveryDocument: string };
};

export type StoredGovpLink = {
  deliveryDocument: string;
  eventId: string;
  eventTime: string;
  code?: string;
  status: 'observed' | 'issued' | 'link_pending' | 'linked' | 'ignored';
  verifyUrl?: string;
  govp?: GovpReference;
  lastError?: string;
  attempts: number;
};

export interface GovpLinkStore {
  get(deliveryDocument: string): Promise<StoredGovpLink | undefined>;
  save(link: StoredGovpLink): Promise<void>;
  pending(): Promise<StoredGovpLink[]>;
}

export type SapConnectorConfig = {
  mode: SapConnectorMode;
  systemId: string;
  issuerName: string;
  validityDays?: number;
  govpCodeField?: string;
  govpStatusField?: string;
  govpVerifyUrlField?: string;
};

export type EventResult = {
  deliveryDocument: string;
  eventId: string;
  outcome: StoredGovpLink['status'] | 'duplicate' | 'not_posted';
  code?: string;
  verifyUrl?: string;
};
