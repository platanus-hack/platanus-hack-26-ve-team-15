// Panel de Baliza Vital: lista, mapa en vivo y detalle de incidentes. Sin dependencias salvo Leaflet.
// Todo texto que viene del backend (nota, texto público, nombres) se inserta con textContent, nunca como HTML.

const SEV = { 3: ['Grave', 'var(--sev3)'], 2: ['Alta', 'var(--sev2)'], 1: ['Media', 'var(--sev1)'], 0: ['Cerrado', 'var(--closed)'] };
const MSG_TYPES = { 1: 'SOS', 2: 'baliza (UPDATE)', 3: 'ACK', 4: 'mensaje del usuario', 5: 'respuesta de contacto', 6: 'comando', 7: 'resultado de comando' };
const CHANNELS = { sms: 'WhatsApp/SMS', email: 'Correo', voice: 'Llamada de voz', llamada_voz: 'Llamada de voz' };
const STATES = { sent: 'enviado', simulated: 'simulado', delivered: 'entregado', read: 'leído', failed: 'falló', skipped_unverified: 'sin verificar', no_address: 'sin dato' };
const CMD_STATUS = { 0: 'ok', 1: 'rechazado', 2: 'error', 3: 'función desactivada' };
const EVENT_KINDS = ['user_registered', 'user_updated', 'contacts_updated', 'incident_created', 'incident_updated', 'packet_received',
  'mailbox', 'contacts_notified', 'contact_reply', 'command', 'blob_unreadable', 'notification_status'];

const CAT_INFO = {
  0: { icon: '📍', label: 'Alerta General' },
  1: { icon: '🩺', label: 'Médica' },
  2: { icon: '🔥', label: 'Incendio' },
  3: { icon: '🛡️', label: 'Seguridad' },
  4: { icon: '💥', label: 'Accidente' },
  5: { icon: '🌊', label: 'Desastre' },
  6: { icon: '🧗', label: 'Rescate / Perdido' },
  7: { icon: '⚠️', label: 'Otra Emergencia' }
};

const CHANNEL_ICONS = {
  sms: '💬 WhatsApp / SMS',
  email: '✉️ Correo',
  voice: '📞 Llamada de voz IA',
  llamada_voz: '📞 Llamada de voz IA'
};

// --- configuración -----------------------------------------------------------------------------

const safe = (fn, dflt) => { try { return fn(); } catch { return dflt; } };
const stored = safe(() => JSON.parse(localStorage.getItem('baliza.cfg') || '{}'), {});
const params = new URLSearchParams(location.search);
const cfg = {
  api: (params.get('api') || stored.api || window.BALIZA_CONFIG?.api || '').replace(/\/$/, ''),
  token: params.get('token') || stored.token || '',
  admin: stored.admin || '',
  mapProvider: params.get('map') || stored.mapProvider || 'esri',
  cartoKey: params.get('cartoKey') || stored.cartoKey || '',
};

const state = { incidents: [], filter: 'open', mode: 'demo', selected: null, detail: null, features: null, markers: new Map(), tracks: new Map(), es: null, ready: false };

// --- utilidades DOM ------------------------------------------------------------------------------

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);
const clear = (el) => { el.replaceChildren(); return el; };

