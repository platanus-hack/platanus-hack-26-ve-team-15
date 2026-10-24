# Diagramas de Baliza Vital

Diagramas del sistema en Mermaid. GitHub los renderiza directo. Cada archivo trae su propósito, el
diagrama y una sección "Supuestos / decisiones abiertas". Los PNG para las láminas están en
[`img/`](img/).

Estados: **propuesto** (diseño sin validar o sin código todavía), **propuesto (calcado del código)**
(dibujado sobre el código, falta tu revisión), **validado** (coincide con el código y el contrato
vigentes y fue revisado), **desactualizado** (hubo cambios desde la última sincronización).

Los diagramas que pasaban de ~15 elementos se dividieron en partes (a, b, c).

| # | Diagrama | Estado | PNG |
|---|----------|--------|-----|
| 1 | [C4 nivel 1: contexto](01-c4-contexto.md) | propuesto | [01](img/01-c4-contexto.png) |
| 2 | [C4 nivel 2: contenedores](02-c4-contenedores.md) | propuesto | [02](img/02-c4-contenedores.png) |
| 3 | [Secuencia: SOS A → B → C → backend → ACK](03-secuencia-sos.md) | propuesto | [03](img/03-secuencia-sos.png) |
| 4 | [Secuencia: aviso a contactos, voz IA y respuesta por buzón](04-secuencia-blast-respuesta.md) | propuesto | [04](img/04-secuencia-blast-respuesta.png) |
| 5 | [Secuencia: comando al agente con mocks y CMD_RESULT](05-secuencia-comando.md) | propuesto | [05](img/05-secuencia-comando.png) |
| 6a | [ER: identidad, incidentes y avisos](06a-er-identidad-incidentes.md) | propuesto (calcado del código) | [06a](img/06a-er-identidad-incidentes.png) |
| 6b | [ER: buzón, radio y comandos](06b-er-entrega-agente.md) | propuesto (calcado del código) | [06b](img/06b-er-entrega-agente.png) |
| 7a | [Flujo de un nodo: capa bitchat](07a-flujo-nodo-bitchat.md) | propuesto (calcado del código) | [07a](img/07a-flujo-nodo-bitchat.png) |
| 7b | [Flujo de un nodo: capa Baliza](07b-flujo-nodo-baliza.md) | propuesto | [07b](img/07b-flujo-nodo-baliza.png) |
| 8a | [Estados del incidente en el backend](08a-estados-incidente-backend.md) | propuesto (calcado del código) | [08a](img/08a-estados-incidente-backend.png) |
| 8b | [Estados del SOS en el teléfono (R4)](08b-estados-sos-telefono.md) | propuesto (calcado del código) | [08b](img/08b-estados-sos-telefono.png) |
| 9a | [Paquete: cabecera fija](09a-paquete-cabecera.md) | propuesto (calcado del código) | [09a](img/09a-paquete-cabecera.png) |
| 9b | [Paquete: cuerpo, firma y sellado](09b-paquete-cuerpo-firma.md) | propuesto (calcado del código) | [09b](img/09b-paquete-cuerpo-firma.png) |
| 9c | [Paquete: sobre de bitchat](09c-paquete-sobre-bitchat.md) | propuesto (calcado del código) | [09c](img/09c-paquete-sobre-bitchat.png) |
| 10 | [Despliegue del demo](10-despliegue-demo.md) | propuesto | [10](img/10-despliegue-demo.png) |

Los "propuesto" a secas mezclan código real (backend, `SosSender`) con piezas que no existen todavía
(cliente egress, UI, UPDATE, MSG_OUT, CMD en el teléfono). Cada diagrama marca cuál es cuál.

Última sincronización: `431db2d` (`main`, 2026-10-24). La anterior fue `8e2b1e1`.

## Decisiones

1. **ACK de avance: el código la reemplaza; falta tu confirmación.** Se había aprobado: ACK síncrono con
   código 0, el avance (2 y 1) por el buzón, y el teléfono deduplicando por `(incident_id, seq,
   category)`. El código implementó otra cosa (backend: `egress.js`, `agent.js`; teléfono: `SosSender.kt`):
   - el ACK síncrono de SOS y UPDATE lleva **código 2**; el de MSG_OUT y CMD, código 0;
   - el código 1 llega después por el buzón, como otra fila del mismo `seq`;
   - `duplicate` devuelve los **bytes del primer ACK**;
   - el teléfono no deduplica: ordena por rango y nunca retrocede (ya está en `contrato.md` §5.1, R4).
   
   Propuesta: adoptar el código y dar de baja la decisión 1. La pregunta "más reciente o código más alto"
   ya no aplica. **Sigue abierto:** el ejemplo de §8 trae código 1 en el ACK síncrono y el código manda
   2; hay que corregir el ejemplo y regenerar los vectores.
2. **Sin lista blanca del modo demo.** Se respeta D-2; el diagrama 7 no tiene ese paso. Sin cambios.

## Contradicciones y decisiones abiertas

