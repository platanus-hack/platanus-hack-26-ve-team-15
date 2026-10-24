# Contrato Baliza Vital (v1, borrador para congelar)

Este documento es el contrato entre Android, backend, agente IA y dashboard. Una vez
congelado, un cambio requiere acuerdo de los cuatro roles y subir `version`.

Todos los datos de ejemplo son **sintéticos**. Los bytes de `sealed_blob` en los ejemplos son
relleno del largo correcto (no es un sealed box real); las firmas Ed25519 sí son reales.
Los ejemplos se regeneran con `node docs/examples/generate-examples.mjs` y quedan en
`docs/examples/examples.json` (vectores para pruebas en Kotlin y en el backend).

## 0. Decisiones

| ID | Decisión | Estado |
|----|----------|--------|
| D-1 | **Tipo portador**: el paquete viaja como `MessageType.EMERGENCY = 0x30` (aditivo), broadcast con `recipientID = BROADCAST` (8 × `0xFF`, como `FILE_TRANSFER`), sobre v1. Ver §2. | **Cerrada** |
| D-2 | **Sin topología forzada**: el mesh no se limita a una cadena; no hay modo "Topología Demo". Lo que importa es que el ACK llegue al origen (§5.1). | **Cerrada** |

Pendiente de confirmar en dispositivos: que el paquete cruce un salto BLE real (A–B–C). La parte de software (firma del sobre, despacho y relevo) ya está verificada en código y en pruebas (§2).

## 1. Alcance y principios

- Un teléfono **sin internet** emite paquetes; el mesh BLE de bitchat los retransmite; un
  teléfono **con internet** (egress) los sube al backend.
- Identidad y criptografía de bitchat (Noise, fragmentación, identidad de pares) **no se tocan**.
  Nuestras llaves son **independientes** de la identidad de bitchat.
- La confidencialidad de los datos sensibles es de extremo a extremo: lo sensible va en
  `sealed_blob`; los nodos del mesh solo ven la parte pública (`public_text` ≤ 60 B y metadatos).
- Todo en big-endian.

## 2. Transporte dentro de bitchat

Nuestro paquete (el "paquete interno") es el `payload` de un `BitchatPacket` de bitchat.

**Hallazgos verificados en el código** (`apps/android`, commit upstream `dfc67dad`):

| Tema | Hallazgo | Consecuencia |
|------|----------|--------------|
| Firma del sobre | `signPacketBeforeBroadcast` firma los paquetes de broadcast: +64 B | Se presupuesta siempre |
| Cabecera | v1: 14 B + `senderID` 8 B; `recipientID` opcional +8 B | Se presupuesta el caso con destinatario |
| Ruta | `route` solo existe en v2 y suma 1 + 8·N B | No se usa: sobre v1 |
| Fragmentación | `FragmentManager.createFragments` fragmenta si el frame **sin relleno** mide **> 512 B** | Presupuesto: sobre ≤ 512 B |
| Relleno | `BLEPacketPaddingPolicy` solo rellena tipos Noise | No afecta a nuestro tipo |
| Compresión | Se intenta si el payload ≥ 100 B y la entropía lo permite; solo se usa si el resultado es más pequeño, y añade un campo de 2 B | Peor caso +1 B; se deja margen de 6 B |
| Firma del sobre en `EMERGENCY` | `SecurityManager.verifyPacketSignature` solo exige la llave del emisor (aprendida del `ANNOUNCE`) para ANNOUNCE, MESSAGE, FILE_TRANSFER, VOICE_FRAME y LEAVE; el resto devuelve `true` | Un nodo intermedio **no necesita conocer al emisor** para reenviar un `EMERGENCY`. A cambio, el sobre no autentica: la autenticidad es solo la firma Ed25519 **interna**, que verifica el backend. Un nodo puede inyectar tráfico `EMERGENCY` falso que se reenvía hasta el TTL; el backend lo descarta (401) y aplica límite de tasa |
| Despacho y relevo | `EMERGENCY` va en la rama pública de `PacketProcessor`; el relevo común lo reenvía con TTL − 1. Probado en `EmergencyPacketTest` (con sumidero, sin él y con sumidero que falla) | Todos los nodos, también los que solo retransmiten, ven el paquete |
| Ruta y destinatario | `applyRouteIfAvailable` solo agrega ruta v2 si el destinatario no es nulo ni BROADCAST | Con `recipientID = BROADCAST` el sobre sigue en v1 y el presupuesto de 418 B es válido |
| TTL | El relevo exige `ttl ≥ 4` o red pequeña/probabilidad (`PacketRelayManager`); TTL por defecto 7 | Se emite con el TTL por defecto (7). Sin topología forzada (ver §3.2) |

**D-1 (cerrada):** añadir `MessageType.EMERGENCY = 0x30` (cambio aditivo en el enum y una rama
en `PacketProcessor` que entrega el payload a `EmergencyMeshTransport`). No toca Noise,
fragmentación ni identidad. Alternativas descartadas: `MESSAGE` (aparece en el chat público) y
`FILE_TRANSFER` (se interpreta como archivo).

### 2.1 Presupuesto de tamaño