function ago(ts) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 10) return 'ahora';
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}
const clock = (ts) => new Date(ts * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const sevOf = (i) => (i.status === 'closed' ? SEV[0] : SEV[i.severity] ?? SEV[1]);
const keyOf = (i) => `${i.sender_id}:${i.incident_id}`;

function toast(text, color = 'var(--accent)') {
  const t = h('div', { class: 'toast', style: `--c:${color}`, role: 'status' }, text);
  $('toasts').append(t);
  setTimeout(() => t.remove(), 6000);
}

// --- API -----------------------------------------------------------------------------------------

async function api(path, { method = 'GET', body, admin = false } = {}) {
  const headers = {};
  const bearer = admin ? cfg.admin : cfg.token;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(cfg.api + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// --- conexión en vivo ----------------------------------------------------------------------------

function setConn(stateName, text) {
  const el = $('conn');
  el.dataset.state = stateName;
  el.lastElementChild.textContent = text;
}

function connect() {
  state.es?.close();
  if (!cfg.api) { setConn('down', 'Configura la URL del backend'); return; }
  const url = `${cfg.api}/v1/stream${cfg.token ? `?token=${encodeURIComponent(cfg.token)}` : ''}`;
  const es = new EventSource(url);
  state.es = es;
  es.onopen = () => setConn('live', 'En vivo');
  es.onerror = () => setConn('down', 'Sin conexión, reintentando…');
  for (const kind of EVENT_KINDS) es.addEventListener(kind, (msg) => onEvent(safe(() => JSON.parse(msg.data), null)));
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await loadIncidents();
    if (state.selected) await loadDetail();
  }, 300);
}

function onEvent(e) {
  if (!e) return;
  const fresh = Date.now() / 1000 - e.at < 30;
  if (e.kind === 'incident_created' && state.ready && fresh) toast('Nuevo SOS recibido', 'var(--sev3)');
  if (e.kind === 'contact_reply' && state.ready && fresh) toast('Un contacto respondió', 'var(--ok)');
  if (e.kind === 'notification_status' || e.incident_id || e.kind.startsWith('user')) scheduleRefresh();
}

// --- datos ----------------------------------------------------------------------------------------

async function loadIncidents() {
  try {
    const { incidents } = await api('/v1/incidents');
    state.incidents = incidents;
    state.ready = true;
    render();
  } catch (e) {
    clear($('list')).append(h('li', { class: 'empty' }, `No se pudo cargar: ${e.message}`));
  }
}

async function loadFeatures() {
  state.features = (await fetch(`${cfg.api}/health`).then((r) => r.json()).catch(() => ({})))?.features ?? null;
  renderStats();
}

async function loadDetail() {
  if (!state.selected) return;
  const { sender_id: s, incident_id: i } = state.selected;
  try {
    state.detail = await api(`/v1/incidents/${s}/${i}`);
  } catch {
    state.detail = null;
  }
  renderDetail();
}

// --- render ---------------------------------------------------------------------------------------

function isDemoIncident(i) {
  const d = (i.display_name || '').toLowerCase();
  const p = (i.public_text || '').toLowerCase();
  const e = (i.egress_id || '').toLowerCase();
  return d.includes('demo') || d.includes('movimiento') || p.includes('sos inicial') || p.includes('sigo aqui') || e.includes('post-vector') || e.includes('chacao');
}

function visible() {
  return state.incidents.filter((i) => {
    if (state.mode === 'real' && isDemoIncident(i)) return false;
    return state.filter === 'all' || i.status === 'open';
  });
}

function render() {
  renderStats();
  renderList();
  renderMap();
  renderDetail();
}

function renderStats() {
  const open = state.incidents.filter((i) => i.status === 'open');
  const hops = open.map((i) => i.hops).filter((n) => Number.isInteger(n));
  const avg = hops.length ? (hops.reduce((a, b) => a + b, 0) / hops.length).toFixed(1) : '–';
  const notified = state.incidents.reduce((a, i) => a + (i.notified_count || 0), 0);
  const flag = (icon, name, on) => h('div', { class: `stat flag ${on ? 'on' : 'off'}`, title: 'Fases 4 y 5: simuladas (mock)' },
    h('span', {}, `${icon} ${name}`), h('b', {}, on === null || on === undefined ? '?' : on ? 'ON (mock)' : 'OFF'));
  clear($('stats')).append(
    h('div', { class: 'stat', title: 'Incidentes activos esperando rescate' }, h('b', { style: 'color:var(--sev3);' }, `🚨 ${open.length}`), h('span', {}, 'abiertos')),
    h('div', { class: 'stat', title: 'Total de paquetes SOS registrados' }, h('b', {}, `📋 ${state.incidents.length}`), h('span', {}, 'total')),
    h('div', { class: 'stat', title: 'Promedio de saltos Bluetooth requeridos para llegar al Egress' }, h('b', { style: 'color:var(--accent);' }, `📡 ${avg}`), h('span', {}, 'saltos prom.')),
    h('div', { class: 'stat', title: 'Familiares y contactos de emergencia notificados' }, h('b', { style: 'color:var(--ok);' }, `👥 ${notified}`), h('span', {}, 'contactos avisados')),
    flag('💳', 'Pagos', state.features?.payments), flag('🛵', 'Rides', state.features?.rides),
  );
}

function renderList() {
  const items = visible();
  const list = $('list');
  if (!items.length) {
    state.lastListSig = '';
    clear(list).append(h('li', { class: 'empty' }, state.ready ? 'Sin incidentes. Cuando un teléfono envíe un SOS, aparecerá aquí.' : 'Cargando…'));
    return;
  }

  // Firma estricta: si los datos no cambiaron de fondo, solo actualizamos los tiempos relativos in-place para eliminar el parpadeo
  const selKey = state.selected ? `${state.selected.sender_id}:${state.selected.incident_id}` : '';
  const sig = items.map((i) => `${keyOf(i)}:${i.severity}:${i.status}:${i.hops}:${i.notified_count}:${i.public_text}`).join('|') + `::sel=${selKey}`;

  if (state.lastListSig === sig && list.children.length === items.length) {
    items.forEach((i, idx) => {
      const card = list.children[idx]?.querySelector('.card');
      const timeEl = card?.querySelector('.t small');
      if (timeEl) timeEl.textContent = ago(i.updated_at);
    });
    return;
  }

  state.lastListSig = sig;
  clear(list);

  for (const i of items) {
    const [label, color] = sevOf(i);
    const k = keyOf(i);
    const sel = selKey === k;
    const cat = CAT_INFO[i.category] ?? { icon: '⚠️', label: i.category_label || 'Emergencia' };

    list.append(h('li', { 'data-key': k }, h('button', {
      class: `card${sel ? ' sel' : ''}`,
      type: 'button',
      style: `--c:${color}`,
      onclick: () => select(i)
    },
      h('div', { class: 't' },
        h('span', {}, `${cat.icon} ${i.display_name ?? 'Usuario'} · ${cat.label}`),
        h('small', {}, ago(i.updated_at))
      ),
      h('div', { class: 'txt' }, i.public_text || 'Sin texto descriptivo'),
      h('div', { class: 'chips' },
        h('span', { class: 'chip sev' }, i.status === 'closed' ? '✅ Cerrado' : `🚨 ${label} · ${i.severity}/3`),
        Number.isInteger(i.hops) && h('span', { class: 'chip' }, `📡 ${i.hops} ${i.hops === 1 ? 'salto' : 'saltos'}`),
        h('span', { class: 'chip muted' }, `👥 ${i.notified_count} avisados`),
        i.lat === null
          ? h('span', { class: 'chip muted' }, '📍 Sin señal GPS')
          : h('span', { class: 'chip' }, `📍 GPS ±${i.accuracy_m || 10}m`)
      ),
    )));
  }
}

// --- mapa -----------------------------------------------------------------------------------------

const map = L.map('map', { zoomControl: true, attributionControl: true }).setView([10.4806, -66.9036], 12);

let baseLayers = [];
function setBaseLayer(provider, cartoKey) {
  for (const l of baseLayers) map.removeLayer(l);
  baseLayers = [];
  if (provider === 'carto') {
    const keyParam = cartoKey ? `?api_key=${encodeURIComponent(cartoKey)}` : '';
    const layer = L.tileLayer(`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png${keyParam}`, {
      maxZoom: 19, subdomains: 'abcd', attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    });
    layer.addTo(map);
    baseLayers.push(layer);
  } else if (provider === 'osm') {
    const layer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
    });
    layer.addTo(map);
    baseLayers.push(layer);
  } else {
    // Esri Dark Canvas: Gratuito, sin marca de agua, alto contraste y rendimiento
    const base = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 16, attribution: '&copy; Esri, HERE, Garmin &copy; OpenStreetMap',
    });
    const ref = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 16,
    });
    base.addTo(map);
    ref.addTo(map);
    baseLayers.push(base, ref);
  }
}
setBaseLayer(cfg.mapProvider, cfg.cartoKey);

