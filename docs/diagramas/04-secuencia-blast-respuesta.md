# 04 · Secuencia: aviso a contactos, llamada con voz IA y respuesta por el buzón

Qué pasa después del SOS (diagrama 3): el agente avisa a los contactos por WhatsApp o SMS, correo y
llamada con voz IA. El teléfono recibe el ACK de avance, y la respuesta de un familiar vuelve sellada al
teléfono sin internet a través del buzón y el mesh, donde se lee en voz alta.

Estado: **propuesto**, sincronizado con `6f254e6`. El lado del backend existe (`agent.js`,
`channels.js`, `replies.js`, `radio.js`). En el teléfono faltan el cliente egress (C), la apertura del
MSG_IN, la lectura en voz alta y la baliza UPDATE (R6). Fuentes: `backend/README.md`; `contrato.md`
§3.3, §5, §5.1 (R2, R5, R6), §6 y §7.

```mermaid
sequenceDiagram
  autonumber
  participant A as A · origen<br/>sin internet
  participant C as C · egress<br/>(propuesto)
  participant MB as Backend<br/>buzón + radio.js
  participant AG as Backend<br/>agent.js
  participant LLM as Claude
  participant CH as Kapso / Twilio<br/>Resend / ElevenLabs
  participant K as Contacto 0<br/>(familiar)

  Note over AG: runSosAgent (ctx.defer)<br/>contact_mask y channels salen del blob firmado
  AG-)LLM: borrador por contacto (nota como DATO, sin herramientas)
  LLM--)AG: texto (o plantilla si tarda > LLM_TIMEOUT_MS)

  AG->>CH: avisar_contactos canal "sms" → WhatsApp (Kapso)
  CH-)K: ALERTA … Ubicación … Responde aquí: /r/{token}
  AG->>CH: avisar_contactos canal "email" → Resend
  AG->>CH: avisar_contactos canal "llamada_voz" → ElevenLabs + Twilio
  CH-)K: llamada saliente con agente de voz
  Note over AG: notifications: sent | simulated | failed | skipped_unverified
  AG->>MB: queueAck seq=1 código 1 "N contactos avisados"

  K-)CH: responde "Voy para allá, aguanta"
  CH->>MB: POST /v1/webhooks/whatsapp (HMAC) · o /r/{token}
  Note over MB: replies.js: texto = dato NO confiable, no pasa por el agente<br/>contacto → verified
  Note over MB: queueMsgIn srv_seq=1 · sellado a user.seal_pk, firmado

  alt R2: C consulta el buzón
    C->>MB: POST /v1/mailbox/poll
    MB-->>C: ACK código 1, MSG_IN
  else R5: el servidor empuja a egress cercanos
    C->>MB: GET /v1/egress/inbox?wait=25 (long-poll)
    MB-->>C: ACK código 1, MSG_IN
  end
  C-)A: inyecta al mesh con TTL 7
  Note over A: verifica firma del servidor, abre el blob con su seal_sk<br/>TextToSpeech: "Contacto 0: Voy para allá, aguanta"

  A-)C: UPDATE con rx_cursor = 1 (R6, propuesto)
  C->>MB: POST /v1/egress
  Note over MB: dropRadioCovered: deja de repetir el MSG_IN 1
```

## Respuesta del teléfono (MSG_OUT)

El camino inverso usa las mismas piezas. A dicta con el reconocimiento de voz offline
(`SpeechRecognizer`), arma un `MSG_OUT` (tipo 4, `contact_idx` y `channels`, sellado al servidor) que
viaja como el SOS del diagrama 3. El backend responde ACK código 0 y, diferido, llama a
`avisar_contactos` con el texto del usuario (sin LLM). En el teléfono, MSG_OUT no tiene código todavía.

## Supuestos / decisiones abiertas

- **Respuesta del contacto: resuelto en código.** Entra por cuatro caminos, todos hacia `ingestReply`:
  - el webhook de Kapso, que se asocia al último incidente avisado a ese número;
  - la página `/r/{token}` del enlace del aviso, o `POST /v1/replies`;
  - el webhook de SMS de Twilio;
  - `/v1/dev/simulate-reply` para el demo.
- **⚠ WhatsApp en el bit «sms».** Con `KAPSO_API_KEY`, el canal `sms` del contrato sale por WhatsApp.
  Fuera de la ventana de 24 h exige plantillas aprobadas por Meta. El contrato no lo menciona (punto 15
  en `README.md`).
- **Contactos verificados.** Con canales reales solo se avisa a contactos `verified`. Si no, el aviso
  queda `skipped_unverified` y, si nadie fue alcanzado, no sale el ACK código 1.
- **ACK código 1 "[SIMULADO]".** Si todos los avisos fueron simulados (sin credenciales), el texto del ACK
  lo dice.
- **Límite de tamaño de MSG_IN.** El backend corta la respuesta a 240 caracteres y el texto sellado a
  259 B.
- **El teléfono no confirma cada MSG_IN** (R4): el recibo es el `rx_cursor` de la siguiente baliza. Mientras
  no lo cubra, `radioTick` lo reencola cada 60 s. El buzón lo conserva 24 h.
- **Voz IA.** `POST /v1/convai/twilio/outbound-call` de ElevenLabs. **No se probó contra la API real**
  (`backend/README.md`).
- **No hay reintentos de avisos fallidos.**