```
sobre bitchat sin fragmentar ≤ 512 B
  = 14 (cabecera v1) + 8 (sender) + [8 recipient] + payload + 64 (firma del sobre)
payload máximo con recipient = 512 - 14 - 8 - 8 - 64 = 418 B   <- límite del contrato
```

**Límite del paquete interno: 418 B** (sirve con y sin `recipientID`). Con 106 B de campos fijos
(cabecera 39 + longitudes 3 + firma 64), quedan 312 B para `public_text + sealed_blob`.

| Tipo | `public_text` | `sealed_blob` máx. | Plaintext máx. | Tamaño máx. |
|------|---------------|--------------------|----------------|-------------|
| SOS (1) | ≤ 60 | 252 | 204 | 418 |
| UPDATE (2) | ≤ 60 | 252 | 204 | 418 |
| ACK (3) | ≤ 60 | 0 | 0 | 166 |
| MSG_OUT (4) | 0 | 312 | 264 | 418 |
| MSG_IN (5) | 0 | 312 | 264 | 418 |
| CMD (6) | 0 | 312 | 264 | 418 |
| CMD_RESULT (7) | 0 | 312 | 264 | 418 |

`sealed_blob = plaintext + 48 B` (sobre `crypto_box_seal`: llave efímera de 32 B + MAC de 16 B).
Peor caso medido con el generador: SOS de 60 B de texto y 252 B de blob = **418 B interno, 504 B de
sobre** (512 B con `recipientID`).

La fragmentación de bitchat (13 B de cabecera por fragmento, hasta 469 B de datos, hasta 256
fragmentos por mensaje) está permitida como contingencia, pero **el SOS no depende de ella**: un
solo paquete BLE llega antes y con menos pérdida.
**Prueba obligatoria (Fase 1):** test unitario que envuelve el SOS de peor caso en un
`BitchatPacket` (con firma y `recipientID`) y verifica que `toBinaryData()` mide ≤ 512 B.

## 3. Paquete binario

### 3.1 Formato

| Offset | Tamaño | Campo | Descripción |
|--------|--------|-------|-------------|
| 0 | 1 | `version` | `1` |
| 1 | 1 | `msg_type` | 1..7 (ver §3.3) |
| 2 | 1 | `ttl` | Presupuesto de saltos inicial. **Fuera de la firma** |
| 3 | 8 | `incident_id` | Aleatorio, lo elige el teléfono al crear el incidente |
| 11 | 2 | `seq` | uint16, secuencial por incidente. En ACK, `seq` confirmado |
| 13 | 1 | `category` | §3.2. En ACK es el código de ACK |
| 14 | 1 | `severity` | 0..3 |
| 15 | 4 | `lat` | int32 ×1e5 (grados). `-2147483648` = sin ubicación |
| 19 | 4 | `lon` | int32 ×1e5 |
| 23 | 2 | `accuracy_m` | uint16, metros |
| 25 | 2 | `location_age` | uint16, segundos desde el fix (satura en 65535) |
| 27 | 4 | `timestamp` | uint32, segundos Unix |
| 31 | 8 | `sender_id` | §3.4 |
| 39 | 1 | `text_len` | 0..60 |
| 40 | n | `public_text` | UTF-8, sin cifrar |
| 40+n | 2 | `blob_len` | uint16 |
| 42+n | m | `sealed_blob` | `crypto_box_seal` al destinatario (§3.5) |
| 42+n+m | 64 | `signature` | Ed25519 |

**Firma:** `Ed25519(sk, "BALIZA-V1" || bytes[0..2) || bytes[3..inicio_firma))`. Es decir, todo el
paquete menos `ttl` y la firma, con un prefijo de dominio. El `ttl` queda fuera para poder
reescribirlo sin romper la firma.

Rangos de `category`: `0` sin categoría, `1` médica, `2` incendio, `3` seguridad/violencia,
`4` accidente, `5` desastre natural, `6` atrapado/perdido, `7` otra.
Códigos de ACK (`category` en `msg_type=3`): `0` recibido, `1` contactos avisados,
`2` en gestión por el agente, `3` rechazado.

### 3.2 TTL: qué significa y dónde se aplica

- El **relevo real** lo decide el `ttl` del **sobre** de bitchat (`BitchatPacket.ttl`, por defecto 7),
  que cada nodo decrementa. Se emite con el valor por defecto (7).
- El `ttl` **interno** copia el valor inicial. Sirve para medir saltos: 
  `saltos = ttl_interno − ttl_del_sobre_al_recibir`. El egress envía el TTL del sobre al backend (§4).
- El `ttl` interno no está firmado y no se confía en él para decisiones de seguridad.

### 3.3 Tipos de mensaje

| Valor | Nombre | Sentido | `sealed_blob` sellado a | Contenido del plaintext |
|-------|--------|---------|-------------------------|-------------------------|
| 1 | SOS | teléfono → backend | servidor | `contact_mask`(4) · `channels`(1) · `rx_cursor`(2) · nota UTF-8 |
| 2 | UPDATE | teléfono → backend | servidor | igual que SOS (también es la baliza de R6) |
| 3 | ACK | backend → teléfono | (sin blob) | — |
| 4 | MSG_OUT | teléfono → contactos | servidor | `contact_idx`(1, `0xFF`=todos) · `channels`(1) · texto UTF-8 |
| 5 | MSG_IN | contacto → teléfono | usuario | `contact_idx`(1) · `channel`(1) · texto UTF-8 |
| 6 | CMD | teléfono → agente | servidor | JSON UTF-8 `{"cmd","ref","args"}` |
| 7 | CMD_RESULT | agente → teléfono | usuario | `ref`(2) · `status`(1) · texto UTF-8 |