function pinIcon(i, selected) {
  const open = i.status === 'open';
  return L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11],
    html: `<div class="pin${open ? ' open' : ''}${selected ? ' sel' : ''}" style="--c:${sevOf(i)[1]}"><b></b></div>` });
}

function renderMap() {
  const seen = new Set();
  let first = state.markers.size === 0;
  for (const i of visible()) {
    if (i.lat === null) continue;
    const k = keyOf(i);
    seen.add(k);
    const selected = state.selected && k === `${state.selected.sender_id}:${state.selected.incident_id}`;

    // Rastro de movimiento en tiempo real (breadcrumb trail)
    let track = state.tracks.get(k);
    if (!track) {
      track = { pts: [[i.lat, i.lon]], line: null };
      state.tracks.set(k, track);
    } else {
      const last = track.pts[track.pts.length - 1];
      if (Math.abs(last[0] - i.lat) > 0.00005 || Math.abs(last[1] - i.lon) > 0.00005) {
        track.pts.push([i.lat, i.lon]);
        if (track.pts.length > 50) track.pts.shift();
      }
    }

    if (track.pts.length > 1) {
      if (!track.line) {
        track.line = L.polyline(track.pts, { color: '#06b6d4', weight: 3, opacity: 0.85, dashArray: '6 6' }).addTo(map);
      } else {
        track.line.setLatLngs(track.pts);
      }
    }

    let m = state.markers.get(k);
    if (!m) {
      m = {
        pin: L.marker([i.lat, i.lon], { icon: pinIcon(i, selected) }).addTo(map),
        ring: L.circle([i.lat, i.lon], { radius: i.accuracy_m || 1, color: '#06b6d4', weight: 1, dashArray: '4 4', fillOpacity: 0.06 }).addTo(map),
      };
      m.pin.on('click', () => select(i));
      state.markers.set(k, m);
    } else {
      const curPos = m.pin.getLatLng();
      const moved = Math.abs(curPos.lat - i.lat) > 0.00005 || Math.abs(curPos.lng - i.lon) > 0.00005;
      m.pin.setLatLng([i.lat, i.lon]).setIcon(pinIcon(i, selected));
      m.ring.setLatLng([i.lat, i.lon]).setRadius(i.accuracy_m || 1);
      if (moved && selected) {
        map.panTo([i.lat, i.lon], { animate: true, duration: 0.8 });
      }
    }
    const cat = CAT_INFO[i.category] ?? { icon: '⚠️', label: i.category_label || 'Emergencia' };
    const [label, color] = sevOf(i);
    const popupHtml = `
      <div style="min-width:180px;">
        <h4 style="font-size:13px; font-weight:700; margin:0 0 4px 0; color:#fff;">${cat.icon} ${i.display_name ?? 'Usuario'}</h4>
        <p style="font-size:11.5px; color:#cbd5e1; margin:0 0 6px 0; line-height:1.35;">${i.public_text || 'Sin texto descriptivo'}</p>
        <div style="display:flex; gap:5px; flex-wrap:wrap;">
          <span style="font-size:10px; font-weight:700; padding:2px 7px; border-radius:999px; background:${color}33; color:${color}; border:1px solid ${color}66;">${label} · ${i.severity}/3</span>
          <span style="font-size:10px; padding:2px 7px; border-radius:999px; background:rgba(255,255,255,0.08); color:#e2e8f0;">📡 ${i.hops ?? 0} saltos</span>
        </div>
      </div>
    `;
    m.pin.bindPopup(popupHtml, { offset: [0, -10] });
    m.pin.bindTooltip(h('span', {}, `${cat.icon} ${i.display_name ?? 'Usuario'} · ${cat.label}`), { direction: 'top', offset: [0, -10] });
  }

  for (const [k, m] of state.markers) {
    if (!seen.has(k)) {
      m.pin.remove();
      m.ring.remove();
      state.markers.delete(k);
      const track = state.tracks.get(k);
      if (track?.line) track.line.remove();
      state.tracks.delete(k);
    }
  }

  if (first && seen.size) {
    const pts = visible().filter((i) => i.lat !== null).map((i) => [i.lat, i.lon]);
    if (pts.length) map.fitBounds(pts, { padding: [60, 60], maxZoom: 15 });
  }
}

