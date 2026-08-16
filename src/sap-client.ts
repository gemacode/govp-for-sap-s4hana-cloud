import type { SapInboundDelivery, SapOutboundDelivery } from './types.js';

export type SapAuthProvider = () => Promise<Record<string, string>>;

export type SapApiClientOptions = {
  baseUrl: string;
  auth: SapAuthProvider;
  fetch?: typeof globalThis.fetch;
  outboundServicePath?: string;
  inboundServicePath?: string;
  retries?: number;
  retryBaseMs?: number;
};

export class SapApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly retryable: boolean) {
    super(message);
    this.name = 'SapApiError';
  }
}

type ODataEnvelope<T> = { d?: T } & T;

function baseUrl(value: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new TypeError('SAP API requiere HTTPS salvo en un simulador local.');
  }
  return parsed.toString().replace(/\/$/, '');
}

function servicePath(value: string) {
  return `/${value.replace(/^\/+|\/+$/g, '')}`;
}

function key(value: string) {
  return encodeURIComponent(value.replaceAll("'", "''"));
}

async function errorMessage(response: Response) {
  const payload = await response.json().catch(() => undefined) as { error?: { message?: { value?: string } | string } } | undefined;
  const message = payload?.error?.message;
  return typeof message === 'string' ? message : message?.value ?? `SAP API HTTP ${response.status}`;
}

export class SapApiClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly outboundPath: string;
  private readonly inboundPath: string;
  private readonly retries: number;
  private readonly retryBaseMs: number;

  constructor(private readonly options: SapApiClientOptions) {
    this.baseUrl = baseUrl(options.baseUrl);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.outboundPath = servicePath(options.outboundServicePath ?? '/sap/opu/odata/sap/API_OUTBOUND_DELIVERY_SRV');
    this.inboundPath = servicePath(options.inboundServicePath ?? '/sap/opu/odata/sap/API_INBOUND_DELIVERY_SRV');
    this.retries = Math.max(0, Math.min(options.retries ?? 2, 5));
    this.retryBaseMs = Math.max(0, options.retryBaseMs ?? 100);
  }

  private async raw(path: string, init: RequestInit = {}) {
    let last: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const response = await this.fetcher(`${this.baseUrl}${path}`, {
          ...init,
          headers: { Accept: 'application/json', ...(await this.options.auth()), ...init.headers },
        });
        if (response.ok) return response;
        const error = new SapApiError(response.status, await errorMessage(response), response.status === 429 || response.status >= 500);
        if (!error.retryable || attempt === this.retries) throw error;
        last = error;
      } catch (error) {
        if (error instanceof SapApiError && !error.retryable) throw error;
        last = error;
        if (attempt === this.retries) break;
      }
      await new Promise((resolve) => setTimeout(resolve, this.retryBaseMs * (2 ** attempt)));
    }
    if (last instanceof SapApiError) throw last;
    throw new SapApiError(0, last instanceof Error ? last.message : 'SAP API no disponible.', true);
  }

  private async get<T>(path: string) {
    const response = await this.raw(path);
    const payload = await response.json() as ODataEnvelope<T>;
    return (payload.d ?? payload) as T;
  }

  getOutboundDelivery(deliveryDocument: string) {
    return this.get<SapOutboundDelivery>(`${this.outboundPath}/A_OutbDeliveryHeader('${key(deliveryDocument)}')?$expand=to_DeliveryDocumentItem`);
  }

  getInboundDelivery(deliveryDocument: string) {
    return this.get<SapInboundDelivery>(`${this.inboundPath}/A_InbDeliveryHeader('${key(deliveryDocument)}')?$expand=to_DeliveryDocumentItem`);
  }

  async patchOutboundGovp(deliveryDocument: string, fields: Record<string, string>) {
    if (!Object.keys(fields).length) return;
    const entityPath = `${this.outboundPath}/A_OutbDeliveryHeader('${key(deliveryDocument)}')`;
    const tokenResponse = await this.raw(entityPath, { headers: { 'x-csrf-token': 'Fetch' } });
    const csrfToken = tokenResponse.headers.get('x-csrf-token');
    if (!csrfToken) throw new SapApiError(502, 'SAP no devolvió un token CSRF para actualizar los campos GOVP.', false);
    const etag = tokenResponse.headers.get('etag') ?? '*';
    await this.raw(entityPath, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken, 'If-Match': etag },
      body: JSON.stringify(fields),
    });
  }
}

export function basicAuth(username: string, password: string): SapAuthProvider {
  const encoded = Buffer.from(`${username}:${password}`).toString('base64');
  return async () => ({ Authorization: `Basic ${encoded}` });
}

export function oauthClientCredentials(options: { tokenUrl: string; clientId: string; clientSecret: string; fetch?: typeof globalThis.fetch }): SapAuthProvider {
  const fetcher = options.fetch ?? globalThis.fetch;
  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    if (cached && cached.expiresAt > Date.now() + 30_000) return { Authorization: `Bearer ${cached.token}` };
    const credentials = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64');
    const response = await fetcher(options.tokenUrl, {
      method: 'POST',
      headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: 'grant_type=client_credentials',
    });
    const payload = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!response.ok || !payload.access_token) throw new SapApiError(response.status, payload.error_description ?? 'No se pudo obtener el token OAuth de SAP.', response.status === 429 || response.status >= 500);
    cached = { token: payload.access_token, expiresAt: Date.now() + Math.max(60, payload.expires_in ?? 300) * 1000 };
    return { Authorization: `Bearer ${cached.token}` };
  };
}
