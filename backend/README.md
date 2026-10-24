# Backend de Baliza Vital

API egress, buzón, registro, incidentes, agente de emergencias y mocks de las Fases 4 y 5.
Implementa `docs/contrato.md` (v1). Node ≥ 22.13, ESM, sin framework: `node:http`, `node:sqlite`,
`node:crypto` (Ed25519), `libsodium-wrappers` (`crypto_box_seal`) y `@anthropic-ai/sdk`.

```bash
cd backend
npm install
npm test                         # 132 pruebas, sin red ni credenciales
npm start                        # :8080 (PORT), datos en backend/data/ (fuera de git)
node scripts/post-vector.mjs     # prueba extremo a extremo contra el servidor local
```

## Qué hay

| Archivo | Rol |
|---|---|
| `src/codec.js` | Paquete interno (§3): decodificar, firmar, verificar, plaintexts de cada tipo |
| `src/crypto.js` | `crypto_box_seal` y llaves del servidor (Ed25519 + X25519) |
| `src/users.js` | `POST /v1/users`, `PUT /v1/users/{id}/contacts` (§6) |
| `src/egress.js` | `POST /v1/egress` (§4): validación, idempotencia, ACK firmado |
| `src/mailbox.js` | `POST /v1/mailbox/poll` (§5) |
| `src/radio.js` | R5: `POST /v1/egress/presence`, `GET /v1/egress/inbox` (long-poll), selección por geohash |
| `src/agent.js` | `registrar_incidente`, `avisar_contactos`, `consultar_alertas` y el plan del SOS (§7) |
| `src/commands.js` | `CMD` → `CMD_RESULT`: mocks de pagos/rides tras feature flags, topes e idempotencia |
| `src/replies.js` | Respuestas de contactos → `MSG_IN` sellado al usuario |
| `src/channels.js`, `src/llm.js` | SMS (Twilio), correo (Resend), voz (ElevenLabs), redactor con Claude |
| `src/api.js` | Ensamblado de la app (contexto + servidor HTTP) |
| `src/routes/` | Rutas por tema: `users`, `mesh` (egress, buzón, presencia), `replies`, `admin`, `dashboard` (`/v1/incidents`, `/v1/stream`) |

## Orden de comprobaciones de `POST /v1/egress`

forma/base64/≤418 B/versión/tipo → **400** · `sender_id` no registrado → **404** · firma → **401** ·
clave de idempotencia `(sender_id, incident_id, seq, msg_type)` → `duplicate` con **los mismos bytes de ACK**
(se guardan, no se re-firman; un reenvío ya aceptado no cuenta para el límite de tasa) · tasa por
`sender_id` → **429** · ventana de tiempo → **422**. La tasa por `egress_id` se aplica antes de decodificar.
Solo entran los tipos 1, 2, 4 y 6. El base64 tolera saltos de línea (`android.util.Base64.DEFAULT`).

El ACK se responde de forma síncrona (código 2 «en gestión» para SOS/UPDATE; 0 «recibido» para el resto;
3 «rechazado» si el blob de MSG_OUT/CMD no se pudo leer). El agente y los canales corren **después**, sin
bloquear al egress; al terminar de avisar dejan en el buzón un segundo ACK con código 1 («contactos
avisados»). Si todos los canales fueron simulados, el texto del ACK empieza por `[SIMULADO]`.

## Cómo se evita la inyección de comandos

- Las herramientas se despachan **en código**, no por el modelo. Un SOS ejecuta siempre
  `registrar_incidente` + `avisar_contactos` con los contactos/canales del blob firmado del usuario.
- El LLM (si hay `ANTHROPIC_API_KEY`) solo **redacta el texto** del aviso: no recibe herramientas, y la nota
  del SOS entra delimitada como dato no confiable (con `<`/`>` neutralizados).
- `CMD` solo se ejecuta si el paquete tipo 6 trae la firma válida del usuario. Las respuestas de contactos
  (`MSG_IN`) no pasan por el agente: se sellan y se dejan en el buzón.
- Tests: `flow.test.js` → «INYECCIÓN: …».

## Variables de entorno

Añádelas a `.env.example` a mano (esta plantilla bloquea editar `.env.*` desde Claude Code). Todas son
opcionales; sin credenciales, los canales escriben en consola y devuelven `simulated`.

