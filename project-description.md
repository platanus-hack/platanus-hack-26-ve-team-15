# Baliza Vital

**Un SOS que no necesita internet.** Cuando se cae la red, tu celular sigue siendo una baliza:
el aviso salta de teléfono en teléfono por Bluetooth hasta llegar a alguien que sí tiene conexión.

## El problema

En una emergencia (un desastre natural, un apagón, una zona sin cobertura) la primera pérdida es la
conexión. Justo cuando más se necesita avisar a alguien, el teléfono no puede.

## Cómo funciona

1. **Sin internet, pides ayuda.** Un teléfono sin conexión envía un SOS con categoría, gravedad,
   ubicación y un texto corto. Los datos sensibles van cifrados de extremo a extremo.
2. **La malla lo lleva.** El mensaje salta por Bluetooth de un teléfono a otro, sin infraestructura,
   hasta llegar a un teléfono con internet (el *egress*).
3. **El servidor actúa.** El egress lo sube al backend. Un agente de IA registra el incidente y avisa a
   tus contactos de emergencia por SMS, correo y llamada con voz de IA.
4. **La respuesta vuelve.** El teléfono recibe una confirmación (ACK) y las respuestas de tus contactos
   por la misma malla. El servidor busca al usuario por zona aunque el egress original se haya movido.

## Qué hay de especial

- **Entrega honesta:** la app no dice "enviado" ni "avisados" hasta recibir una confirmación firmada
  del servidor. Mientras tanto reintenta.
- **Protocolo propio y firmado:** paquetes de menos de 418 bytes que caben sin fragmentar en un
  mensaje Bluetooth, con firma Ed25519 y sellado cifrado al servidor.
- **Voz:** dictado y lectura en voz alta en el teléfono, y llamadas con voz de IA a los contactos.
- **Un módulo, no solo una app:** el SOS y la malla están pensados como un módulo embebible para
  superapps de transporte, delivery y pagos. Las recargas, pagos, rides y delivery vía agente son
  simulados en este demo.

## Estado

- Base Android (bitchat-android v2.0.3) integrada y compilando, con pruebas unitarias en verde.
- Contrato del protocolo, APIs y plan por fases definidos en `docs/contrato.md` y `docs/fases.md`.
- En construcción: tipo de mensaje de emergencia sobre la malla, backend de egress y buzón, agente de IA
  y panel con mapa en vivo.

## Límites

El alcance de la malla Bluetooth es local (decenas de metros por salto). Las distancias largas
dependen de que las personas se muevan y de que el servidor empuje las respuestas a nodos cercanos.
Baliza Vital **no reemplaza a los servicios de emergencia** y en este demo solo usa datos sintéticos.

## Equipo

Equipo 15 · Platanus Hack 26: Caracas · Track Emergencias.

Código: <https://github.com/platanus-hack/platanus-hack-26-ve-team-15> (base del mesh bajo GPL-3.0,
ver `apps/android/LICENSE.md`).