window.centerOnActiveIncident = () => {
  if (!state.selected) return;
  const k = `${state.selected.sender_id}:${state.selected.incident_id}`;
  const i = state.incidents.find((x) => keyOf(x) === k);
  if (i && i.lat !== null) {
    map.flyTo([i.lat, i.lon], 16, { duration: 0.8 });
    const m = state.markers.get(k);
    if (m?.pin) m.pin.openPopup();
  }
};

async function select(i) {
  state.selected = { sender_id: i.sender_id, incident_id: i.incident_id };
  state.detail = null;
  render();
  if (i.lat !== null) {
    map.flyTo([i.lat, i.lon], Math.max(map.getZoom(), 15), { duration: 0.8 });
    const k = keyOf(i);
    const m = state.markers.get(k);
    if (m?.pin) m.pin.openPopup();
  }
  const btnRecenter = $('btn-map-recenter');
  if (btnRecenter) btnRecenter.style.display = i.lat !== null ? 'inline-flex' : 'none';
  await loadDetail();
}

// --- detalle --------------------------------------------------------------------------------------

function pathView(i) {
  const relays = Number.isInteger(i.hops) ? Math.min(i.hops, 7) : 0;
  const parts = [h('div', { class: 'node origin' }, h('i'), h('span', {}, '📱 Origen'))];
  for (let n = 0; n < relays; n += 1) {
    parts.push(h('div', { class: 'link hop' }), h('div', { class: 'node' }, h('i'), h('span', {}, `🔄 Salto ${n + 1}`)));
  }
  parts.push(
    h('div', { class: 'link' }),
    h('div', { class: 'node egress' }, h('i'), h('span', {}, '🌐 Egress')),
    h('div', { class: 'link' }),
    h('div', { class: 'node cloud' }, h('i'), h('span', {}, '☁️ Backend'))
  );
  return h('div', { class: 'path' }, parts);
}

