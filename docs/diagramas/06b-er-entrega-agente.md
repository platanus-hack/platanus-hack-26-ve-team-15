# 06b · ER del backend: buzón, radio y comandos

Segunda mitad del modelo de datos real (SQLite, `backend/src/store.js`): el buzón de salida (ACK,
MSG_IN, CMD_RESULT), la presencia de egress y la cola de envío por radio (R5), los comandos simulados y
la ventana de 24 h de WhatsApp. `users`, `incidents` y `contacts` vienen de [06a](06a-er-identidad-incidentes.md);
aquí solo se muestra su clave.

Estado: **propuesto (calcado del código)**, sincronizado con `6f254e6`. Fuentes: `store.js`,
`context.js`, `radio.js`, `commands.js`; contrato §5, §5.1 (R2, R5) y §7.

```mermaid
erDiagram
  incidents {
    TEXT sender_id PK "ver 06a"
    TEXT incident_id PK "ver 06a"
  }
  users {
    TEXT sender_id PK "ver 06a"
  }
  contacts {
    TEXT sms "ver 06a"
  }
  mailbox {
    INTEGER id PK "AUTOINCREMENT; API: m_0001"
    TEXT sender_id
    TEXT incident_id
    INTEGER msg_type "3 ACK | 5 MSG_IN | 7 CMD_RESULT"
    INTEGER srv_seq "0 en ACK; 1, 2, ... en 5 y 7"
    INTEGER created_at "purga a las 24 h"
    TEXT packet_b64 "firmado por el servidor"
  }
  presence {
    TEXT egress_id PK
    TEXT cell "geohash de 6"
    INTEGER valid_until "now + valid_s"
  }
  radio_queue {
    INTEGER id PK "AUTOINCREMENT"
    TEXT egress_id "UK 1/2"
    INTEGER mailbox_id "UK 2/2"
  }
  commands {
    TEXT sender_id PK "PK 1/2"
    INTEGER ref PK "PK 2/2, idempotencia"
    TEXT cmd "recargar_saldo, pagar, pedir_ride, ..."
    INTEGER status "0 ok | 1 rechazado | 2 error | 3 desactivada"
    TEXT result_text "[MOCK] ..."
    REAL amount "suma diaria para el tope"
    INTEGER at
  }
  wa_inbound {
    TEXT phone PK "solo dígitos"
    INTEGER at "último mensaje entrante"
  }

  incidents ||--o{ mailbox : "sender_id + incident_id"
  mailbox ||--o{ radio_queue : "mailbox_id"
  presence ||--o{ radio_queue : "egress_id"
  users ||--o{ commands : "sender_id"
  contacts ||--o| wa_inbound : "sms = phone"
```

Como en 06a, el esquema no declara `FOREIGN KEY`: las relaciones son lógicas.

## Claves e índices

| Tabla | Clave / índice | Para qué |
|-------|----------------|----------|
| `mailbox` | `mailbox_lookup (sender_id, incident_id, id)` | `mailbox/poll` por pares y cursor (`next_cursor` = último `id`) |
| `mailbox` | (sin UNIQUE) | Un mismo `seq` puede tener varios ACK (código 2 síncrono y código 1 del agente) |
| `presence` | PK `egress_id` | Una celda vigente por egress; `listPresence` filtra por `valid_until` |
| `radio_queue` | UNIQUE `(egress_id, mailbox_id)` | `INSERT OR IGNORE`: reencolar cada 60 s no duplica |
| `commands` | PK `(sender_id, ref)` | Idempotencia por `(sender_id, ref)` (§7): un `ref` repetido no se re-ejecuta |
| `wa_inbound` | PK `phone` | Si el contacto escribió hace < 24 h, WhatsApp admite texto libre |

## Supuestos / decisiones abiertas

- **El ACK síncrono también va al buzón** (`queueAck`), salvo el de UPDATE: la siguiente baliza ocupa su
  lugar. El ACK de avance (código 1) lo deja `runSosAgent` como otra fila del mismo `seq`.
- **`srv_seq`** sale de `MAX(srv_seq) + 1` sobre los tipos 5 y 7 del incidente (`nextServerSeq`), no de un
  contador en `incidents`.
- **Qué se repite por radio.** Los ACK se empujan una vez; los tipos 5 y 7 se reencolan cada 60 s
  (`radioTick`) hasta que el `rx_cursor` del origen los cubre (`dropRadioCovered`). `GET /v1/egress/inbox`
  borra de `radio_queue` lo que entrega.
- **No hay tablas de acciones del agente ni de respuestas.** Una respuesta de contacto se guarda solo como
  MSG_IN sellado en `mailbox` y como evento `contact_reply`. El texto no se guarda en claro.
- **`commands` siempre es simulado.** Con la bandera apagada igual se guarda la fila con `status = 3`.
- **Monto en `REAL`** (coma flotante). Para un mock alcanza; con dinero real habría que usar unidades
  menores enteras.