`channels` es una máscara: `1` sms, `2` email, `4` llamada de voz.
`contact_mask` es un bitmask uint32 de índices de contacto 0..31.
`rx_cursor` (uint16) es el mayor `seq` contiguo de mensajes del servidor tipo 5 o 7 que el teléfono
ya recibió para ese incidente (`0` si ninguno). Es el recibo que detiene el envío por radio (R5).
Para los tipos 5 y 7 el `seq` es un contador del servidor por incidente, independiente del `seq` del
teléfono. Con `rx_cursor` en el plaintext, la nota de SOS/UPDATE admite como máximo 197 B.
En un UPDATE, `severity = 0` significa que el usuario cerró el incidente (R6).
`status` de CMD_RESULT: `0` ok, `1` rechazado, `2` error, `3` función desactivada (feature flag).
`cmd` ∈ `consultar_alertas`, `recargar_saldo`, `pagar`, `pedir_ride`, `pedir_delivery`.

### 3.4 Identidad y llaves

- Cada usuario genera en la app un par **Ed25519** (firma) y uno **X25519** (sellado). Son
  **independientes de la identidad de bitchat**.
- `sender_id = SHA-256(ed25519_pk)[0..8]`.
- El servidor publica `sign_pk` (Ed25519) y `seal_pk` (X25519) con un `key_id`; la app los guarda
  al registrarse (§6). `sender_id` del servidor se deriva igual.
- **Clave de idempotencia:** `(sender_id, incident_id, seq, msg_type)`.
- Paquetes del servidor al teléfono (ACK, MSG_IN, CMD_RESULT) usan `sender_id` del servidor; el
  teléfono los acepta solo si la firma es del servidor y el `incident_id` es uno suyo.

### 3.5 Cifrado

- `sealed_blob` hacia el servidor: `crypto_box_seal(plaintext, server.seal_pk)`.
- `sealed_blob` hacia el usuario (MSG_IN, CMD_RESULT): `crypto_box_seal(plaintext, user.seal_pk)`.
- No hay conversión Ed25519→X25519: el registro envía ambas llaves.
- Reglas del backend: rechazar si `|ahora − timestamp|` es futuro > 10 min o pasado > 7 días,
  si la firma no valida, o si `sender_id` no está registrado.

## 4. API egress → backend

`POST /v1/egress`

```json
{
  "packet_b64": "<paquete interno en base64>",
  "rx": { "envelope_ttl": 1, "egress_id": "egress-demo-01", "rx_at": 1798200042 }
}
```

Respuesta `200`:

```json
{
  "status": "accepted",
  "incident_id": "0a68279fb49bde12",
  "seq": 1,
  "ack_packet_b64": "<paquete ACK firmado por el servidor>"
}
```

`status` ∈ `accepted` | `duplicate` (misma clave de idempotencia: se devuelve el mismo ACK).
El egress inyecta `ack_packet_b64` en el mesh (§5 describe el buzón para el resto).

| Código | Causa |
|--------|-------|
| 400 | Base64 inválido o paquete malformado / tamaño > 418 B |
| 401 | Firma inválida |
| 404 | `sender_id` no registrado |
| 422 | `timestamp` fuera de ventana |
| 429 | Límite de tasa por `egress_id` o `sender_id` |

## 5. API de buzón

Un nodo con internet consulta lo pendiente para los incidentes que ve en el mesh y lo inyecta.

`POST /v1/mailbox/poll`

```json
{
  "queries": [ { "sender_id": "930bda7e20b63bb9", "incident_ids": ["0a68279fb49bde12"] } ],
  "cursor": null,
  "limit": 50
}
```

Respuesta `200`:

```json
{
  "messages": [
    { "id": "m_0001", "msg_type": 3, "incident_id": "0a68279fb49bde12", "created_at": 1798200041,
      "packet_b64": "<ACK firmado>" },
    { "id": "m_0002", "msg_type": 5, "incident_id": "0a68279fb49bde12", "created_at": 1798200150,
      "packet_b64": "<MSG_IN firmado, sellado al usuario>" }
  ],
  "next_cursor": "c_0003"
}
```

- Solo se devuelven tipos 3, 5 y 7. Retención: 24 h. Re-inyectar es seguro por la clave de idempotencia.
- El buzón no revela contenido: MSG_IN y CMD_RESULT van sellados al usuario.

### 5.1 Entrega y reintentos (camino de regreso)

El mesh de bitchat reenvía por inundación con TTL: no hay rutas, ni camino inverso, ni
confirmación de entrega por salto. Su caché de reintentos (`StoreForwardManager`) y su sincronización
por gossip no cubren el tipo `EMERGENCY`. La entrega se garantiza con las reglas de abajo, no con el mesh.
Los nodos intermedios (B) no guardan paquetes de otros; esa "custodia" queda fuera del alcance del demo.