function describe(e, names) {
  const d = e.data || {};
  const who = (idx) => names[idx] ?? `contacto ${idx}`;
  switch (e.kind) {
    case 'incident_created': return ['🚨 SOS inicial registrado en el sistema', 'var(--sev3)'];
    case 'incident_updated': return [d.status === 'closed' ? '✅ Incidente cerrado por el usuario' : '🔄 Actualización del usuario (Baliza)', 'var(--sev1)'];
    case 'packet_received': return [`📡 Llegó ${MSG_TYPES[d.msg_type] ?? 'paquete'} #${d.seq}${d.hops != null ? ` tras ${d.hops} ${d.hops === 1 ? 'salto' : 'saltos'}` : ''} por ${d.egress_id}`, 'var(--accent)'];
    case 'mailbox': return [`📬 ${MSG_TYPES[d.msg_type] ?? 'Mensaje'} dejado en buzón para el teléfono`, 'var(--violet)'];
    case 'contacts_notified': return [`👥 Aviso por ${CHANNEL_ICONS[d.canal] ?? d.canal}: ${(d.enviados || []).map((x) => `${who(x.indice)} (${STATES[x.estado] ?? x.estado})`).join(', ') || 'nadie'}`, 'var(--ok)'];
    case 'contact_reply': return [`💬 ${who(d.contact_idx)} respondió por ${CHANNEL_ICONS[d.channel] ?? d.channel}`, 'var(--ok)'];
    case 'command': return [`⚡ Comando ${d.cmd} (ref ${d.ref}): ${CMD_STATUS[d.status] ?? d.status}`, 'var(--warn)'];
    case 'blob_unreadable': return ['⚠️ No se pudo abrir el contenido sellado; se usó aviso de emergencia a todos los contactos', 'var(--bad)'];
    case 'notification_status': return [`📬 Estado de entrega actualizado: ${STATES[d.status] ?? d.status}`, 'var(--ok)'];
    default: return null;
  }
}

async function adminPost(path, body, okText) {
  try {
    await api(path, { method: 'POST', body, admin: true });
    toast(okText, 'var(--ok)');
    scheduleRefresh();
  } catch (e) {
    toast(`Falló: ${e.message}`, 'var(--bad)');
  }
}

