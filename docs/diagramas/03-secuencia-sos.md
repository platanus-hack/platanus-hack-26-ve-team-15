# 03 · Secuencia: SOS de A a backend y ACK de vuelta

Recorrido completo de un SOS: A (sin internet), luego B (relay), luego C (egress), backend y agente;
después, el ACK firmado por el servidor vuelve por el mesh hasta A. Incluye los reintentos (R1) y la
recogida del ACK de avance por el buzón (R2).

Estado: **propuesto**, sincronizado con `6f254e6`. Existen y tienen pruebas: en A, el botón SOS
(`SosScreen`) y `SosSender`, cableado en `EmergencyApp`; el relevo en B y todo el backend. **No existe el cliente egress de C**: subir a
`/v1/egress`, reinyectar y consultar el buzón siguen propuestos. Fuentes: `SosSender.kt`,
`egress.js`, `agent.js`, `context.js`; `contrato.md` §3, §4, §5.1 y §7.

```mermaid
sequenceDiagram
  autonumber
  participant A as A · origen<br/>SosScreen · SosSender
  participant B as B · relay<br/>PacketProcessor
  participant C as C · egress<br/>(cliente propuesto)
  participant API as Backend<br/>egress.js
  participant DB as SQLite<br/>store.js
  participant AG as Agente<br/>agent.js
  participant MB as Buzón<br/>/v1/mailbox/poll

  Note over A: botón SOS → EmergencyApp.startSos<br/>ubicación de SosLocationProvider
  Note over A: start(): SOS seq=1, blob SealedBox.seal a server.seal_pk<br/>EmergencyCodec.sign "BALIZA-V1" · PrefsIncidentStore.save
  Note over A: transport.send(wire, 7) → sendEmergencyPacket<br/>sobre v1, BROADCAST (≤ 512 B)

  A-)B: BitchatPacket 0x30 · ttl sobre 7
  Note over A: R4 UNSENT → SENT si SendResult.SENT
  Note over B: rama EMERGENCY → EmergencyPacketSink<br/>PacketRelayManager reenvía con TTL − 1
  B-)C: ttl sobre 6

  C->>API: POST /v1/egress · packet_b64 + rx {envelope_ttl: 6, egress_id}
  Note over API: tasa egress (429) · forma (400) · registrado (404) · firma (401)

  alt ya visto (getPacket)
    API-->>C: 200 duplicate + mismos bytes del ACK (packets.ack_b64)
  else nuevo
    Note over API: tasa sender (429) · ventana de tiempo (422)
    API->>DB: tx: registrar_incidente (crea incidente) · ACK código 2 · insertPacket · queueAck → mailbox
    API-->>C: 200 accepted + ACK código 2 "El agente gestiona tu caso"
    API-)AG: ctx.defer(runSosAgent)
  end

  C-)B: inyecta ACK · ttl sobre 7
  B-)A: ttl sobre 6
  Note over A: ACK de este incident_id, seq ≥ 1, emisor y firma del servidor ✓<br/>R4 IN_PROGRESS · corta R1 · sigue escuchando

  Note over AG: avisar_contactos por canal (diagrama 4)
  AG->>MB: queueAck código 1 "N contactos avisados"

  Note over C,MB: R2: C consulta el buzón al subir y cada 20 s
  C->>MB: poll {queries: [{sender_id, incident_ids}]}
  MB-->>C: ACK código 2, ACK código 1
  C-)A: inyecta ambos (vía B)
  Note over A: el 2 no retrocede nada · el 1 pasa a CONTACTS_NOTIFIED
```

## Lo que no se ve en el diagrama

- **R1, reintentos** (`SosSender.retryLoop`). Si A no recibe el ACK, reenvía los **mismos bytes**
  (mismo `seq`, misma firma) dentro de un sobre nuevo: cada 15 s durante 2 min, luego cada 60 s; a los
  30 min pasa a `STOPPED`. Un vecino nuevo (`newNeighbors`) reinicia la ventana tras esperar 1 s. A los
  30 s sin ACK, `SENT` pasa a `UNCONFIRMED`.
- **Muerte del proceso.** `PrefsIncidentStore` guarda el paquete y el último estado de ACK; `resume()`
  retoma los reintentos o solo escucha si ya había ACK.
- **Inundación.** bitchat no tiene rutas: B también reenvía hacia A y C hacia sus vecinos. El diagrama
  muestra solo el camino útil.
- **TTL.** El que decide el relevo es el del sobre (`BitchatPacket.ttl`). El `ttl` interno no se firma; el
  backend calcula `hops = ttl interno − envelope_ttl`.
- **R5.** Cada fila nueva del buzón también se encola para los egress cercanos (`pushToRadio`), que la
  recogen con `GET /v1/egress/inbox`. Es la alternativa al poll del paso final (diagrama 4).

## Supuestos / decisiones abiertas

- **⚠ El código reemplaza la decisión 1 (ACK de avance).** Se había aceptado "ACK síncrono con código 0;
  el avance (2 y 1) va por el buzón; el teléfono deduplica por `(incident_id, seq, category)`". Lo
  implementado es:
  - El ACK síncrono de un SOS o UPDATE lleva **código 2**; el de MSG_OUT y CMD, código 0 (código 3 si el
    blob no abre); el de un UPDATE que cierra (severity 0), código 0.
  - El código 1 llega después por el buzón, como otra fila del mismo `seq`.
  - `duplicate` devuelve los **bytes del primer ACK** (código 2), no "el más reciente".
  - El teléfono no deduplica: ordena por rango (`recibido < en_gestion < contactos_avisados`; `rechazado`
    es final) y nunca retrocede. Esto ya está en `contrato.md` §5.1 (R4).
  
  Propuesta: adoptar el código y dar de baja la decisión 1. Queda pendiente el ejemplo de §8, que trae
  código 1 en el ACK síncrono (punto 1 en `README.md`).
- **Quién crea el incidente: resuelto.** `/v1/egress` llama a `registrarIncidente` dentro de la misma
  transacción; el agente diferido ya lo encuentra creado.
- **El agente corre después de responder** (`ctx.defer`), en el mismo proceso. El ACK no espera al LLM.
- **El ACK de UPDATE no va al buzón:** la siguiente baliza ocupa su lugar (R6). Hoy el teléfono no envía
  UPDATE.
- **R1 del egress (bandeja R3)** y su manejo de 4xx y 429 siguen sin código.
