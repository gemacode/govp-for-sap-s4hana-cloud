# Changelog

## 0.1.1 — 2026-08-18

- calcula `validUntil` desde `ActualGoodsMovementDate` para conservar el mismo contenido en reintentos idempotentes;
- rechaza fechas de movimiento ausentes o inválidas y periodos de vigencia no positivos;
- amplía la suite determinista con estabilidad de reintentos y validación de configuración.

## 0.1.0 — 2026-08-16

- candidato side-by-side para S/4HANA Cloud Public Edition;
- lectura de entregas de salida y entrada mediante OData;
- modos Observe e Issue, idempotencia, eventos fuera de orden y reconciliación;
- campos de extensibilidad opcionales con CSRF y ETag;
- simulador SAP y suite determinista abierta.
