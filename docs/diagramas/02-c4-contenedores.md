# 02 · C4 nivel 2: contenedores

Las piezas desplegables de Baliza Vital y cómo se hablan: la app Android en capas (UI, módulo Baliza,
`EmergencyMeshTransport`, mesh de bitchat), el backend en módulos, la base de datos y el dashboard.
Muestra qué existe ya en el código y qué está propuesto.

Estado: **propuesto**. Sincronizado con `431db2d`. Existen el backend (`backend/src/`), el panel
(`dashboard/`) y, en Android, el transporte, el módulo Baliza (`codec`, `crypto`, `identity`,
`registration`, `sos`) y los ganchos de bitchat. Faltan la UI SOS, el cliente egress y el cableado en la
app.

```mermaid
flowchart LR
  classDef exists fill:#1168bd,stroke:#0b4884,color:#fff
  classDef partial fill:#cfe3f7,stroke:#1168bd,color:#0b4884
  classDef proposed fill:#fff,stroke:#1168bd,color:#0b4884,stroke-dasharray:5 5
  classDef ext fill:#8a8a8a,stroke:#5e5e5e,color:#fff

  otros["Otros teléfonos<br/>relay / egress"]:::ext

  subgraph phone["Teléfono Android · app com.baliza.vital"]
    ui["UI Compose<br/>[bitchat + pantalla SOS]"]:::proposed
    sos["Módulo Baliza<br/>[Kotlin]<br/>SosSender · EmergencyCodec<br/>SealedBox · UserIdentityStore<br/>RegistrationClient · IncidentStore"]:::partial
    egr["Cliente egress<br/>[Kotlin]<br/>subida, buzón R2, bandeja R3"]:::proposed
    emt["EmergencyMeshTransport<br/>[interfaz Kotlin]<br/>BleEmergencyMeshTransport"]:::exists
    mesh["Mesh bitchat<br/>[Kotlin]<br/>BluetoothMeshService<br/>PacketProcessor · PacketRelayManager"]:::exists
  end

  subgraph cloud["Backend · Node 22, node:http · Render"]
    api["Rutas HTTP<br/>[api.js]<br/>egress.js · users.js · mailbox.js"]:::exists
    crypto["Codec y crypto<br/>[codec.js · crypto.js]<br/>Ed25519, crypto_box_seal"]:::exists
    ag["Agente y comandos<br/>[agent.js · commands.js]<br/>plan fijo, mocks, ctx.defer"]:::exists
    mb["Buzón y radio<br/>[context.js · radio.js]<br/>tipos 3, 5, 7 · R5"]:::exists
    canal["Canales y respuestas<br/>[channels.js · replies.js · llm.js]"]:::exists
  end

  db[("SQLite<br/>[store.js · node:sqlite]<br/>disco de Render · 6a y 6b")]:::exists
  dash["Dashboard<br/>[web estática · Leaflet]<br/>/v1/incidents · /v1/stream"]:::exists
  prov["Proveedores<br/>Claude · Kapso · Twilio<br/>Resend · ElevenLabs"]:::ext

  ui --> sos
  sos -->|"send / incoming /<br/>newNeighbors"| emt
  sos -->|"HTTPS · POST /v1/users"| api
  egr -->|"incoming / send"| emt
  emt -->|"setEmergencySink · sendEmergencyPacket<br/>setEmergencyNeighborListener"| mesh
  mesh <-->|"BLE · 0x30"| otros
  egr -->|"HTTPS · /v1/egress<br/>/v1/mailbox/poll"| api
  api --> crypto
  api --> ag
  api --> mb
  ag --> mb
  ag --> canal
  canal --> prov
  prov -.->|"webhook: respuesta"| api
  api --> db
  dash -->|"lectura + SSE"| api
```

Leyenda: relleno azul = existe y se usa; azul claro = existe pero sin conectar a la app; borde
punteado = propuesto. Todos los módulos del backend usan `store.js`; para no cruzar flechas, solo se
dibuja una hacia la base.

## Capas de la app