**R1. El origen reintenta hasta recibir ACK.**
- El teléfono que emite un SOS, UPDATE, MSG_OUT o CMD lo reenvía hasta recibir el ACK
  correspondiente a su `seq`.
- Intervalo: cada 15 s durante los primeros 2 min; después cada 60 s. Tope: 30 min sin ACK, y
  vuelve a empezar al detectar un vecino nuevo.
- El paquete interno se reenvía **idéntico** (mismo `seq`, misma firma). El sobre de bitchat sí debe
  ser nuevo en cada intento. Verificado: el ID de duplicado es `SHA-256(tipo | sender | timestamp en ms
  del sobre | payload)` (`PacketIdUtil`), así que basta con un `timestamp` distinto; dos envíos en el
  mismo milisegundo colisionarían.
- El backend responde `duplicate` con el mismo ACK (§4). Cada reenvío que alcance a un egress
  reabre el camino de regreso, aunque el egress anterior ya no esté.
- Si el ACK confirma un `seq` menor al último enviado, se siguen reenviando los pendientes.
- Tras el ACK el origen deja de reintentar y pasa a emitir la baliza de R6.

**R2. El buzón no depende de un egress concreto.**
- Un egress consulta `POST /v1/mailbox/poll` con los pares `(sender_id, incident_id)` de **cualquier
  paquete de usuario que haya oído**, no solo de los que él subió.
- Consulta al subir un paquete nuevo y luego cada 20 s mientras siga oyendo ese `incident_id`.
- Los mensajes pendientes (tipos 3, 5, 7) se inyectan al mesh con TTL 7.
- Si el egress que subió el SOS se fue, cualquier otro que oiga el reintento recoge lo pendiente.

**R3. Bandeja de salida en el egress.**
- Un egress que recibe un paquete sin tener internet lo guarda y lo sube cuando vuelva la conexión.
  El backend lo acepta igual: la ventana de `timestamp` es de 7 días (§3.5) y la idempotencia
  evita duplicados.
- Guarda como máximo 200 paquetes o 24 h, lo que ocurra primero (los más viejos salen primero).
- Reintenta cada 30 s con espera creciente hasta 5 min. Un `4xx` descarta el paquete; un `5xx` o la
  falta de red lo conservan.
- La bandeja no lleva datos personales aparte de lo que ya viaja en el paquete (sellado).

**R4. Estados honestos en la UI del origen.**

| Estado | Condición |
|--------|-----------|
| `enviado` | El paquete salió al mesh (≥ 1 vecino aceptó la escritura). |
| `sin_confirmar` | Pasaron 30 s sin ACK; se sigue reintentando (R1). |
| `recibido` | Llegó un ACK firmado por el servidor con `seq` ≥ el enviado. |
| `en_gestion` | ACK con código 2: el agente ya trabaja el caso. |
| `contactos_avisados` | ACK con código 1. |
| `rechazado` | ACK con código 3. |
| `detenido` | Se agotó el tope de reintentos sin ACK; reintenta si aparece un vecino. |

La UI **nunca** muestra "entregado" ni "avisados" sin ACK. Las respuestas MSG_IN y CMD_RESULT llegan
por el mismo mecanismo (R2) y el teléfono no confirma su recepción: el buzón las conserva 24 h.

**R5. Envío por radio (respuestas tardías).**

Los mensajes del servidor para un incidente (tipos 3, 5 y 7) no solo esperan en el buzón: el
servidor los **empuja** a los egress cercanos a donde puede estar el origen.

- **Presencia.** Un egress con internet que acepte colaborar envía `POST /v1/egress/presence` con
  `{"egress_id": "<aleatorio, rota por sesión>", "cell": "<geohash de 6 caracteres>", "valid_s": 90}`
  cada 60 s. Se usa una celda gruesa (~1,2 km × 0,6 km), nunca coordenadas exactas. Respuesta `204`.
  Es voluntario y se desactiva en ajustes.
- **Dónde buscar.** El servidor toma el último paquete del origen con ubicación:
  `centro = (lat, lon)`, `t_fix = timestamp − location_age`.
  `radio = clamp(accuracy_m + 2 m/s × (ahora − t_fix), 300 m, 5 km)`.
  El radio crece solo con el tiempo transcurrido; una baliza nueva lo reinicia.
- **A quién.** Al egress que subió el paquete original (si sigue conectado) y a los **5 egress con
  presencia más cercanos** cuyas celdas intersecten el círculo.
- **Cómo lo reciben.** `GET /v1/egress/inbox?egress_id=…&wait=25` (long-poll de 25 s) devuelve
  `{"messages":[{"id","msg_type","incident_id","packet_b64"}]}`. El egress inyecta cada paquete al
  mesh con TTL 7. La entrega es al menos una vez; la idempotencia absorbe repeticiones.
- **Hasta cuándo.** El servidor repite el envío cada 60 s con el radio actualizado, y lo detiene
  cuando recibe un `rx_cursor` ≥ `seq` del mensaje (recibo del origen, vía R6), o a las 24 h
  (retención del buzón, §5).
