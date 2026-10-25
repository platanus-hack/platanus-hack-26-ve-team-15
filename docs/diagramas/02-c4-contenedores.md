# 02 · C4 nivel 2: contenedores

Las piezas desplegables de Meshy y cómo se hablan: la app Android en capas (UI, módulo Baliza,
`EmergencyMeshTransport`, mesh de bitchat), el backend en módulos, la base de datos y el dashboard.
Muestra qué existe ya en el código y qué está propuesto.

Estado: **propuesto**. Sincronizado con `6f254e6`. Existen el backend (`backend/src/`), el panel
(`dashboard/`) y, en Android, la interfaz Baliza (`com.baliza.emergency.ui`), el módulo Baliza cableado en
`EmergencyApp`, el transporte y los ganchos de bitchat. **Falta el cliente egress.**

```mermaid
flowchart LR
  classDef exists fill:#1168bd,stroke:#0b4884,color:#fff
  classDef proposed fill:#fff,stroke:#1168bd,color:#0b4884,stroke-dasharray:5 5
  classDef ext fill:#8a8a8a,stroke:#5e5e5e,color:#fff

  otros["Otros teléfonos<br/>relay / egress"]:::ext

  subgraph phone["Teléfono Android · app com.baliza.vital"]
    ui["Interfaz Baliza<br/>[Compose]<br/>BalizaRoot · RegistrationScreen<br/>SosScreen · DebugScreen"]:::exists
    sos["Módulo Baliza<br/>[Kotlin]<br/>EmergencyApp · SosSender<br/>EmergencyCodec · SealedBox<br/>UserIdentityStore · RegistrationClient"]:::exists
    egr["Cliente egress<br/>[Kotlin]<br/>subida, buzón R2, bandeja R3"]:::proposed
    emt["EmergencyMeshTransport<br/>[interfaz Kotlin]<br/>BleEmergencyMeshTransport"]:::exists
    mesh["Mesh bitchat<br/>[Kotlin]<br/>BluetoothMeshService<br/>PacketProcessor · PacketRelayManager"]:::exists
  end

  subgraph cloud["Backend · Node 22, node:http · Render"]
    api["Rutas HTTP<br/>[api.js · routes/]<br/>egress.js · users.js · mailbox.js"]:::exists
    crypto["Codec y crypto<br/>[codec.js · crypto.js]<br/>Ed25519, crypto_box_seal"]:::exists
    ag["Agente y comandos<br/>[agent.js · commands.js]<br/>plan fijo, mocks, ctx.defer"]:::exists
    mb["Buzón y radio<br/>[context.js · radio.js]<br/>tipos 3, 5, 7 · R5"]:::exists
    canal["Canales y respuestas<br/>[channels.js · replies.js · llm.js]"]:::exists
  end

  db[("SQLite<br/>[store.js · node:sqlite]<br/>disco de Render · 6a y 6b")]:::exists
  dash["Dashboard<br/>[web estática · Leaflet]<br/>/v1/incidents · /v1/stream"]:::exists
  prov["Proveedores<br/>Claude · Kapso · Twilio<br/>Resend · ElevenLabs"]:::ext

  ui -->|"BalizaViewModel"| sos
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

Leyenda: relleno azul = existe; borde punteado = propuesto. Todos los módulos del backend usan `store.js`; para no cruzar flechas, solo se
dibuja una hacia la base.

## Capas de la app

| Capa | Paquete / clase | Responsabilidad | Estado |
|------|-----------------|-----------------|--------|
| UI | `com.baliza.emergency.ui`: `BalizaRoot`, `RegistrationScreen`, `SosScreen`, `DebugScreen`, `BalizaViewModel` | Registro con contactos, botón SOS (categoría, gravedad, texto público ≤ 60 B, nota cifrada, a quién avisar), estado R4 y cancelar. En builds de depuración: URL del servidor, paquete de prueba, paquetes oídos, borrar registro y acceso al chat de bitchat | **Existe**. Reemplaza al chat de bitchat como pantalla de inicio (`MainActivity`). Faltan MSG_IN, CMD, dictado y lectura en voz alta |
| Pila de emergencia | `com.baliza.emergency.app`: `EmergencyApp` (una por proceso), `ContactStore`, `ApiSettings`, `SosLocationProvider` | Arma transporte, `SosSender` y registro; guarda los contactos cifrados; URL del backend (de la build, `BALIZA_API_URL`, o cambiada en depuración); ubicación para el SOS | **Existe** |
| Módulo Baliza | `com.baliza.emergency.{codec,crypto,identity,registration,sos}` | `EmergencyCodec` (§3, firma `BALIZA-V1`), `SealedBox` (compatible con libsodium), `UserIdentityStore` (llaves propias y del servidor, `SecurePrefs`), `RegistrationClient` (`POST /v1/users`), `SosSender` (R1, R4, ACK), `PrefsIncidentStore` (sobrevive a la muerte del proceso) | **Existe y se usa**. Faltan UPDATE/baliza R6, MSG_OUT y CMD |
| Cliente egress | (sin código) | `POST /v1/egress`, `POST /v1/mailbox/poll` (R2), bandeja de salida (R3), presencia e inbox (R5) | Propuesto |
| Transporte | `EmergencyMeshTransport`, `BleEmergencyMeshTransport` | `send(payload, ttl): SendResult`, `incoming`, `newNeighbors`; `rebind()` si `MeshServiceHolder` cambia la instancia del mesh | **Existe** |
| Mesh | `BluetoothMeshService.setEmergencySink` / `sendEmergencyPacket` / `setEmergencyNeighborListener`, `PacketProcessor` (rama `EMERGENCY`), `PacketRelayManager` | Sobre v1, BROADCAST, firma del sobre, relevo con TTL − 1, aviso de vecino nuevo | **Existe** |

## Módulos del backend

| Módulo | Archivo | Rutas o papel |
|--------|---------|---------------|
| Ensamblado | `api.js`, `http.js`, `server.js` | Contexto y servidor HTTP, CORS |
| Rutas | `routes/{index,helpers,users,mesh,replies,admin,dashboard}.js` | Tabla de rutas por tema; tokens de panel y admin en `helpers.js` |
| Registro | `users.js` (rutas en `routes/users.js`) | `POST /v1/users`, `PUT /v1/users/{id}/contacts` |
| Egress | `egress.js` (rutas en `routes/mesh.js`) | `POST /v1/egress` (validación, idempotencia, ACK síncrono) |
| Buzón | `mailbox.js`, `context.js` (rutas en `routes/mesh.js`) | `POST /v1/mailbox/poll`; `queueAck`, `queueMsgIn`, `queueCmdResult` |
| Radio (R5) | `radio.js` (rutas en `routes/mesh.js`) | `POST /v1/egress/presence`, `GET /v1/egress/inbox`, repetición cada 60 s |
| Agente | `agent.js`, `llm.js`, `prompts/alert-writer.txt` | `registrar_incidente`, `avisar_contactos`, `consultar_alertas`, `runSosAgent` |
| Comandos | `commands.js` | CMD → CMD_RESULT con mocks y banderas |
| Respuestas | `replies.js`, `tokens.js`, `reply-page.html` (rutas en `routes/replies.js`) | `/r/{token}`, `/v1/replies`, `/v1/webhooks/whatsapp`, `/v1/webhooks/sms` |
| Admin | `routes/admin.js` | `POST /v1/admin/contacts/verify`, `POST /v1/dev/simulate-reply` |
| Canales | `channels.js` | WhatsApp (Kapso), SMS (Twilio), correo (Resend), voz (ElevenLabs) o consola |
| Panel | `routes/dashboard.js` | `GET /v1/incidents`, `/v1/incidents/{sender}/{incident}`, `/v1/events`, `/v1/stream` (SSE) |
| Datos | `store.js` | Todo el SQL (diagramas 6a y 6b) |

## Supuestos / decisiones abiertas

- **No hay cliente egress: es lo que falta para la Fase 2 en el teléfono.** El SOS ya sale de A por el
  mesh, pero ningún código del teléfono llama a `/v1/egress` ni a `/v1/mailbox/poll`, así que nada llega
  al backend desde el mesh. El backend se prueba con `scripts/post-vector.mjs`.
- **`EmergencyApp` vive fuera de las pantallas.** Una instancia por proceso arma la pila al arrancar
  (fuera del hilo principal, por el keystore) y la UI solo la observa, para que los reintentos R1 no
  dependan de una pantalla abierta. Cada 5 s comprueba si `MeshServiceHolder` cambió el mesh y, si es
  así, vuelve a enganchar el transporte (`rebind()`).
- **El chat de bitchat sigue debajo.** Su motor de mesh corre igual; la pantalla de chat solo se abre
  desde el panel de depuración.
- **El agente no es un worker aparte.** `ctx.defer` corre en el mismo proceso, después de responder al
  egress. Si el proceso se reinicia, el aviso en curso se pierde (el `SIGTERM` espera 10 s).
- **Una sola instancia.** El límite de tasa, la cola diferida y el bus del SSE viven en memoria, y el
  disco de Render no se comparte. Ver punto 14 en `README.md` (SQLite en lugar de Postgres).
- **Stack distinto de `reparto.md`.** Se propuso Node + TypeScript + Express + Postgres; el código usa
  JavaScript (ESM), `node:http` sin framework y SQLite. `reparto.md` permitía cambiarlo avisando: solo
  queda registrado.
