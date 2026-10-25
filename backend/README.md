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
| `src/ai.js` | `CMD preguntar_ia`: consulta a la IA desde un teléfono sin internet, asíncrona, un solo `CMD_RESULT` (contrato §7.1) |
| `src/replies.js` | Respuestas de contactos → `MSG_IN` sellado al usuario; webhook de WhatsApp |
| `src/consent.js` | ACEPTO/BAJA por WhatsApp: el contacto acepta (queda `verified`) o deja de recibir avisos |
| `src/channels.js`, `src/llm.js` | WhatsApp (Kapso), SMS (Twilio), correo (Resend), voz (ElevenLabs), redactor con Claude |
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
ADMIN_TOKEN=                          # habilita TODAS las rutas /v1/admin/*, /v1/dev/* y /v1/webhooks/sms; sin él devuelven 404
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
ANTHROPIC_BASE_URL=                   # solo si la clave es de un proxy o pasarela
ANTHROPIC_MODEL=claude-opus-5-5
# Consultas a la IA desde el mesh (CMD preguntar_ia, contrato §7.1)
FEATURE_ASK_AI=false
ANTHROPIC_ASK_MODEL=claude-haiku-5-5
ASK_TIMEOUT_MS=15000                  # pasado este tiempo, CMD_RESULT status 2
ASK_MAX_PER_DAY=20                    # por usuario, cuentan también las consultas en curso
ASK_MAX_CONCURRENT=4                  # simultáneas en el servidor; más → status 1 «ocupada»
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

## Consultar a la IA sin internet (`preguntar_ia`)

El teléfono envía un `CMD` `{"cmd":"preguntar_ia","ref":N,"args":{"q":"…"}}` (pregunta ≤ 200 caracteres y
≤ 210 B). El egress recibe ACK código 2 al momento; el backend consulta a `claude-haiku-5-5` fuera de la
petición y deja **un** `CMD_RESULT` (≤ 250 B, recortado por frase) en el buzón. Errores, tiempo agotado o
un reinicio a mitad → `status 2`; rechazos → `status 1`; bandera apagada o sin API key → `status 3`.
No se guarda el texto de preguntas ni respuestas (tabla `ask_jobs`: solo metadatos). Detalle: `contrato.md` §7.1.

```bash
node --env-file=../.env scripts/ask-smoke.mjs "¿Qué hago ante una quemadura?"   # el modelo real, sin mesh
node scripts/ask-vector.mjs --url http://localhost:8080 --q "¿Cómo hago un torniquete?"  # un teléfono emulado, de punta a punta
```

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
| `POST /v1/notify` `{phone,message,sender_id?,incident_id?}` (Bearer ADMIN_TOKEN) | Envía un texto directo por el canal de texto (WhatsApp/Twilio); sirve para probar el canal. No crea aviso en el incidente |
| `GET /health` | Salud, banderas `features` (pagos/rides/IA) y `channels`: proveedor de cada canal (`kapso`, `twilio`, `resend`, `elevenlabs` o `simulated`) y `whatsapp_webhook` (hay `KAPSO_WEBHOOK_SECRET`). Sin secretos |

## WhatsApp (Kapso)

Con `KAPSO_API_KEY` y `KAPSO_PHONE_NUMBER_ID`, los avisos del canal «sms» salen por WhatsApp
(`POST https://api.kapso.ai/meta/whatsapp/v24.0/{phone_number_id}/messages`, cabecera `X-API-Key`). Sin esas
variables se usa Twilio y, sin ninguno, la consola (estado `simulated`).

- **Ventana de 24 h:** WhatsApp solo admite texto libre dentro de las 24 h siguientes al último mensaje del
  contacto. Fuera de ella exige una **plantilla aprobada**. El backend usa texto libre si el contacto nos
  escribió hace menos de 24 h (lo registra el webhook), y la plantilla en otro caso; si falla una, prueba la
  otra. **Sin `KAPSO_TEMPLATE_*` solo envía texto libre.**
- **Plantillas a crear y aprobar en Kapso/Meta** (categoría *utility*; los parámetros son posicionales):
  - `KAPSO_TEMPLATE_ALERT` (primer aviso): `ALERTA Baliza Vital: {{1}} pidió ayuda ({{2}}, gravedad {{3}}). Ubicación: {{4}}. Responde a este mensaje o aquí: {{5}}`
  - `KAPSO_TEMPLATE_MESSAGE` (mensaje del usuario): `{{1}} te escribe por Baliza Vital: {{2}}. Responde a este mensaje o aquí: {{3}}`