- **Privacidad y abuso.** Los egress solo ven paquetes sellados al usuario y el `incident_id`: saben
  que hay un mensaje para ese incidente y nada más. Un egress puede mentir sobre su celda o no
  inyectar; por eso se envía a varios. Límite de tasa por `egress_id` (§4, `429`).

**R6. Baliza del origen.**
- Mientras el incidente esté abierto y ya haya recibido el primer ACK, el origen emite un `UPDATE`
  cada 3 min (cada 10 min con batería < 20 %), con su ubicación actual y su `rx_cursor`.
- La baliza no se reintenta: la siguiente ocupa su lugar. No necesita ACK.
- Sirve para tres cosas: el servidor sabe dónde buscar al origen (R5), los egress que lo oyen
  consultan el buzón (R2) y el `rx_cursor` confirma qué mensajes ya llegaron.
- Termina cuando el usuario cierra el incidente (`UPDATE` con `severity = 0`), a las 6 h, o si no
  hay nada que reportar y el usuario lo desactiva. Cada baliza consume `seq` (uint16, sobra).

**Casos que cubre este diseño**

| Caso | Qué ocurre |
|------|-----------|
| B sale de rango en el regreso | El ACK queda en el buzón. El origen reintenta (R1) y, al alcanzar cualquier egress, lo recibe (R2). |
| El egress recibe y sale de rango | Si ya subió, el backend lo tiene. Si no tenía internet, lo sube después (R3). |
| El origen se mueve | Sus reintentos desde la posición nueva encuentran otro camino o egress. |
| Respuesta tardía con el origen en silencio (ya recibió el ACK) | R6 mantiene al servidor informado de su posición y R5 empuja el mensaje a los egress cercanos. |
| El egress Z se movió | El servidor no depende de Z: empuja a otros egress dentro del radio (R5). |
| Ningún egress oye al origen | El origen muestra `sin_confirmar`/`detenido`; no se afirma entrega. |

**Alcance real del mesh:** cada salto BLE cubre decenas de metros y con TTL 7 el tramo local ronda
unos pocos cientos de metros. Las distancias largas dependen de que las personas se muevan (R3) y
de que el servidor empuje a egress cercanos (R5); no de más saltos.

**Costo y límite conocido:** los reintentos y las balizas usan batería y radio. Con muchos usuarios la
inundación se satura; el límite de tasa por `sender_id` (§4, `429`) y el tope de 30 min lo acotan.

## 6. Registro previo (online)

`POST /v1/users` — cabeceras `X-Baliza-Pubkey` (Ed25519, base64) y `X-Baliza-Signature`
(`Ed25519(sk, SHA-256(cuerpo))`, base64) como prueba de posesión.

```json
{
  "display_name": "Usuario Demo",
  "sign_pk_b64": "NeVs3BgejqY9Ei5HWwHnNRobVxvLDqapvV+X5sTtLOU=",
  "seal_pk_b64": "<X25519 pk del usuario>",
  "contacts": [
    { "index": 0, "name": "Contacto Demo Uno", "relation": "familiar", "lang": "es",
      "channels": { "sms": "+58 000-0000001", "email": "contacto1@example.com",
                    "voice": "+58 000-0000001" } },
    { "index": 1, "name": "Contacto Demo Dos", "relation": "amigo", "lang": "es",
      "channels": { "sms": "+58 000-0000002", "voice": "+58 000-0000002" } }
  ]
}
```

Respuesta `201`:

```json
{
  "sender_id": "930bda7e20b63bb9",
  "server": { "key_id": "k1", "sign_pk_b64": "dKjbngLxs1KmFpRnihB6JlcLSE3RR9Qow05dCLr5DRY=",
              "seal_pk_b64": "<X25519 pk del servidor>" },
  "contacts": [ { "index": 0, "status": "pending_verification" },
                { "index": 1, "status": "pending_verification" } ]
}
```

- `index` es el número corto 0..31 que el mesh usa para referirse a un contacto.
- `PUT /v1/users/{sender_id}/contacts` actualiza contactos con las mismas cabeceras de firma.
- Estados de contacto: `pending_verification`, `verified`. Solo contactos del equipo en el demo.
- Telegram queda descartado como canal.

## 7. Herramientas del agente IA

El agente recibe el incidente y llama a estas herramientas. Los argumentos se validan en el
servidor contra el esquema; **el texto de usuarios y contactos es dato no confiable**.

| Herramienta | Argumentos | Resultado |
|-------------|-----------|-----------|
| `registrar_incidente` | `sender_id`, `incident_id`, `category`, `severity`, `lat`, `lon`, `accuracy_m`, `location_age_s`, `public_text`, `nota?` | `{incidente_ref, creado: bool}` |
| `avisar_contactos` | `incident_id`, `canal: "sms"\|"email"\|"llamada_voz"`, `contactos: [índice]\|"todos"`, `mensaje` | `{enviados: [{indice, canal, estado}]}` |
| `consultar_alertas` | `lat`, `lon`, `radio_m`, `desde?` | `{alertas: [{id, tipo, texto, distancia_m}]}` |
| `recargar_saldo` (mock) | `sender_id`, `operador`, `monto`, `moneda` | `{estado, referencia_mock}` |
| `pagar` (mock) | `sender_id`, `beneficiario`, `monto`, `moneda`, `concepto` | `{estado, referencia_mock}` |
| `pedir_ride` (mock) | `sender_id`, `destino`, `modo` | `{estado, eta_min, referencia_mock}` |
| `pedir_delivery` (mock) | `sender_id`, `comercio`, `articulos[]`, `direccion` | `{estado, eta_min, referencia_mock}` |