```bash
# Servidor
PORT=8080
DATABASE_PATH=                        # por defecto backend/data/baliza.db (SQLite; en un host efímero se pierde)
BALIZA_KEY_FILE=                      # por defecto backend/data/server-keys.json (llaves generadas la primera vez)
TRUST_PROXY=false                     # true detrás de Render/nginx: usa X-Forwarded-For para el límite de registro
BALIZA_SIGN_SEED_HEX=                 # 32 B hex: semilla Ed25519 del servidor (producción: fíjala)
BALIZA_SEAL_SK_HEX=                   # 32 B hex: llave privada X25519 del servidor
PUBLIC_BASE_URL=https://tu-deploy     # base de los enlaces /r/<token>; en Render se toma de RENDER_EXTERNAL_URL
CORS_ORIGIN=*
BALIZA_NOW=                           # solo pruebas: fija el reloj (epoch s) para los vectores congelados
# Seguridad
ADMIN_TOKEN=                          # habilita /v1/admin/*, /v1/dev/simulate-reply y /v1/webhooks/sms
DASHBOARD_TOKEN=                      # si se define, /v1/incidents y /v1/stream exigen Bearer o ?token=
ALLOW_UNVERIFIED_CONTACTS=false       # true: los canales REALES también contactan a no verificados (solo demo cerrado)
LLM_TIMEOUT_MS=6000                   # pasado este tiempo el aviso sale con la plantilla
# Fases 4 y 5 (apagadas por defecto)
FEATURE_PAYMENTS=false
FEATURE_RIDES=false
CMD_MAX_PER_DAY=10
CMD_MAX_AMOUNT_PER_DAY=500
# Agente (redacción de avisos)
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-opus-5-5
# WhatsApp por Kapso (el bit «sms» del contrato se entrega por aquí si está configurado)
KAPSO_API_KEY=
KAPSO_PHONE_NUMBER_ID=                # phone_number_id del número de WhatsApp en Kapso
KAPSO_WEBHOOK_SECRET=                 # secreto del webhook (firma X-Webhook-Signature); sin él no se reciben respuestas
KAPSO_TEMPLATE_ALERT=                 # plantilla aprobada para el primer aviso (ver «WhatsApp» abajo)
KAPSO_TEMPLATE_MESSAGE=               # plantilla aprobada para los mensajes del usuario
KAPSO_TEMPLATE_LANG=es                # código de idioma de las plantillas (KAPSO_TEMPLATE_LANG_EN para contactos en inglés)
SMS_PROVIDER=                         # twilio: fuerza Twilio aunque Kapso esté configurado
# Otros canales reales
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM=
RESEND_API_KEY=
EMAIL_FROM=
ELEVENLABS_API_KEY=
ELEVENLABS_AGENT_ID=
ELEVENLABS_PHONE_NUMBER_ID=
# Límites (valores por defecto)
RATE_EGRESS_PER_MIN=120
RATE_SENDER_PER_MIN=30
RATE_REGISTER_PER_MIN=20
RATE_REPLY_PER_HOUR=20
```

## Probar sin teléfonos

```bash
node scripts/post-vector.mjs --url http://localhost:8080   # paquetes nuevos, sellado real, comprueba ACK/duplicate/401/buzón
BALIZA_NOW=1798200010 npm start                            # en otra terminal…
node scripts/post-vector.mjs --raw --url http://localhost:8080   # …y postea los bytes congelados de examples.json
```

Los vectores congelados tienen `timestamp` de 2026-12-25: sin `BALIZA_NOW` el servidor responde **422**,
como debe. Sus `sealed_blob` son relleno (no abren): el servidor igual acepta y devuelve ACK, y al no poder
leer contactos/canales usa el fallback «todos los contactos, SMS» y registra el evento `blob_unreadable`.
El dev A debe sellar de verdad con `crypto_box_seal` a `server.seal_pk_b64` (lo devuelve `POST /v1/users`).

## Rutas fuera del contrato (extensiones del backend)

| Ruta | Para qué |
|---|---|
| `GET /r/{token}` · `POST /r/{token}` | Página mínima para que un contacto responda desde el enlace del aviso |
| `POST /v1/replies` `{token,text}` | Lo mismo por API |
| `POST /v1/webhooks/whatsapp` | Webhook de Kapso (firma `X-Webhook-Signature`, HMAC-SHA256 del cuerpo con `KAPSO_WEBHOOK_SECRET`): respuestas entrantes y estados de entrega |
| `POST /v1/webhooks/sms?secret=ADMIN_TOKEN` | SMS entrante (formato Twilio `From`,`Body`) → último incidente avisado a ese número |
| `POST /v1/admin/contacts/verify` `{sender_id,index}` (Bearer ADMIN_TOKEN) | Marca un contacto `verified` |
| `POST /v1/dev/simulate-reply` (Bearer ADMIN_TOKEN) | Simula la respuesta de un contacto en el demo |
| `GET /v1/incidents`, `/v1/incidents/{sender}/{incident}`, `/v1/events?after=`, `/v1/stream` (SSE) | Para el dashboard |
| `GET /health` | Salud y banderas `features` (pagos/rides) |