function renderDetail() {
  const el = $('detail');
  const d = state.detail;
  if (!state.selected || !d) {
    state.lastDetailSig = '';
    clear(el).append(state.selected
      ? h('div', { class: 'sec' }, h('div', { class: 'skeleton' }))
      : h('div', { class: 'empty' }, h('p', {}, '👆 Selecciona un incidente en la lista o en el mapa para ver su camino por el mesh, los avisos y la telemetría en tiempo real.')));
    return;
  }
  const i = d.incident;
  const [label, color] = sevOf(i);
  const names = Object.fromEntries((d.contacts || []).map((c) => [c.idx, c.name]));
  const simulated = d.notifications.some((n) => n.state === 'simulated');
  const commands = d.events.filter((e) => e.kind === 'command');
  const cat = CAT_INFO[i.category] ?? { icon: '⚠️', label: i.category_label || 'Emergencia' };

  // Evita re-renderizado parpadeante si los datos del detalle no han cambiado
  const detailSig = `${i.sender_id}:${i.incident_id}:${i.updated_at}:${d.events?.length}:${d.notifications?.length}:${d.notifications?.map(n=>n.state).join(',')}`;
  if (state.lastDetailSig === detailSig && el.children.length > 0) {
    const timeHead = el.querySelector('.d-head p');
    if (timeHead) timeHead.textContent = `${cat.icon} ${cat.label} · ${ago(i.updated_at)} · ID ${i.incident_id}`;
    return;
  }
  state.lastDetailSig = detailSig;
  clear(el);

  el.append(
    h('div', { class: 'd-head' },
      h('h2', {}, `${cat.icon} ${i.display_name ?? 'Usuario'} `, h('span', { class: 'chip sev', style: `--c:${color}` }, i.status === 'closed' ? '✅ Cerrado' : `🚨 ${label} · ${i.severity}/3`)),
      h('p', {}, `${cat.label} · ${ago(i.updated_at)} · ID ${i.incident_id}`)),

    h('div', { class: 'sec' },
      h('h3', {}, '📡 Camino del SOS por el Mesh (Bluetooth BLE)'),
      h('p', { class: 'sec-explain' }, 'Telemetría de saltos de radio: el paquete de 418 bytes rebotó de teléfono en teléfono sin conexión hasta alcanzar el puente Egress.'),
      pathView(i),
      h('p', { class: 'hint', style: 'margin-top:10px; display:flex; align-items:center; gap:6px;' },
        h('span', { style: 'color:var(--accent); font-weight:700;' }, '⚡ Salto:'),
        Number.isInteger(i.hops) ? `${i.hops} ${i.hops === 1 ? 'salto de radio' : 'saltos de radio'} hasta el nodo con internet${i.egress_id ? ` (${i.egress_id})` : ''}` : 'Saltos desconocidos')
    ),

    h('div', { class: 'sec' },
      h('h3', {}, '📍 Situación y Telemetría'),
      h('p', { class: 'sec-explain' }, 'Datos públicos compartidos por radio para socorro local por vecinos o brigadistas. La nota confidencial viaja sellada de extremo a extremo.'),
      h('dl', { class: 'kv' },
        h('dt', {}, '📝 Texto público'), h('dd', {}, i.public_text || '–'),
        h('dt', {}, '🌍 Coordenadas'), h('dd', {}, i.lat === null ? 'Sin ubicación' : [
          h('span', {}, `${i.lat.toFixed(5)}, ${i.lon.toFixed(5)}`),
          h('button', {
            class: 'btn sm primary',
            type: 'button',
            style: 'padding: 2px 9px; font-size: 11px; margin-left: 6px;',
            onclick: () => window.centerOnActiveIncident()
          }, '🎯 Centrar en mapa')
        ]),
        h('dt', {}, '🎯 Precisión GPS'), h('dd', {}, i.lat === null ? '–' : `±${i.accuracy_m} m · fix de hace ${i.location_age_s} s`),
        h('dt', {}, '⏱️ Recibido'), h('dd', {}, `${clock(i.created_at)} (${ago(i.created_at)})`)),
      i.note && h('div', { class: 'note' },
        h('b', { style: 'color:var(--accent); display:block; margin-bottom:3px;' }, '🔒 Nota Médica Confidencial:'),
        i.note
      )
    ),

    h('div', { class: 'sec' },
      h('h3', {}, '👥 Avisos a Contactos de Emergencia', h('span', {}, `${i.notified_count} avisados`)),
      h('p', { class: 'sec-explain' }, 'Agente autónomo: notifica en paralelo vía WhatsApp, SMS, llamadas de voz con IA y correo electrónico.'),
      simulated && h('div', { class: 'mock' }, 'ℹ️ Modo Demostración: Los avisos se simulan localmente porque no hay credenciales de mensajería o telefonía configuradas en este entorno.'),
      d.notifications.length
        ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Contacto'), h('th', {}, 'Canal'), h('th', {}, 'Estado'), h('th', {}, ''))),
          h('tbody', {}, d.notifications.map((n) => h('tr', {},
            h('td', {}, names[n.contact_idx] ?? `#${n.contact_idx}`),
            h('td', {}, CHANNEL_ICONS[n.channel] ?? n.channel),
            h('td', {}, h('span', { class: `badge ${n.state}`, title: n.detail || '' }, STATES[n.state] ?? n.state)),
            h('td', {}, cfg.admin && n.state === 'skipped_unverified' && h('button', { class: 'btn sm', type: 'button',
              onclick: () => adminPost('/v1/admin/contacts/verify', { sender_id: i.sender_id, index: n.contact_idx }, 'Contacto verificado') }, 'Verificar'))))))
        : h('p', { class: 'hint', style: 'color:var(--muted)' }, 'Aún no se avisó a ningún contacto.'),
      h('div', { style: 'margin-top: 12px; display: flex; flex-direction: column; gap: 8px;' },
        h('button', {
          class: 'btn primary',
          style: 'width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; font-weight: 600; font-size: 13px;',
          type: 'button',
          onclick: () => showQrModal(d)
        }, '📱 Ver Opciones / QR para el Jurado')),
      cfg.admin && d.notifications.length > 0 && replyForm(i, d.notifications[0].contact_idx)
    ),

    h('div', { class: 'sec' },
      h('h3', {}, '⚡ Comandos Offline (Movilidad y Logística de Asistencia)'),
      h('p', { class: 'sec-explain' }, 'Capacidades de contingencia: el usuario sin datos puede solicitar traslado de auxilio médico o suministros vía comando firmado.'),
      commands.length
        ? commands.map((e) => h('div', { class: 'mock' }, `[MOCK] ${e.data.cmd} · ref ${e.data.ref} · ${CMD_STATUS[e.data.status] ?? e.data.status}`))
        : h('p', { class: 'hint', style: 'color:var(--muted)' }, 'Sin comandos solicitados por el usuario aún.'),
      h('button', { class: 'btn primary', style: 'margin-top: 10px; width: 100%; font-size: 13px;', type: 'button',
        onclick: () => adminPost('/v1/dev/dispatch-ride', { sender_id: i.sender_id, incident_id: i.incident_id, destino: 'Punto de Asistencia Táctica / Altamira' }, '🚑 Unidad de Asistencia despachada') },
        '🚑 Despachar Unidad de Asistencia')
    ),

    h('div', { class: 'sec' },
      h('h3', {}, '⏱️ Bitácora de Eventos en Tiempo Real'),
      h('p', { class: 'sec-explain' }, 'Historial inmutable con cada paquete, acuse de recibo (ACK) y respuestas recibidas.'),
      h('ol', { class: 'timeline' }, [...d.events].reverse().map((e) => {
        const info = describe(e, names);
        return info && h('li', { style: `--c:${info[1]}` }, h('time', {}, `${clock(e.at)} · ${ago(e.at)}`), info[0]);
      }))
    ),
  );
}

