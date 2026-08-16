# GOVP for SAP S/4HANA Cloud

Conector side-by-side open source entre **SAP S/4HANA Cloud Public Edition** y
GOVP Exchange. Consume entregas mediante las APIs publicadas de SAP, emite un
GOVP al contabilizar la salida de mercancías y permite comprobarlo desde una
entrega entrante.

> Estado: candidato técnico `0.1.0`. El simulador abierto valida el contrato y
> los fallos operativos, pero no sustituye la aceptación en un tenant SAP real.

## Alcance del candidato

- API oficial `Outbound Delivery (A2X)` para leer cabecera y posiciones;
- API oficial `Inbound Delivery (A2X)` para el flujo receptor;
- modo `observe` que no emite ni modifica SAP;
- modo `issue` con idempotencia estable por sistema y entrega;
- huella SHA-256 de datos logísticos mínimos, sin copiar la entrega completa;
- campos de extensibilidad opcionales para código, estado y URL GOVP;
- token CSRF y `ETag` al actualizar SAP;
- reintentos acotados, eventos duplicados y fuera de orden;
- reconciliación del enlace SAP sin volver a emitir;
- simuladores SAP y GOVP para CI.

Las referencias oficiales utilizadas son [Outbound Delivery
(A2X)](https://api.sap.com/api/API_OUTBOUND_DELIVERY_SRV_0002/overview) e
[Inbound Delivery (A2X)](https://api.sap.com/api/API_INBOUND_DELIVERY_SRV/overview).
El tenant piloto debe confirmar versiones, Communication Arrangements,
extensibilidad y eventos habilitados.

## Uso

```bash
npm install
npm run check
```

```ts
import { GovpExchangeClient } from '@gemacode/govp-connector-kit';
import {
  MemoryGovpLinkStore,
  SapApiClient,
  SapS4HanaGovpConnector,
  oauthClientCredentials,
} from '@gemacode/govp-for-sap-s4hana-cloud';

const sap = new SapApiClient({
  baseUrl: process.env.SAP_BASE_URL!,
  auth: oauthClientCredentials({
    tokenUrl: process.env.SAP_TOKEN_URL!,
    clientId: process.env.SAP_CLIENT_ID!,
    clientSecret: process.env.SAP_CLIENT_SECRET!,
  }),
});

const exchange = new GovpExchangeClient({
  baseUrl: process.env.GOVP_EXCHANGE_URL!,
  token: process.env.GOVP_CONNECTOR_TOKEN!,
});

const connector = new SapS4HanaGovpConnector({
  mode: 'observe',
  systemId: 'sap-public-production',
  issuerName: 'Empresa emisora',
}, sap, exchange, new MemoryGovpLinkStore());
```

`MemoryGovpLinkStore` sirve para pruebas. Un despliegue real debe implementar
`GovpLinkStore` sobre una base de datos transaccional gestionada. El proceso que
recibe eventos puede ejecutar `handleOutboundEvent`; un job independiente puede
invocar `reconcileLinks`.

## Campos personalizados opcionales

Los nombres no se presuponen porque dependen del contexto de extensibilidad del
tenant. Cuando estén publicados en el servicio OData, se configuran así:

```ts
{
  govpCodeField: 'YY1_GOVPCode_DLH',
  govpStatusField: 'YY1_GOVPStatus_DLH',
  govpVerifyUrlField: 'YY1_GOVPVerifyURL_DLH'
}
```

Sin esos campos, el vínculo queda en el repositorio side-by-side y el conector
sigue siendo idempotente. No se modifica código estándar SAP.

## Puerta SAP pendiente

Antes de llamar a este producto “validado” deben completarse en un tenant real:

1. Communication Arrangements y permisos mínimos.
2. Salida/entrada parcial, materiales, lotes y series.
3. Campos personalizados o estrategia de enlace acordada.
4. Eventos reales, duplicados, retrasos y recuperación.
5. Segregación de funciones, métricas, actualización y rollback.

SAP y S/4HANA son marcas de SAP SE. Este proyecto no está afiliado ni certificado
por SAP. La conformidad GOVP es técnica y no constituye certificación legal.

## Licencia

Apache-2.0.
