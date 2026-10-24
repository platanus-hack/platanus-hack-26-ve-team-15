# Reparto de trabajo (2 días, 2 desarrolladores)

Lee este archivo primero y empieza por la sección **"Primeros 30 minutos"**. El producto, el
protocolo y las APIs ya están definidos: **no los reinventes, impleméntalos**.

## Asignación

| Rol | Persona | Carpeta principal |
|-----|---------|-------------------|
| **Dev A: Android/Mesh** | _______________ | `apps/android/` |
| **Dev B: Backend, Agente y Panel** | _______________ | `backend/`, `dashboard/` |

(Completen los nombres al empezar. Si prefieren intercambiar roles, no cambia nada más.)

## Qué estamos construyendo (30 segundos)

Un teléfono **sin internet** envía un SOS que salta por Bluetooth (mesh de bitchat) hasta un teléfono
**con internet** (egress), que lo sube al backend. Un agente de IA avisa a los contactos y la
confirmación (**ACK**) y las respuestas vuelven por el mesh hasta el teléfono de origen.

Documentos, en este orden:
1. `CLAUDE.md`: resumen del proyecto y reglas. Léelo completo.
2. `docs/contrato.md`: **la fuente de verdad**. Mira sobre todo §2 (transporte), §3 (paquete), §4
   (API egress), §5 y §5.1 (buzón y entrega), §6 (registro) y §7 (herramientas del agente).
3. `docs/fases.md`: qué entregar y cómo se prueba cada fase.
4. `docs/examples/examples.json`: **vectores de prueba** (paquetes reales firmados). Ambos lados
   deben decodificarlos y verificar la firma. Es la forma de saber que están de acuerdo.

## Primeros 30 minutos

```bash
# Repo de la organización (público). Si te dieron acceso al personal, también sirve:
git clone git@github.com:platanus-hack/platanus-hack-26-ve-team-15.git baliza-vital
cd baliza-vital
node docs/examples/generate-examples.mjs | head    # verifica que Node (>= 20) funciona
```

- **Dev A:** compila Android una vez. La primera vez tarda unos 40 min (descarga SDK y dependencias),
  así que **lánzalo ya** y sigue leyendo:
  ```bash
  cd apps/android
  tools/docker-gradle.sh        # con Docker, sin instalar JDK 21 ni SDK
  # o, con JDK 21 y Android SDK 37 locales: ./gradlew :app:assembleDebug testDebugUnitTest
  ```
  Las siguientes corridas son rápidas por la caché. Necesitas al menos 2 teléfonos Android reales
  (3 para la prueba A–B–C).
- **Dev B:** crea el esqueleto en `backend/` (ver "Propuesta de stack") y haz que decodifique los
  vectores de `docs/examples/examples.json`.

## Git: cómo no pisarse

- **Repo de la organización = fuente de verdad.** Haz `git pull` antes de empezar y de subir.
- Cada quien trabaja en su carpeta. Rama por tarea (`git checkout -b android/codec`), merge a `main`
  cuando funcione y los tests pasen. Commits pequeños.
- **Los cambios a `docs/contrato.md` los acuerdan los dos.** Si un detalle del contrato no cuadra,
  avisen en el chat y corrijan el documento y los vectores (`node docs/examples/generate-examples.mjs
  > docs/examples/examples.json`) en el mismo commit.
- El mirror personal (`mvgregoryj/baliza-vital`) lo mantiene Gregory (que empuja a ambos). Quien solo
  empuja a la organización no necesita hacer nada más.
- Sin secretos en el repo: llaves solo en `.env` (hay `.env.example`). Datos **sintéticos** en
  tests y ejemplos. Pagos, recargas y rides son **mocks**.

## Plan de 2 días

Hitos de sincronización (cuando se cumple uno, avísense):

| Hito | Cuándo | Criterio |
|------|--------|----------|
| **H1** | Mitad del día 1 | Android y backend decodifican y verifican los **mismos vectores**. |
| **H2** | Fin del día 1 | Un SOS real llega al backend por un egress y el teléfono recibe un **ACK firmado**. |
| **H3** | Mitad del día 2 | El agente avisa a los contactos (SMS o correo) y una respuesta vuelve al teléfono por el buzón. |
| **H4** | Tarde del día 2 | Mapa en vivo, mocks de Fases 4 y 5 visibles, ensayo del demo. **Congelen cambios 2 h antes de entregar.** |

### Dev A: Android/Mesh

**Día 1**
- [ ] Construir una vez en Docker (arriba) y confirmar que los tests pasan.
- [ ] `MessageType.EMERGENCY = 0x30` y una rama en `PacketProcessor` que entrega el payload a una
      interfaz `EmergencyMeshTransport` (contrato §2, decisión D-1). Cambio **aditivo**: no tocar
      Noise, fragmentación ni identidad. El código nuevo va en el paquete `com.baliza.emergency`.
