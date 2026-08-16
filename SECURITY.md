# Seguridad

No abras incidencias públicas que contengan credenciales, URLs privadas de
tenant, datos de entregas o identificadores de business partners. Comunica una
vulnerabilidad a `research@gemacode.org` con versión, impacto y reproducción
mínima. No incluyas secretos en el informe.

El conector exige HTTPS fuera de simuladores locales, admite OAuth 2.0 Client
Credentials, no registra tokens y minimiza la evidencia antes de enviarla a
GOVP Exchange. El despliegue debe almacenar secretos en el servicio gestionado
del runtime y aplicar permisos SAP mínimos.