## WhatsApp (Kapso)

Con `KAPSO_API_KEY` y `KAPSO_PHONE_NUMBER_ID`, los avisos del canal «sms» salen por WhatsApp
(`POST https://api.kapso.ai/meta/whatsapp/v24.0/{phone_number_id}/messages`, cabecera `X-API-Key`). Sin esas
variables se usa Twilio y, sin ninguno, la consola (estado `simulated`).

- **Ventana de 24 h:** WhatsApp solo admite texto libre dentro de las 24 h siguientes al último mensaje del
  contacto. Fuera de ella exige una **plantilla aprobada**. El backend usa texto libre si el contacto nos
  escribió hace menos de 24 h (lo registra el webhook), y la plantilla en otro caso; si falla una, prueba la otra.
- **Plantillas a crear y aprobar en Kapso/Meta** (categoría *utility*; los parámetros son posicionales):
  - `KAPSO_TEMPLATE_ALERT` (primer aviso): `ALERTA Baliza Vital: {{1}} pidió ayuda ({{2}}, gravedad {{3}}). Ubicación: {{4}}. Responde a este mensaje o aquí: {{5}}`
  - `KAPSO_TEMPLATE_MESSAGE` (mensaje del usuario): `{{1}} te escribe por Baliza Vital: {{2}}. Responde a este mensaje o aquí: {{3}}`
- **Para el demo (sin esperar aprobación):** haz que cada contacto del equipo escriba primero al número de
  WhatsApp de Kapso. Eso abre la ventana y los avisos salen como texto libre.
- **Webhook:** en Kapso apunta el webhook del número a `https://<backend>/v1/webhooks/whatsapp` con los eventos
  `whatsapp.message.received`, `.delivered`, `.read` y `.failed`, y copia su secreto a `KAPSO_WEBHOOK_SECRET`.
  Una respuesta de texto del contacto entra como `MSG_IN` sellado al usuario; los reintentos de Kapso se
  deduplican por `X-Idempotency-Key`. **El formato de los eventos de estado (`delivered/read/failed`) se
  asumió** (`message.id` = id devuelto al enviar): verifícalo con un envío real.

## Despliegue en Render

`render.yaml` (en la raíz) crea dos servicios: el backend (Node, plan *starter* con disco persistente de 1 GB en
`/var/data` para SQLite y las llaves) y el panel estático. Pasos: *New → Blueprint* sobre el repo personal,
rellena las variables `sync: false` (tokens, Kapso, Anthropic…) y despliega. Notas:

- Los discos persistentes limitan el servicio a **una instancia** (el límite de tasa y la cola viven en memoria).
- Fija `BALIZA_SIGN_SEED_HEX` y `BALIZA_SEAL_SK_HEX` en el entorno de Render: si el disco se pierde y las
  llaves se regeneran, los teléfonos ya registrados guardan las llaves anteriores del servidor y dejan de entenderlo.
- `SIGTERM` (redespliegue) cierra el servidor ordenadamente: espera hasta 10 s a los avisos en curso.
- También hay `Dockerfile`: `docker build -t baliza-backend backend && docker run -p 8080:8080 -v baliza-data:/app/data baliza-backend`.
- Postgres: todo el acceso a datos pasa por `src/store.js`; reimplementarlo sobre Postgres es el camino a varias réplicas.

## Límites conocidos

- Los ACK (tipo 3) se empujan una sola vez por radio; los tipos 5 y 7 se repiten cada 60 s hasta que el
  `rx_cursor` del origen los cubre. El resto de ACK llega por el reintento del origen (R1) y el buzón (R2).
- El límite de tasa vive en memoria (un proceso). Con varias réplicas, muévelo a la base de datos.
- La llamada con voz usa `POST /v1/convai/twilio/outbound-call` de ElevenLabs; **no se probó contra la API
  real** (sin credenciales). Revisa el nombre de los `dynamic_variables` con el agente que crees.
- **Verificación de contactos (paso de preparación del demo):** con canales reales (Twilio/Resend/ElevenLabs
  configurados), solo reciben avisos los contactos `verified`. Marca los del equipo con
  `POST /v1/admin/contacts/verify {"sender_id","index"}` (Bearer `ADMIN_TOKEN`) o pon
  `ALLOW_UNVERIFIED_CONTACTS=true` en un despliegue cerrado. Con canales simulados no hace falta.
- Sin `fallbacks` del lado del servidor en la llamada a Claude: una negativa o un error ya cae a la plantilla.
