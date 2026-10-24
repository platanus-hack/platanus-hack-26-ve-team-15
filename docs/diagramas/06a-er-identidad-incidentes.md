# 06a · ER del backend: identidad, incidentes y avisos

Primera mitad del modelo de datos real del backend (SQLite, `backend/src/store.js`): usuarios y
contactos, incidentes, paquetes recibidos (la tabla de idempotencia), avisos a contactos y eventos.
La segunda mitad (buzón, radio, comandos, ventana de WhatsApp) está en [06b](06b-er-entrega-agente.md).

Estado: **propuesto (calcado del código)**, sincronizado con `6f254e6`. Fuente: el `SCHEMA` de
`store.js`; contrato §3, §4, §6 y §7.

```mermaid
erDiagram
  users {
    TEXT sender_id PK "16 hex = SHA-256(sign_pk)[0..8]"
    TEXT display_name
    BLOB sign_pk "Ed25519, 32 B"
    BLOB seal_pk "X25519, 32 B"
    INTEGER created_at "epoch s"
  }
  contacts {
    TEXT sender_id PK "PK 1/2"
    INTEGER idx PK "PK 2/2, 0..31"
    TEXT name
    TEXT relation "nullable"
    TEXT lang "es | en"
    TEXT sms "nullable; también WhatsApp"
    TEXT email "nullable"
    TEXT voice "nullable"
    TEXT status "pending_verification | verified"
  }
  incidents {
    TEXT sender_id PK "PK 1/2"
    TEXT incident_id PK "PK 2/2, 16 hex"
    INTEGER category "0..7"
    INTEGER severity "0..3"
    INTEGER lat "int32 x 1e5, nullable"
    INTEGER lon "int32 x 1e5, nullable"
    INTEGER accuracy_m
    INTEGER loc_timestamp "timestamp - location_age"
    TEXT public_text
    TEXT note "descifrada del blob"
    TEXT status "open | closed"
    INTEGER hops
    TEXT egress_id "último que subió"
    INTEGER blob_readable "0 | 1"
    INTEGER last_seq
    INTEGER notified_count "contactos alcanzados"
    INTEGER rx_cursor "recibo del origen (R6)"
    INTEGER created_at
    INTEGER updated_at
  }
  packets {
    TEXT sender_id PK "PK 1/4"
    TEXT incident_id PK "PK 2/4"
    INTEGER seq PK "PK 3/4"
    INTEGER msg_type PK "PK 4/4"
    TEXT ack_b64 "bytes del ACK, se repiten en duplicate"
    TEXT egress_id
    INTEGER envelope_ttl
    INTEGER hops
    INTEGER rx_at
  }
  notifications {
    INTEGER id PK "AUTOINCREMENT"
    TEXT sender_id
    TEXT incident_id
    INTEGER contact_idx
    TEXT channel "sms | email | voice"
    TEXT state "sent | simulated | failed | no_address | skipped_unverified | delivered | read"
    TEXT detail "proveedor; en WhatsApp lleva :wamid: + id"
    INTEGER at
  }
  events {
    INTEGER id PK "AUTOINCREMENT, id del SSE"
    INTEGER at
    TEXT kind "packet_received, incident_created, contacts_notified, ..."
    TEXT sender_id "nullable"
    TEXT incident_id "nullable"
    TEXT data "JSON"
  }

  users ||--o{ contacts : "sender_id"
  users ||--o{ incidents : "sender_id"
  incidents ||--o{ packets : "sender_id + incident_id"
  incidents ||--o{ notifications : "sender_id + incident_id"
  contacts ||--o{ notifications : "sender_id + contact_idx"
  incidents ||--o{ events : "incident_id"
```

Las relaciones son **lógicas**: el esquema no declara `FOREIGN KEY`. Se unen por las columnas que
indica cada línea.

## Claves e índices

| Tabla | Clave / índice | Para qué |
|-------|----------------|----------|
| `users` | PK `sender_id` | Búsqueda por el `sender_id` del paquete (404 si no existe) |
| `contacts` | PK `(sender_id, idx)` | `contact_mask` e índices 0..31; `replaceContacts` borra y reinserta todo |
| `incidents` | PK `(sender_id, incident_id)` | Un incidente por par; `listIncidents` ordena por `updated_at` sin índice |
| `packets` | PK `(sender_id, incident_id, seq, msg_type)` | **Idempotencia** (§3.4): si existe, `duplicate` con `ack_b64` tal cual |
| `notifications` | solo PK `id` | Historial de avisos; `findNotifiedIncidentByPhone` une con `contacts` |
| `events` | solo PK `id` | Línea de tiempo del panel y cursor del SSE (`Last-Event-ID`) |

## Supuestos / decisiones abiertas

- **⚠ SQLite en lugar de Postgres + PostGIS** (punto 14 en `README.md`). El encargo pedía tipos de
  PostgreSQL, índices y PostGIS, y `reparto.md` proponía Postgres. El código usa `node:sqlite` en el disco
  de Render: no hay `geography`, las coordenadas son `INTEGER × 1e5` y las distancias se calculan en JS
  (haversine en `agent.js` y `radio.js`). `store.js` es el único punto de acceso, así que pasar a Postgres
  es reimplementar esa clase. Propuesta: SQLite para el demo; Postgres solo si hace falta más de una
  réplica.
- **Ids en hex.** `sender_id` e `incident_id` se guardan como `TEXT` de 16 caracteres hex, no como 8 B.
- **No hay tabla de tracking.** Cada UPDATE pisa la ubicación de `incidents`; la trayectoria solo queda en
  `events` (si el evento la trae). El panel muestra la última posición.
- **No se guarda el paquete crudo**, solo su ACK. Los paquetes rechazados (400, 401, 404, 422, 429) no
  dejan fila.
- **`note` en claro.** El backend descifra el `sealed_blob`, así que la nota queda en claro en la base. La
  retención de incidentes sigue sin definir (el buzón purga a las 24 h).
- **Contactos verificados.** Con canales reales solo se avisa a `verified` (o con
  `ALLOW_UNVERIFIED_CONTACTS=true`). Un contacto pasa a `verified` al responder o por
  `POST /v1/admin/contacts/verify`, y vuelve a `pending_verification` si cambia algún canal.
- **Llaves del servidor fuera de la base:** `server-keys.json` en el disco o `BALIZA_SIGN_SEED_HEX` y
  `BALIZA_SEAL_SK_HEX` en el entorno.
