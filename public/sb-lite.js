// ============================================================
// sb-lite.js — Reemplazo de @supabase/supabase-js
// Imita la API (sb.from, sb.auth, sb.channel) pero habla con
// nuestro propio backend (server.js + SQLite). Mismo origen.
// ============================================================
(function () {
  let token = null;
  try { token = localStorage.getItem('cmi_token'); } catch (e) {}

  function setToken(t) {
    token = t;
    try { t ? localStorage.setItem('cmi_token', t) : localStorage.removeItem('cmi_token'); } catch (e) {}
  }

  function currentToken() {
    try { return localStorage.getItem('cmi_token') || token; } catch (e) { return token; }
  }
  async function api(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const t = currentToken();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    let res, json;
    try {
      res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    } catch (e) {
      return { res: { ok: false, status: 0 }, json: { error: { message: 'Error de conexión' } } };
    }
    try { json = await res.json(); } catch (e) { json = {}; }
    return { res, json };
  }

  // ── Query builder (thenable) ─────────────────────────────────
  class Query {
    constructor(table) {
      this.t = table; this._op = 'select'; this._cols = '*';
      this._filters = []; this._order = []; this._limit = null;
      this._single = false; this._values = null;
    }
    select(cols) { this._op = 'select'; this._cols = cols || '*'; return this; }
    insert(values) { this._op = 'insert'; this._values = values; return this; }
    update(values) { this._op = 'update'; this._values = values; return this; }
    delete() { this._op = 'delete'; return this; }
    eq(col, val) { this._filters.push({ col, val }); return this; }
    order(col, opts) { this._order.push({ col, asc: !(opts && opts.ascending === false) }); return this; }
    limit(n) { this._limit = n; return this; }
    single() { this._single = true; return this; }
    _parseCols() {
      if (!this._cols || this._cols === '*') return null;
      return this._cols.split(',').map(s => s.trim()).filter(Boolean);
    }
    async _exec() {
      try {
        let endpoint, payload;
        if (this._op === 'select') {
          endpoint = '/api/select';
          payload = { table: this.t, columns: this._parseCols(), filters: this._filters, order: this._order, limit: this._limit, single: this._single };
        } else if (this._op === 'insert') {
          endpoint = '/api/insert'; payload = { table: this.t, values: this._values };
        } else if (this._op === 'update') {
          endpoint = '/api/update'; payload = { table: this.t, values: this._values, filters: this._filters };
        } else if (this._op === 'delete') {
          endpoint = '/api/delete'; payload = { table: this.t, filters: this._filters };
        } else {
          return { data: null, error: { message: 'Operación no soportada' } };
        }
        const { res, json } = await api(endpoint, payload);
        // Si el servidor ya devolvió un error explícito, lo respetamos.
        if (json && json.error) return { data: (json.data !== undefined ? json.data : null), error: json.error };
        // Respuesta HTTP fallida sin JSON de error (502/503, reinicio, HTML de error):
        // NO es un éxito. Nunca debe tratarse como guardado.
        if (!res || !res.ok) {
          return { data: null, error: { message: 'El servidor no confirmó la operación (código ' + ((res && res.status) || 'sin respuesta') + '). No se guardó; vuelve a intentarlo.' } };
        }
        // Escrituras: exigimos confirmación con 'data' presente. Sin ella, no damos por guardado.
        if (this._op !== 'select' && (!json || json.data === undefined)) {
          return { data: null, error: { message: 'No se recibió confirmación del servidor; no se guardó. Vuelve a intentarlo.' } };
        }
        return json;
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    }
    then(onF, onR) { return this._exec().then(onF, onR); }
    catch(onR) { return this._exec().catch(onR); }
  }

  // ── Realtime (SSE) ───────────────────────────────────────────
  let es = null;
  const channels = [];
  function ensureStream() {
    if (es || !token) return;
    es = new EventSource('/api/realtime?token=' + encodeURIComponent(token));
    es.onmessage = (e) => {
      let evt; try { evt = JSON.parse(e.data); } catch (_) { return; }
      if (!evt || !evt.eventType) return;
      for (const ch of channels) {
        for (const h of ch.handlers) {
          if (h.table && h.table !== evt.table) continue;
          if (h.event && h.event !== '*' && h.event !== evt.eventType) continue;
          try { h.cb({ eventType: evt.eventType, new: evt.new, old: evt.old, table: evt.table }); } catch (_) {}
        }
      }
    };
    es.onerror = () => { /* EventSource reconecta solo */ };
  }
  function closeStream() { if (es) { es.close(); es = null; } channels.length = 0; }

  class Channel {
    constructor(name) { this.name = name; this.handlers = []; }
    on(type, filter, cb) {
      this.handlers.push({ table: filter && filter.table, event: filter && filter.event, cb });
      return this;
    }
    subscribe() { channels.push(this); ensureStream(); return this; }
  }

  // ── Auth ─────────────────────────────────────────────────────
  const authListeners = [];
  function emit(event, session) {
    for (const cb of authListeners) { try { cb(event, session); } catch (_) {} }
  }

  const auth = {
    async signUp({ email, password }) {
      const { json } = await api('/api/auth/signup', { email, password });
      return { data: json.data || null, error: json.error || null };
    },
    async signInWithPassword({ email, password }) {
      const { res, json } = await api('/api/auth/login', { email, password });
      if (!res.ok || json.error || !json.token) {
        return { data: null, error: json.error || { message: 'Invalid login credentials' } };
      }
      setToken(json.token);
      emit('SIGNED_IN', { user: json.user });
      return { data: { user: json.user }, error: null };
    },
    async signOut() {
      setToken(null);
      closeStream();
      emit('SIGNED_OUT', null);
      return { error: null };
    },
    onAuthStateChange(cb) {
      authListeners.push(cb);
      (async () => {
        if (!token) { emit('SIGNED_OUT', null); return; }
        const { res, json } = await api('/api/auth/me', {});
        if (res.ok && json.user) { emit('SIGNED_IN', { user: json.user }); }
        else { setToken(null); emit('SIGNED_OUT', null); }
      })();
      return {
        data: {
          subscription: {
            unsubscribe() { const i = authListeners.indexOf(cb); if (i >= 0) authListeners.splice(i, 1); }
          }
        }
      };
    }
  };

  function createClient() {
    return { from: (t) => new Query(t), channel: (n) => new Channel(n), auth };
  }

  // Expuesto como window.supabase para que el front no cambie:
  //   const { createClient } = window.supabase;
  window.supabase = { createClient };
})();
