# Meshy

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

Probado en teléfonos reales contra el servidor de producción (Render), el 25 de octubre:

- **SOS sin internet**: un teléfono en modo avión envía el SOS por Bluetooth; otro teléfono con Meshy y
  conexión lo sube al servidor, y la confirmación vuelve al primero ("contactos avisados" en ~20 s).
- **Con un intermediario**: también a través de un tercer teléfono sin internet (A → M → C), ida y vuelta;
  el servidor registra el salto.
- **IA sin internet**: una pregunta de primeros auxilios viaja por la malla y la respuesta vuelve en segundos.
- **WhatsApp real** (Kapso): el usuario invita a cada contacto desde su propio WhatsApp; el contacto acepta
  con un código que solo vale para esa relación y recibe los avisos.
- Panel con mapa, saltos y estado de cada aviso. Pruebas automáticas en verde en la app y en el backend.

## Límites

- **Enlaces Bluetooth que se atascan**: tras unos minutos, un enlace puede quedar en un solo sentido
  cuando Android pierde la confirmación de un envío y la cola de ese enlace se llena. Lo que sube sigue
  llegando, pero las confirmaciones y respuestas no bajan hasta reabrir la app en el teléfono con internet.
  Causa identificada; el arreglo (temporizador por envío y reconexión del enlace) queda como siguiente paso.
- **WhatsApp en modo de pruebas (sandbox)**: cada contacto necesita activar una sesión de prueba antes. En
  producción, con número propio de WhatsApp Business, acepta con un solo toque.
- La llamada con voz IA, los pagos y el microcrédito están simulados.
- El alcance de la malla es local (decenas de metros por salto). Las distancias largas dependen de que las
  personas se muevan y de que el servidor empuje las respuestas a nodos cercanos.
- Meshy **no reemplaza a los servicios de emergencia**.

## Equipo

Equipo 15 · Platanus Hack 26: Caracas · Track Emergencias.

Código: <https://github.com/platanus-hack/platanus-hack-26-ve-team-15> (base del mesh bajo GPL-3.0,
ver `apps/android/LICENSE.md`).
