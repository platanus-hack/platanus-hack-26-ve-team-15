# 09a · Paquete binario: cabecera fija (39 B)

Los primeros 39 bytes del paquete interno de Baliza (`contrato.md` §3.1), campo por campo, con
offset y tamaño. Todo va en claro y todo va firmado **excepto `ttl`**, que queda fuera de la firma
para poder reescribirlo. Big-endian.
El cuerpo, la firma y el sellado están en [09b](09b-paquete-cuerpo-firma.md); el sobre de bitchat
que lo transporta, en [09c](09c-paquete-sobre-bitchat.md).

Estado: **propuesto (calcado del código)**, revisado contra `6f254e6`. Coincide con
`EmergencyCodec.encodeUnsigned` (Android) y `backend/src/codec.js`: 39 B de cabecera, `TTL_OFFSET = 2`,
`NO_LOCATION = Int.MIN_VALUE`. Fuente: `contrato.md` §3.1–§3.4 y los vectores de
`docs/examples/examples.json`.

```mermaid
flowchart TB
  classDef signed fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
  classDef unsigned fill:#fff3e0,stroke:#e65100,color:#bf360c,stroke-width:2px

  subgraph r1["Bytes 0 – 14 · identidad del mensaje"]
    direction LR
    v["version<br/>@0 · 1 B<br/>= 1"]:::signed
    mt["msg_type<br/>@1 · 1 B<br/>1..7"]:::signed
    ttl["ttl<br/>@2 · 1 B<br/>FUERA DE FIRMA"]:::unsigned
    iid["incident_id<br/>@3 · 8 B<br/>aleatorio"]:::signed
    seq["seq<br/>@11 · 2 B<br/>uint16"]:::signed
    cat["category<br/>@13 · 1 B<br/>ACK: código"]:::signed
    sev["severity<br/>@14 · 1 B<br/>0..3"]:::signed
    v ~~~ mt ~~~ ttl ~~~ iid ~~~ seq ~~~ cat ~~~ sev
  end

  subgraph r2["Bytes 15 – 38 · ubicación, tiempo y emisor"]
    direction LR
    lat["lat<br/>@15 · 4 B<br/>int32 × 1e5"]:::signed
    lon["lon<br/>@19 · 4 B<br/>int32 × 1e5"]:::signed
    acc["accuracy_m<br/>@23 · 2 B<br/>uint16"]:::signed
    age["location_age<br/>@25 · 2 B<br/>s, satura 65535"]:::signed
    ts["timestamp<br/>@27 · 4 B<br/>Unix s"]:::signed
    sid["sender_id<br/>@31 · 8 B<br/>SHA-256(pk)[0..8]"]:::signed
    lat ~~~ lon ~~~ acc ~~~ age ~~~ ts ~~~ sid
  end

  r1 ~~~ r2
```

Leyenda: verde = firmado y en claro; naranja = en claro y **sin** firma.

## Ejemplo: SOS de los vectores (§8)

```
01 01 07 0a68279fb49bde12 0001 01 03 00100464 ff99fd8c 000c 0004 6b2e5ac0 930bda7e20b63bb9
v  mt ttl incident_id     seq  ca sv lat      lon      acc  age  timestamp sender_id
```

`lat = 0x00100464 = 1049700` (10.49700°), `lon = 0xff99fd8c = −6685300` (−66.85300°).

## Supuestos / decisiones abiertas

- **Sin ubicación:** `lat = lon = −2147483648` (`0x80000000`), como en los ACK de ejemplo.
- **`category` cambia de sentido según el tipo:** en el ACK es el código (0 recibido, 1 contactos
  avisados, 2 en gestión, 3 rechazado). El teléfono los ordena por rango, no por valor
  (`SosSender`: recibido < en gestión < contactos avisados; rechazado es final). Ver diagrama 8b.
- **`timestamp` en segundos (uint32)** alcanza hasta 2106. El sobre de bitchat usa milisegundos; son
  relojes distintos.
- **`ttl` interno:** copia el valor inicial y sirve para contar saltos (`saltos = ttl − envelopeTtl`).
  No se usa para decisiones de seguridad.