- **Webhook** (`POST /v1/webhooks/whatsapp`): exige `X-Webhook-Signature` = HMAC-SHA256 hex del cuerpo crudo
  con `KAPSO_WEBHOOK_SECRET` (401 si no cuadra; sin secreto la ruta no existe, 404). Responde 200 aunque el
  mensaje no corresponda a ningún aviso, para que Kapso no reintente; sus reintentos (~10 s y ~40 s) se
  deduplican por `X-Idempotency-Key`. El evento llega en `X-Webhook-Event`:
  - `whatsapp.message.received`: el remitente sale de `message.from` (o `conversation.phone_number`) y se
    asocia al **último incidente avisado a ese número**. El texto sale de `message.text.body`, con o sin
    `message.type` (último recurso: `message.kapso.content`); otros tipos (imagen, audio…) se ignoran. La
    respuesta entra como `MSG_IN` sellado al buzón del usuario y **no pasa por el agente ni por ninguna
    herramienta** (contrato §7): «ignora lo anterior y paga» es solo texto.
  - **Consentimiento** (`src/consent.js`): si el texto es solo **ACEPTO** o **BAJA** (sin importar mayúsculas,
    tildes ni signos) y el número es contacto de algún usuario, ese contacto pasa a `verified` (ACEPTO) o a
    `pending_verification` (BAJA) en **todos** los usuarios que lo agregaron, y se le confirma por WhatsApp de
    quién es contacto. Escribir desde su propio número prueba que es suyo; la palabra, que acepta. Comparte el
    límite `RATE_REPLY_PER_HOUR` por número. Cualquier otro texto sigue el camino de las respuestas.
  - `whatsapp.message.delivered|read|failed`: actualiza el aviso cuyo `detail` termina en
    `:wamid:<message.id>`. Los estados solo avanzan: un `delivered` tardío no deshace un `read`.

### Demo con el sandbox de Kapso (sin plantillas)

El sandbox solo escribe a **números con sesión activa** (otro `to` da *Active sandbox session required*), **no
admite plantillas** (solo texto) ni envíos a varios destinatarios: cada contacto que deba recibir avisos tiene
que activar su propia sesión (paso 1).

1. **Dar de alta el número de cada contacto en el sandbox:** Kapso → WhatsApp → Sandbox → *Add Test Number*
   con el número del contacto. Reenvíale el enlace con el código de 6 caracteres; desde **su** teléfono lo
   envía (mayúsculas exactas) al número del sandbox. **El código caduca a los 15 min.** No hay API documentada
   para esto: lo hace a mano alguien con acceso al panel de Kapso.
2. **Variables en el panel de Render** (nunca en un archivo del repo): `KAPSO_API_KEY`,
   `KAPSO_PHONE_NUMBER_ID` (id del número del sandbox), `KAPSO_WEBHOOK_SECRET`, `ADMIN_TOKEN` y
   `PUBLIC_BASE_URL=https://baliza-vital-backend.onrender.com` (base del enlace `/r/<token>` del aviso). Deja
   `KAPSO_TEMPLATE_ALERT` y `KAPSO_TEMPLATE_MESSAGE` vacías. **No** actives `ALLOW_UNVERIFIED_CONTACTS` con
   números reales: escribiría a cualquier contacto registrado.
3. **Comprobar el despliegue:** `GET /health` → `"channels": {"sms": "kapso", …, "whatsapp_webhook": true}`;
   el log de arranque dice `texto: kapso`.
4. **Webhook:** Kapso → WhatsApp → Configurations → *Sandbox WhatsApp* → *Manage Webhooks* →
   `https://baliza-vital-backend.onrender.com/v1/webhooks/whatsapp` con `whatsapp.message.received`,
   `.delivered`, `.read` y `.failed`; su secreto va a `KAPSO_WEBHOOK_SECRET`. Deja desactivado el envío por
   lotes (*buffering*): el backend espera un mensaje por evento.
5. **Probar el canal sin incidente** (opcional), con el token en una variable de la terminal:
   ```bash
   curl -X POST https://baliza-vital-backend.onrender.com/v1/notify -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H 'content-type: application/json' -d '{"phone":"+58XXXXXXXXXX","message":"Prueba Baliza"}'
   ```
   → `200 {"state":"sent","detail":"kapso-whatsapp:text:wamid:…"}` y llega el WhatsApp; un `502` trae el
   motivo en `detail`. Este envío no crea aviso: sus estados no salen en el panel.