| Capa | Paquete / clase | Responsabilidad | Estado |
|------|-----------------|-----------------|--------|
| UI | bitchat Compose + pantalla SOS | Categoría, severidad, texto, estados R4, CMD | Propuesto |
| Módulo Baliza | `com.baliza.emergency.{codec,crypto,identity,registration,sos}` | `EmergencyCodec` (§3, firma `BALIZA-V1`), `SealedBox` (compatible con libsodium), `UserIdentityStore` (llaves propias y del servidor, `SecurePrefs`), `RegistrationClient` (`POST /v1/users`), `SosSender` (R1, R4, ACK), `PrefsIncidentStore` (sobrevive a la muerte del proceso) | **Existe, sin conectar**. Faltan UPDATE/baliza R6, MSG_OUT, CMD, dictado y lectura en voz alta |
| Cliente egress | (sin código) | `POST /v1/egress`, `POST /v1/mailbox/poll` (R2), bandeja de salida (R3), presencia e inbox (R5) | Propuesto |
| Transporte | `EmergencyMeshTransport`, `BleEmergencyMeshTransport` | `send(payload, ttl): SendResult`, `incoming`, `newNeighbors` | **Existe** |
| Mesh | `BluetoothMeshService.setEmergencySink` / `sendEmergencyPacket` / `setEmergencyNeighborListener`, `PacketProcessor` (rama `EMERGENCY`), `PacketRelayManager` | Sobre v1, BROADCAST, firma del sobre, relevo con TTL − 1, aviso de vecino nuevo | **Existe** |

## Módulos del backend

| Módulo | Archivo | Rutas o papel |
|--------|---------|---------------|
| Rutas | `api.js`, `http.js`, `server.js` | Ensamblado, CORS, tokens de panel y admin |
| Registro | `users.js` | `POST /v1/users`, `PUT /v1/users/{id}/contacts` |
| Egress | `egress.js` | `POST /v1/egress` (validación, idempotencia, ACK síncrono) |
| Buzón | `mailbox.js`, `context.js` | `POST /v1/mailbox/poll`; `queueAck`, `queueMsgIn`, `queueCmdResult` |
| Radio (R5) | `radio.js` | `POST /v1/egress/presence`, `GET /v1/egress/inbox`, repetición cada 60 s |
| Agente | `agent.js`, `llm.js`, `prompts/alert-writer.txt` | `registrar_incidente`, `avisar_contactos`, `consultar_alertas`, `runSosAgent` |
| Comandos | `commands.js` | CMD → CMD_RESULT con mocks y banderas |
| Respuestas | `replies.js`, `tokens.js`, `reply-page.html` | `/r/{token}`, `/v1/replies`, `/v1/webhooks/whatsapp`, `/v1/webhooks/sms` |
| Canales | `channels.js` | WhatsApp (Kapso), SMS (Twilio), correo (Resend), voz (ElevenLabs) o consola |
| Panel | `api.js` | `GET /v1/incidents`, `/v1/incidents/{sender}/{incident}`, `/v1/events`, `/v1/stream` (SSE) |
| Datos | `store.js` | Todo el SQL (diagramas 6a y 6b) |

## Supuestos / decisiones abiertas

- **Cableado pendiente en Android.** Nadie llama todavía a `BleEmergencyMeshTransport.over(mesh)` ni crea
  un `SosSender`: el módulo Baliza solo corre en pruebas. Es lo que falta para la Fase 2 en el teléfono.
- **No hay cliente egress.** Ningún código del teléfono llama a `/v1/egress` ni a `/v1/mailbox/poll`. El
  backend se prueba con `scripts/post-vector.mjs`.
- **El agente no es un worker aparte.** `ctx.defer` corre en el mismo proceso, después de responder al
  egress. Si el proceso se reinicia, el aviso en curso se pierde (el `SIGTERM` espera 10 s).
- **Una sola instancia.** El límite de tasa, la cola diferida y el bus del SSE viven en memoria, y el
  disco de Render no se comparte. Ver punto 14 en `README.md` (SQLite en lugar de Postgres).
- **Stack distinto de `reparto.md`.** Se propuso Node + TypeScript + Express + Postgres; el código usa
  JavaScript (ESM), `node:http` sin framework y SQLite. `reparto.md` permitía cambiarlo avisando: solo
  queda registrado.