- [ ] Codec Kotlin del paquete (contrato §3.1) con firma Ed25519 y sellado. Pasar los vectores.
      Ya hay BouncyCastle y Tink en `gradle/libs.versions.toml`. El sellado debe ser compatible con
      `crypto_box_seal` de libsodium (el backend usa libsodium); si implementarlo con BouncyCastle es
      lento, pueden usar `lazysodium-android`. **Decídelo a la primera hora.**
- [ ] Test unitario: un SOS de peor caso (418 B internos) envuelto en un `BitchatPacket` mide ≤ 512 B.
- [ ] Prueba A–B–C con B en medio: confirma que un nodo intermedio **reenvía** un `EMERGENCY`.
      Es lo único del contrato que aún no está comprobado. Si falla, avisa de inmediato.
- [ ] Pantalla de SOS (categoría, severidad, texto, ubicación) y envío al mesh.
- [ ] Egress: si hay internet, `POST /v1/egress` (contrato §4). Para probar sin backend, usa
      `okhttp-mockwebserver` con el ACK de `examples.json`.

**Día 2**
- [ ] Reintentos del origen hasta recibir ACK (R1) y estados honestos en la UI (R4), según §5.1.
- [ ] Reinyectar el ACK y los mensajes del buzón al mesh (consulta `POST /v1/mailbox/poll`, R2).
- [ ] Bandeja de salida del egress cuando no hay internet (R3).
- [ ] Dictado offline y lectura en voz alta (APIs nativas de Android).
- [ ] Pantalla de `CMD` y resultado para las Fases 4 y 5 (simuladas).
- [ ] *Extra, solo si sobra tiempo:* baliza (R6) y presencia/inbox de egress (R5).

### Dev B: Backend, Agente y Panel

**Propuesta de stack** (puedes cambiarla si lo avisas): Node 20+, TypeScript, Express, Postgres
(Supabase o Neon, gratis) y `libsodium-wrappers` para el sellado. Ed25519 ya viene en `node:crypto`
(mira `docs/examples/generate-examples.mjs` para cómo se arma y se firma el paquete).

**Día 1**
- [ ] Esqueleto en `backend/` y despliegue temprano (lo necesitamos para el `deploy-url`).
- [ ] Decodificador y verificador del paquete (contrato §3). Pasar los vectores de `examples.json`.
- [ ] `POST /v1/users` (registro, llaves y contactos con índice corto, contrato §6).
- [ ] `POST /v1/egress`: valida firma, ventana de tiempo y registro; es **idempotente**
      (`duplicate` devuelve el mismo ACK); persiste el incidente y responde con el ACK firmado (§4).
- [ ] Script `backend/scripts/post-vector.mjs` que postea los vectores a tu servidor. Así pruebas sin
      teléfonos y Dev A puede probar contra tu servidor.

**Día 2**
- [ ] Buzón: `POST /v1/mailbox/poll` (tipos 3, 5 y 7, retención 24 h).
- [ ] Agente con las herramientas `registrar_incidente` y `avisar_contactos` (contrato §7). Empieza
      por **SMS y correo**; la llamada con voz de IA es lo último. Los textos de usuarios y contactos
      son datos no confiables: nunca invocan herramientas por sí solos.
- [ ] Respuestas de contactos (`MSG_IN`, sellado al usuario) al buzón.
- [ ] Panel `dashboard/`: lista y mapa en vivo de incidentes.
- [ ] Herramientas simuladas (`recargar_saldo`, `pagar`, `pedir_ride`, `pedir_delivery`) detrás de
      `FEATURE_PAYMENTS` y `FEATURE_RIDES`, respondiendo `CMD_RESULT` (status 3 si están apagadas).
- [ ] *Extra, solo si sobra tiempo:* presencia/inbox y envío por radio (R5).

## Si se acaba el tiempo: orden de recorte

1. **Imprescindible:** H1 y H2 (SOS real → ACK de vuelta), con reintentos y estados honestos.
2. **Muy deseable:** H3 (aviso a contactos y respuesta de vuelta) y el mapa.
3. **Si cabe:** llamada con voz de IA, dictado y lectura, mocks de pagos y rides.
4. **Extra:** R5 y R6. No lo intenten antes de tener H3.

No prometan en el pitch lo que no funcione en dispositivos. Si la prueba A–B–C no pasa, el demo se
puede hacer con un salto menos; el contrato dice qué es lo honesto de afirmar (`docs/contrato.md` §5.1).

## Reglas del proyecto (resumen)

- No modificar Noise/crypto, fragmentación ni identidad de bitchat.
- Lo nuevo de Android va desacoplado de la UI, detrás de `EmergencyMeshTransport`.
- Solo datos sintéticos. Sin llamadas reales a bancos, plataformas de rides ni servicios de emergencia.
- Ningún secreto en el repo.
- En Android, `:app:assembleDebug testDebugUnitTest` debe pasar antes de subir.
- Si algo es ambiguo, **pregúntense antes de asumir**, y anoten la decisión en `docs/contrato.md`.