Reglas:
- `recargar_saldo` y `pagar` solo existen con `FEATURE_PAYMENTS=true`; `pedir_ride` y
  `pedir_delivery` con `FEATURE_RIDES=true`. Desactivadas devuelven `status=3` en CMD_RESULT.
  (Las variables van en `.env`; ver nota en `CLAUDE.md`.)
- Todo lo monetario o de movilidad es **simulado**. Sin llamadas a bancos ni a plataformas reales.
- Solo un `CMD` firmado por el usuario puede disparar esas herramientas. El texto de `MSG_IN`,
  de la nota del SOS o de un contacto **nunca** invoca herramientas (defensa contra inyección).
- Idempotencia por `(sender_id, ref)` y tope por usuario y por día.
- La llamada con voz IA (`llamada_voz`) la hace el backend con el proveedor de voz elegido.

## 8. Ejemplos (datos sintéticos)

Usuario `sender_id=930bda7e20b63bb9`, servidor `sender_id=7e3dd44f0a98b666`,
`incident_id=0a68279fb49bde12`. Ubicación sintética `lat=1049700`, `lon=-6685300`
(10.49700, −66.85300). Referencia temporal `T0 = 1798200000` (2026-12-25T12:00:00Z).

### SOS (1) — teléfono → backend

Campos:

```json
{
  "msg_type": 1,
  "ttl": 7,
  "incident_id": "0a68279fb49bde12",
  "seq": 1,
  "category": 1,
  "severity": 3,
  "lat": 1049700,
  "lon": -6685300,
  "accuracy_m": 12,
  "location_age": 4,
  "timestamp": 1798200000,
  "sender_id": "930bda7e20b63bb9",
  "public_text": "SOS medico, necesito ayuda"
}
```

Plaintext sellado: contact_mask=0b11 (contactos 0 y 1), channels=sms+email, rx_cursor=0, nota "Persona inconsciente en la plaza. Tel de prueba +58 000-0000000".

Tamaño: **250 B** (sobre estimado 336 B).

Hex:

```
0101070a68279fb49bde120001010300100464ff99fd8c000c00046b2e5ac0930bda7e20b63bb91a534f53206d656469636f2c206e6563657369746f2061797564610076227eb6241ad0cf982cd9407f52b57f2350b3eefd7f86d8f16ce3931c5b0999f592bfad0f1dfbe1df9f16d67d2fe348a6beeeee05b1bde7718378ecdc918f8c2ce8e2acb29cc70734dfe95b1cdcc725156b5e18bbea9b130b41720306facf44580477907890eccf55a9ebcaf0a017093551a474e51b315c50c2b0905cdc20385347ba25378fa56b69948ec6b39708b219a0e4073bfc251524afd49489ad0d33b2ac9227f9d88302333a842ef33e2e9ca4197fcfd97b03
```

Base64 (lo que va en `packet_b64`):

```
AQEHCmgnn7Sb3hIAAQEDABAEZP+Z/YwADAAEay5awJML2n4gtju5GlNPUyBtZWRpY28sIG5lY2VzaXRvIGF5dWRhAHYifrYkGtDPmCzZQH9StX8jULPu/X+G2PFs45McWwmZ9ZK/rQ8d++HfnxbWfS/jSKa+7u4Fsb3ncYN47NyRj4ws6OKsspzHBzTf6Vsc3MclFWteGLvqmxMLQXIDBvrPRFgEd5B4kOzPVanryvCgFwk1UaR05RsxXFDCsJBc3CA4U0e6JTePpWtplI7Gs5cIshmg5Ac7/CUVJK/UlImtDTOyrJIn+diDAjM6hC7zPi6cpBl/z9l7Aw==
```

### UPDATE (2) — teléfono → backend

Campos:

```json
{
  "msg_type": 2,
  "ttl": 7,
  "incident_id": "0a68279fb49bde12",
  "seq": 2,
  "category": 1,
  "severity": 3,
  "lat": 1049720,
  "lon": -6685315,
  "accuracy_m": 8,
  "location_age": 1,
  "timestamp": 1798200090,
  "sender_id": "930bda7e20b63bb9",
  "public_text": "Sigo aqui, ya respira"
}
```

Plaintext sellado: mismo formato que SOS, rx_cursor=0; nota "Respira pero sigue sin hablar".

Tamaño: **211 B** (sobre estimado 297 B).

Hex:

```
0102070a68279fb49bde120002010300100478ff99fd7d000800016b2e5b1a930bda7e20b63bb9155369676f20617175692c20796120726573706972610054f86360dbda09b7267bd0a086c8d5a488a7a63727a4f0662004992b2f69614fd0203e7930cddd352d915f75e2978b7aacc60c78616ff1acc44557b66e284038f1a9ab96adbbc51e2b050f24f873618cc666bb6d83a63a52fa7cdbd4f70c0760affd6ae57cc7042cb1f3c58f120e3cb69edd1acadac68fdd5f1f5f25e67248537a1970819b0909c0d69c85b85ac58ca98783e8290a
```