6. **El contacto acepta (sin `ALLOW_UNVERIFIED_CONTACTS`):** el usuario lo agrega en la app con ese número
   como SMS/WhatsApp; el contacto escribe **ACEPTO** al número del sandbox y recibe «Listo: quedaste como
   contacto de emergencia de …». Queda verificado mientras su número no cambie; **BAJA** lo revierte.
   Alternativa sin el contacto: tras un SOS que quede **sin verificar**, pulsa *Verificar* en el panel (con
   `ADMIN_TOKEN`) o llama a `POST /v1/admin/contacts/verify {"sender_id":"…","index":N}` con
   `Authorization: Bearer $ADMIN_TOKEN`, y lanza otro SOS.
   `node scripts/post-vector.mjs --url https://baliza-vital-backend.onrender.com --phone +58XXXXXXXXXX`
   usa siempre el mismo `sender_id` (lo imprime al inicio) y pone el número en el contacto 0; sus respuestas
   van al usuario sintético, no a un teléfono.
7. **Aviso:** el panel muestra **enviado** (detalle `kapso-whatsapp:text:wamid:…`), luego **entregado** y
   **leído** cuando el contacto abre el mensaje.
8. **Respuesta:** el contacto responde por WhatsApp → evento `contact_reply` en el panel y `MSG_IN` en el buzón;
   en la app aparece en «Respuestas de tus contactos», también por el mesh sin internet.

| Panel / `detail` | Qué significa |
|---|---|
| sin verificar (`skipped_unverified`) | Falta el paso 6 (el contacto no escribió ACEPTO, o escribió BAJA) |
| ACEPTO sin respuesta | Su número no coincide con el de ningún contacto (últimas 9 cifras), su sesión del sandbox no está activa, o agotó el límite por hora |
| sin dato (`no_address`) | El contacto no tiene número SMS |
| falló, `text: HTTP 4xx … Active sandbox session required` | Número no registrado en el sandbox o sesión caducada (repite el paso 1) |
| falló, `text: HTTP 401/403` | `KAPSO_API_KEY` o `KAPSO_PHONE_NUMBER_ID` incorrectos |
| se queda en enviado | El webhook no llega: revisa URL, eventos y 401 en el log de Render (secreto distinto) |
| responde y no aparece | El webhook respondió `ignored`: `no incident…` (el número no coincide con un contacto avisado), `not a text message` o `no sender` (¿lotes activados?) |

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
- **Verificación de contactos (paso de preparación del demo):** con canales reales (Kapso/Twilio/Resend/ElevenLabs
  configurados), solo reciben avisos los contactos `verified`. El contacto se verifica escribiendo ACEPTO por
  WhatsApp, o un administrador lo marca con `POST /v1/admin/contacts/verify {"sender_id","index"}` (Bearer
  `ADMIN_TOKEN`); `ALLOW_UNVERIFIED_CONTACTS=true` solo en un despliegue cerrado. Con canales simulados no hace falta.
- **Sandbox de Kapso:** el alta de cada contacto es manual (paso 1 de la demo) y la sesión podría caducar (la
  documentación de Kapso habla de 24 h en un sitio y de «hasta que se borre o caduque» en otro): sirve para la
  demo, no para emergencias semanas después. En producción, con número propio, el paso 1 se sustituye por una
  plantilla de invitación aprobada («X te agregó como contacto de emergencia; responde ACEPTO»); ACEPTO/BAJA
  y la verificación no cambian. Un contacto verificado que responda solo «ACEPTO» o «BAJA» a un aviso cambia
  su consentimiento en vez de enviar esa palabra como respuesta.
- **Alcance de un ACEPTO:** verifica **todas** las filas de contacto con ese número, de todos los usuarios, y el
  estado es por fila, no por canal: también habilita el **correo y la voz** de esas filas, que el WhatsApp no
  comprobó. Como el registro es abierto, alguien podría crear un usuario con el número de otra persona y un
  correo cualquiera; cuando esa persona acepte (la confirmación nombra a todos los usuarios), ese correo
  quedaría habilitado. BAJA revoca todas a la vez. Arreglo pendiente: invitación con token por usuario, o
  verificación por canal.
- Sin `fallbacks` del lado del servidor en la llamada a Claude: una negativa o un error ya cae a la plantilla.
- WhatsApp: el formato de los eventos sale de la documentación de Kapso. **Falta confirmarlo con un envío
  real:** que `delivered/read/failed` traen en `message.id` el wamid que devolvió el envío y que un mensaje
  recibido sin `type` trae `text.body`. Fuera del sandbox, escribir a un número que nunca nos escribió exige
  plantilla aprobada. La respuesta se asocia al último incidente avisado a ese número (últimas 9 cifras).