function replyForm(i, defaultIdx) {
  const input = h('input', { type: 'text', placeholder: 'Respuesta de prueba del contacto…', maxlength: '200', 'aria-label': 'Respuesta de prueba' });
  const send = () => {
    if (!input.value.trim()) return;
    adminPost('/v1/dev/simulate-reply', { sender_id: i.sender_id, incident_id: i.incident_id, contact_idx: defaultIdx, channel: 'sms', text: input.value.trim() }, 'Respuesta enviada al buzón');
    input.value = '';
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  return h('div', { class: 'reply-form' }, input, h('button', { class: 'btn primary', type: 'button', onclick: send }, 'Simular respuesta'));
}

// --- ajustes y arranque ---------------------------------------------------------------------------

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  state.filter = b.dataset.filter;
  document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
  render();
}));

const dlg = $('dlg-settings');
const form = $('form-settings');
$('btn-settings').addEventListener('click', () => {
  form.api.value = cfg.api;
  form.token.value = cfg.token;
  form.admin.value = cfg.admin;
  if (form.mapProvider) form.mapProvider.value = cfg.mapProvider || 'esri';
  if (form.cartoKey) form.cartoKey.value = cfg.cartoKey || '';
  dlg.showModal();
});
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  Object.assign(cfg, {
    api: form.api.value.trim().replace(/\/$/, ''),
    token: form.token.value,
    admin: form.admin.value,
    mapProvider: form.mapProvider ? form.mapProvider.value : 'esri',
    cartoKey: form.cartoKey ? form.cartoKey.value.trim() : '',
  });
  safe(() => localStorage.setItem('baliza.cfg', JSON.stringify(cfg)));
  setBaseLayer(cfg.mapProvider, cfg.cartoKey);
  start();
});

async function start() {
  state.ready = false;
  clear($('list')).append(h('li', {}, h('div', { class: 'skeleton' })), h('li', {}, h('div', { class: 'skeleton' })));
  if (!cfg.api) { setConn('down', 'Configura la URL del backend'); dlg.showModal(); return; }
  connect();
  await Promise.all([loadIncidents(), loadFeatures()]);
}

