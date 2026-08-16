import type { GovpLinkStore, StoredGovpLink } from './types.js';

export class MemoryGovpLinkStore implements GovpLinkStore {
  private readonly records = new Map<string, StoredGovpLink>();

  async get(deliveryDocument: string) {
    const value = this.records.get(deliveryDocument);
    return value ? structuredClone(value) : undefined;
  }

  async save(link: StoredGovpLink) {
    this.records.set(link.deliveryDocument, structuredClone(link));
  }

  async pending() {
    return [...this.records.values()].filter((item) => item.status === 'link_pending').map((item) => structuredClone(item));
  }

  snapshot() {
    return [...this.records.values()].map((item) => structuredClone(item));
  }
}