| # | Tema | Dónde | Estado | Propuesta o resolución |
|---|------|-------|--------|------------------------|
| 3 | Clave de deduplicación: el encargo decía `incident_id + seq`; el contrato, `(sender_id, incident_id, seq, msg_type)` | 6a | Resuelto en código | `packets` usa la del contrato |
| 4 | Telegram: el encargo lo menciona y §6 lo descarta | 1 | Resuelto | Fuera |
| 5 | `EmergencyMeshTransport` en `fases.md` (`peers`, `hops`, `send(packet)`) no coincide con el código, que ahora además tiene `newNeighbors` | 2 | **Abierto** | Actualizar `fases.md` al código |
| 6 | ¿Quién crea el incidente? | 3 | Resuelto en código | `/v1/egress` llama a `registrarIncidente` en la misma transacción |
| 7 | ¿Quién pasa a `ayuda_en_camino`? No hay estado, ni ruta, ni código de ACK | 8a | **Abierto** | Ruta de admin en el panel y ACK código 4 "ayuda en camino" en el contrato |
| 8 | `severity = 0` del usuario: ¿`resuelto` o `falso`? | 8a | Resuelto en código | `closed`; no existe `falso` |
| 9 | API del dashboard fuera del contrato | 2 | Resuelto en código | `GET /v1/incidents`, `/v1/incidents/{sender}/{incident}`, `/v1/events`, SSE `/v1/stream`; solo lectura, sin `PATCH`. Falta pasarla al contrato |
| 10 | Por dónde responde el contacto | 4 | Resuelto en código | Webhook de Kapso, `/r/{token}`, `/v1/replies`, webhook SMS de Twilio |
| 11 | ¿El `CMD` pasa por el LLM? | 5 | Resuelto en código | No: despacho en código con esquema estricto; el LLM solo redacta avisos |
| 12 | "Laptop como egress de respaldo": una laptop no corre bitchat | 10 | **Abierto** | La laptop respalda red (hotspot) y backend (copia local con las mismas llaves); un 4.º teléfono si se quiere un egress real |
| 13 | Margen del frame: §2 dice "margen de 6 B" y §2.1 suma 512 exactos. Con compresión, 418 B pueden pasar a 419 B y el sobre a 513 B (se fragmenta) | 9c | **Abierto** | Bajar el límite del paquete interno a 412 B, o aceptar la fragmentación y agregar ese borde a `EmergencyPacketTest` |
| 14 | Base de datos: el encargo pedía Postgres + PostGIS (y `reparto.md` lo proponía); el código usa SQLite (`node:sqlite`) en el disco de Render, sin PostGIS | 2, 6a, 6b, 10 | **Abierto** | SQLite para el demo; Postgres solo si hace falta más de una réplica (`store.js` es el único punto de cambio). Los ER muestran lo real |
| 15 | WhatsApp: el bit «sms» de `channels` sale por WhatsApp (Kapso) si hay credenciales; el contrato (§3.3, §6) solo habla de SMS | 1, 4 | **Abierto** | Documentar en §6 que «sms» significa "mensaje al teléfono del contacto" (WhatsApp o SMS) |

**Observaciones** (no son contradicciones, pero conviene saberlas):
- La ubicación exacta viaja **en claro** en la cabecera y la ve cualquier nodo del mesh (9b).
- Un egress no puede verificar la firma del usuario (no tiene la llave pública) y sube todo lo que
  decodifica; filtra el backend (7b).
- El módulo Baliza de Android **no está conectado a la app**: nadie llama a
  `BleEmergencyMeshTransport.over` ni crea un `SosSender`. Y no hay cliente egress (2).
- La nota del SOS queda **en claro** en la base del backend, sin plazo de retención (6a).
- Con canales reales, solo reciben avisos los contactos `verified` (10).

## Cómo se renderizan los PNG

Se extrae el bloque `mermaid` de cada `.md` y se pasa por `mmdc` a escala 3. Esta es la receta que se
usó: mermaid-cli 11.4.2, que resolvió el núcleo `mermaid` 11.17.2. Chrome necesita `--no-sandbox` en
este Ubuntu. Todo vive fuera del repo:

```bash
W=/tmp/mmdc && mkdir -p $W && (cd $W && npm init -y >/dev/null && npm i @mermaid-js/mermaid-cli@11.4.2)
echo '{"args":["--no-sandbox"]}' > $W/puppeteer.json
for f in docs/diagramas/[0-9]*.md; do
  n=$(basename "$f" .md)
  awk '/^```mermaid/{on=1;next} /^```/{on=0} on' "$f" > "$W/$n.mmd"
  $W/node_modules/.bin/mmdc -p $W/puppeteer.json -i "$W/$n.mmd" -o "docs/diagramas/img/$n.png" -s 3 -b white
done
```

## Cómo se sincroniza

Cuando se pida "sincroniza": `git fetch`, y `git log` y `git diff` desde la última sincronización (arriba)
hasta `main`, sobre:
- Android: `apps/android/.../com/baliza/**`, `PacketProcessor`, `PacketRelayManager`, `SecurityManager`,
  `BluetoothMeshService`, `BinaryProtocol`;
- backend: `backend/src/**` (sobre todo `store.js`, `egress.js`, `agent.js`, `context.js`, `api.js`) y
  `backend/README.md`;
- panel: `dashboard/app.js`;
- despliegue: `render.yaml`;
- documentos: `docs/contrato.md`, `docs/fases.md` y `docs/reparto.md`.

Los diagramas afectados se actualizan o se marcan **desactualizado**, y se mueve la marca de última
sincronización. Qué mirar según el cambio:
- bitchat: 2, 3, 7a y 9c;
- `store.js`: 6a y 6b;
- `egress.js`, `agent.js`, `commands.js`: 3, 4, 5 y 8a;
- `SosSender`: 3, 7b y 8b;
- `render.yaml`: 10.