Base64 (lo que va en `packet_b64`):

```
AQIHCmgnn7Sb3hIAAgEDABAEeP+Z/X0ACAABay5bGpML2n4gtju5FVNpZ28gYXF1aSwgeWEgcmVzcGlyYQBU+GNg29oJtyZ70KCGyNWkiKemNyek8GYgBJkrL2lhT9AgPnkwzd01LZFfdeKXi3qsxgx4YW/xrMRFV7ZuKEA48amrlq27xR4rBQ8k+HNhjMZmu22DpjpS+nzb1PcMB2Cv/WrlfMcELLHzxY8SDjy2nt0aytrGj91fH18l5nJIU3oZcIGbCQnA1pyFuFrFjKmHg+gpCg==
```

### ACK (3) — backend → teléfono

Campos:

```json
{
  "msg_type": 3,
  "ttl": 7,
  "incident_id": "0a68279fb49bde12",
  "seq": 1,
  "category": 1,
  "severity": 0,
  "lat": "sin ubicación",
  "lon": "sin ubicación",
  "timestamp": 1798200040,
  "sender_id": "7e3dd44f0a98b666",
  "public_text": "Recibido. 2 contactos avisados"
}
```

Plaintext sellado: sin blob; `category=1` = contactos avisados; `seq=1` confirma el SOS.

Tamaño: **136 B** (sobre estimado 222 B).

Hex:

```
0103070a68279fb49bde12000101008000000080000000000000006b2e5ae87e3dd44f0a98b6661e526563696269646f2e203220636f6e746163746f73206176697361646f7300000d6599d5819238e952aebcdb4c7dcbfa55985ca1347477ae080968ab2d9bf237c9c439c38369eff24a4bc7549d64c635f6c73ef4a81df2764b6f7dfb1f3c4c0e
```

Base64 (lo que va en `packet_b64`):

```
AQMHCmgnn7Sb3hIAAQEAgAAAAIAAAAAAAAAAay5a6H491E8KmLZmHlJlY2liaWRvLiAyIGNvbnRhY3RvcyBhdmlzYWRvcwAADWWZ1YGSOOlSrrzbTH3L+lWYXKE0dHeuCAloqy2b8jfJxDnDg2nv8kpLx1SdZMY19sc+9Kgd8nZLb337HzxMDg==
```

### MSG_OUT (4) — teléfono → contactos

Campos:

```json
{
  "msg_type": 4,
  "ttl": 7,
  "incident_id": "0a68279fb49bde12",
  "seq": 3,
  "timestamp": 1798200120,
  "sender_id": "930bda7e20b63bb9",
  "public_text": ""
}
```

Plaintext sellado: contact_idx=0, channels=sms+email, texto "Estoy bien, la ambulancia ya llego".

Tamaño: **190 B** (sobre estimado 276 B).

Hex:

```
0104070a68279fb49bde12000300008000000080000000000000006b2e5b38930bda7e20b63bb900005464208680b01ef18689f3e0f6c55a130f0f3acc36f6d17c875a8fe48d330cb92756bc8bfb1fdd3deddc373d90b9ec3929822f61b58c1cc5a2b0b1f549669691e75c830741958e276ef29fca7fd18bbb339ec6320bf4325f180c7c2de0412c3a16c588a25fab4481ad8da079e8d86777ac5ed9025d6ced412004e9b9c91a56ec3582c22019261c65aaf9d86a50a4b07010108b420d
```

Base64 (lo que va en `packet_b64`):

```
AQQHCmgnn7Sb3hIAAwAAgAAAAIAAAAAAAAAAay5bOJML2n4gtju5AABUZCCGgLAe8YaJ8+D2xVoTDw86zDb20XyHWo/kjTMMuSdWvIv7H9097dw3PZC57Dkpgi9htYwcxaKwsfVJZpaR51yDB0GVjidu8p/Kf9GLuzOexjIL9DJfGAx8LeBBLDoWxYiiX6tEga2NoHno2Gd3rF7ZAl1s7UEgBOm5yRpW7DWCwiAZJhxlqvnYalCksHAQEItCDQ==
```

### MSG_IN (5) — contacto → teléfono

Campos:

```json
{
  "msg_type": 5,
  "ttl": 7,
  "incident_id": "0a68279fb49bde12",
  "seq": 1,
  "timestamp": 1798200150,
  "sender_id": "7e3dd44f0a98b666",
  "public_text": ""
}
```

Plaintext sellado: contact_idx=0, channel=sms, texto "Voy para alla, aguanta".

Tamaño: **178 B** (sobre estimado 264 B).

Hex:

```
0105070a68279fb49bde12000100008000000080000000000000006b2e5b567e3dd44f0a98b6660000481ed6ad197e125fa0711e0b20af2b0b1c55f763baef6476fae73e1f9fd085c39f40a94cbf9c44ae5efa9a0ddc14abe0cc07e19c7f70341f7096b4178bc7da04a51362c865f60719e36473de785c3963d56f574b332c4fc3096bd44c070fc34e5064969c5f3d8666dcb93b47cfb0ba0d5ceff9401d59c88cc1e213c34d39d87fb00ce1fc020b05eb03
```