// Sincronización periódica en vivo cada 2.5 s (respaldo activo de SSE para asegurar tiempo real)
setInterval(async () => {
  if (!state.ready) return;
  await loadIncidents();
  if (state.selected) await loadDetail();
}, 2500);

// Actualiza los textos de tiempo relativo ("hace X s") cada 5 s
setInterval(() => {
  if (state.ready) {
    renderList();
    if (state.detail) renderDetail();
  }
}, 5000);

function setMode(mode) {
  state.mode = mode;
  $('btn-mode-demo')?.classList.toggle('on', mode === 'demo');
  $('btn-mode-real')?.classList.toggle('on', mode === 'real');
  const banner = $('mode-banner');
  if (banner) {
    banner.className = `mode-banner ${mode}-banner`;
    const demoView = $('banner-demo-view');
    const realView = $('banner-real-view');
    if (demoView) demoView.style.display = mode === 'demo' ? 'flex' : 'none';
    if (realView) realView.style.display = mode === 'real' ? 'flex' : 'none';
  }
  render();
}

$('btn-mode-demo')?.addEventListener('click', () => setMode('demo'));
$('btn-mode-real')?.addEventListener('click', () => setMode('real'));

$('btn-demo-mov')?.addEventListener('click', async () => {
  await adminPost('/v1/dev/run-simulation', {}, 'Simulación de desplazamiento en Chacao iniciada');
});

$('btn-demo-clear')?.addEventListener('click', async () => {
  if (!confirm('¿Deseas limpiar los incidentes y vectores sintéticos de prueba?')) return;
  await adminPost('/v1/admin/clear-demo', {}, 'Incidentes de prueba limpiados');
  state.selected = null;
  state.tracks.clear();
  scheduleRefresh();
});

// --- modal qr e interacción jurado ----------------------------------------------------------------
function showQrModal(d) {
  const dlgQr = $('dlg-qr');
  if (!dlgQr) return;
  const replyUrl = d.primary_reply_url || (d.notifications && d.notifications[0]?.reply_url) || `${cfg.api}/r/demo`;
  const qrImg = $('qr-img');
  const qrLink = $('qr-link');
  if (qrImg) {
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(replyUrl)}`;
  }
  if (qrLink) {
    qrLink.href = replyUrl;
    qrLink.textContent = replyUrl;
  }
  setQrTab('qr');
  dlgQr.showModal();
}

function setQrTab(tab) {
  const isQr = tab === 'qr';
  $('tab-qr')?.classList.toggle('primary', isQr);
  $('tab-qr')?.classList.toggle('ghost', !isQr);
  $('tab-wa')?.classList.toggle('primary', !isQr);
  $('tab-wa')?.classList.toggle('ghost', isQr);
  const viewQr = $('view-tab-qr');
  const viewWa = $('view-tab-wa');
  if (viewQr) viewQr.style.display = isQr ? 'flex' : 'none';
  if (viewWa) viewWa.style.display = isQr ? 'none' : 'flex';
}

$('tab-qr')?.addEventListener('click', () => setQrTab('qr'));
$('tab-wa')?.addEventListener('click', () => setQrTab('wa'));
$('btn-close-qr')?.addEventListener('click', () => $('dlg-qr')?.close());
$('btn-close-qr-top')?.addEventListener('click', () => $('dlg-qr')?.close());
$('dlg-qr')?.addEventListener('click', (e) => {
  if (e.target === $('dlg-qr')) $('dlg-qr').close();
});

// --- modal glosario / diccionario -----------------------------------------------------------------
const dlgGlossary = $('dlg-glossary');
$('btn-glossary')?.addEventListener('click', () => dlgGlossary?.showModal());
$('btn-close-glossary')?.addEventListener('click', () => dlgGlossary?.close());
$('btn-close-glossary-bottom')?.addEventListener('click', () => dlgGlossary?.close());
dlgGlossary?.addEventListener('click', (e) => {
  if (e.target === dlgGlossary) dlgGlossary.close();
});

// --- botón flotante recentrar en mapa -------------------------------------------------------------
$('btn-map-recenter')?.addEventListener('click', () => {
  if (window.centerOnActiveIncident) window.centerOnActiveIncident();
});

start();
