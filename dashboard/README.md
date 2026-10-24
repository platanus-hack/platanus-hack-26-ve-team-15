# Panel de Baliza Vital

Mapa en vivo y lista de incidentes. Sitio estático (HTML + CSS + JS, sin paso de compilación); Leaflet va incluido
en `vendor/` (licencia BSD-2). Los mosaicos del mapa (CARTO / OpenStreetMap) sí necesitan internet.

```bash
cd dashboard
python3 -m http.server 5173        # o: npx serve .
# abrir http://localhost:5173/?api=http://localhost:8080
```

## Conexión

La URL del backend se resuelve, en este orden, desde `?api=` en la URL, `localStorage` (botón **Ajustes**) o
`config.js`. Si el backend define `DASHBOARD_TOKEN`, ponlo en Ajustes (o `?token=`). El `ADMIN_TOKEN` es opcional y
solo habilita acciones de demo: simular la respuesta de un contacto y verificar contactos.

## Qué muestra

- **Lista** de incidentes (abiertos / todos) con gravedad, saltos del mesh y contactos avisados.
- **Mapa** con un pin por incidente (color por gravedad, pulso si está abierto) y círculo de precisión del GPS.
- **Detalle**: camino origen → relevos → egress → backend, ubicación y nota, avisos por contacto y canal con su
  estado real (`simulado` se marca como tal), comandos de las Fases 4 y 5 marcados `[MOCK]` y línea de tiempo.
- **Actualización en vivo** por SSE (`/v1/stream`) con reconexión automática.

Todo texto que llega del backend (notas, texto público, nombres) se inserta con `textContent`, nunca como HTML.

## Despliegue

`render.yaml` (raíz del repo) declara también este sitio como *static site* de Render. Tras desplegar el backend,
fija su URL en `config.js` o abre el panel con `?api=https://<backend>.onrender.com`.