Base64 (lo que va en `packet_b64`):

```
AQUHCmgnn7Sb3hIAAQAAgAAAAIAAAAAAAAAAay5bVn491E8KmLZmAABIHtatGX4SX6BxHgsgrysLHFX3Y7rvZHb65z4fn9CFw59AqUy/nESuXvqaDdwUq+DMB+Gcf3A0H3CWtBeLx9oEpRNiyGX2BxnjZHPeeFw5Y9VvV0szLE/DCWvUTAcPw05QZJacXz2GZty5O0fPsLoNXO/5QB1ZyIzB4hPDTTnYf7AM4fwCCwXrAw==
```

### CMD (6) — teléfono → agente

Campos:

```json
{
  "msg_type": 6,
  "ttl": 7,
  "incident_id": "0a68279fb49bde12",
  "seq": 4,
  "timestamp": 1798200200,
  "sender_id": "930bda7e20b63bb9",
  "public_text": ""
}
```

Plaintext sellado: JSON `{"cmd":"pedir_ride","ref":7,"args":{"destino":"Clinica Demo","modo":"urgente"}}`.

Tamaño: **233 B** (sobre estimado 319 B).

Hex:

```
0106070a68279fb49bde12000400008000000080000000000000006b2e5b88930bda7e20b63bb900007f1f5b814b7ffaa8d675652c493ffd97a4ff3dd312fe76ed2c91659c85b6f553dd485783e5ef13069353de9bc7349da014b7b828841078b6baea089b4c52c5640e5d3f037f188ca286dd35e2763ebcf186e98c706b305c1bbdd6275805929dcf9c8848701745f5b658e28cd39a5c78677cd9349d822ec8d09c7ff7ece5359847e92de70425d6b6054f21bb9f40b28a1be285b137a7fb5f2d1016de52d52490bf54ec8b1c7822d53424f02dc5ca96179b02f5b713c62aaec385947745121c510f
```

Base64 (lo que va en `packet_b64`):

```
AQYHCmgnn7Sb3hIABAAAgAAAAIAAAAAAAAAAay5biJML2n4gtju5AAB/H1uBS3/6qNZ1ZSxJP/2XpP890xL+du0skWWchbb1U91IV4Pl7xMGk1Pem8c0naAUt7gohBB4trrqCJtMUsVkDl0/A38YjKKG3TXidj688YbpjHBrMFwbvdYnWAWSnc+ciEhwF0X1tljijNOaXHhnfNk0nYIuyNCcf/fs5TWYR+kt5wQl1rYFTyG7n0CyihvihbE3p/tfLRAW3lLVJJC/VOyLHHgi1TQk8C3FypYXmwL1txPGKq7DhZR3RRIcUQ8=
```

### CMD_RESULT (7) — agente → teléfono

Campos:

```json
{
  "msg_type": 7,
  "ttl": 7,
  "incident_id": "0a68279fb49bde12",
  "seq": 2,
  "timestamp": 1798200215,
  "sender_id": "7e3dd44f0a98b666",
  "public_text": ""
}
```

Plaintext sellado: ref=7, status=0 (ok), texto "[MOCK] Ride simulado, llega en 6 min".

Tamaño: **193 B** (sobre estimado 279 B).

Hex:

```
0107070a68279fb49bde12000200008000000080000000000000006b2e5b977e3dd44f0a98b6660000578a9b177f0af9d8d05dd8ec3675a16a990ef6b7a438ea3e2c6674405f728c0c4cdf6f1c51c8dc8a1d36a0142fcfc75343f82f3837b93a32128ad6d1ea1b3e232639c1e3e39aae4fc81efa58270263a9cfd7c7702efb6c1bd4fc348aff822c2b7ae56bcf20555dad4d68b0fc4f57e904d32c9d1bbea459b2c984159be5860799664e571e885899d048b2c2b84d1f8b025b5cbaabd7865f0f
```

Base64 (lo que va en `packet_b64`):

```
AQcHCmgnn7Sb3hIAAgAAgAAAAIAAAAAAAAAAay5bl3491E8KmLZmAABXipsXfwr52NBd2Ow2daFqmQ72t6Q46j4sZnRAX3KMDEzfbxxRyNyKHTagFC/Px1ND+C84N7k6MhKK1tHqGz4jJjnB4+Oark/IHvpYJwJjqc/Xx3Au+2wb1Pw0iv+CLCt65WvPIFVdrU1osPxPV+kE0yydG76kWbLJhBWb5YYHmWZOVx6IWJnQSLLCuE0fiwJbXLqr14ZfDw==
```

## 9. Pendiente de este contrato

- Confirmar en dispositivos que un `EMERGENCY` cruza un salto BLE real (D-1): prueba A–B–C con B en medio.
- Limitar el reenvío de `EMERGENCY` no autenticado por el sobre (tasa por emisor) si se observa abuso.
- Fuera del alcance del demo: custodia de paquetes ajenos en nodos intermedios.
- Implementar `docs/examples/examples.json` como prueba de conformidad en Kotlin y en el backend.
- Medir en dispositivos: pérdida de paquetes, latencia por salto y comportamiento del relevo con TTL 3.
