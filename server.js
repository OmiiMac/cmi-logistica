const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ============================================================
// BASE DE DATOS (SQLite — archivo autónomo)
// ============================================================
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'cmi.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

// node:sqlite no trae el helper .transaction() de better-sqlite3.
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS auth_users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
  id         TEXT PRIMARY KEY,
  email      TEXT,
  name       TEXT,
  role       TEXT NOT NULL DEFAULT 'engineer',
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  address    TEXT,
  supervisor TEXT,
  engineer_id TEXT,
  color      TEXT DEFAULT '#9B1B30',
  status     TEXT DEFAULT 'active',
  notes      TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL,
  unit       TEXT,
  quantity   INTEGER DEFAULT 0,
  min_stock  INTEGER DEFAULT 0,
  estado     TEXT DEFAULT 'OPERATIVA',
  notes      TEXT,
  project_id TEXT,
  updated_by TEXT,
  updated_at TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS transfers (
  id           TEXT PRIMARY KEY,
  item_name    TEXT,
  from_project TEXT,
  to_project   TEXT,
  quantity     INTEGER,
  unit         TEXT,
  by_user      TEXT,
  notes        TEXT,
  date         TEXT
);
CREATE TABLE IF NOT EXISTS rutas (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL,
  hora        TEXT,
  origen      TEXT,
  destino     TEXT,
  conductor   TEXT,
  descripcion TEXT,
  status      TEXT DEFAULT 'pendiente',
  updated_by  TEXT,
  updated_at  TEXT,
  created_at  TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  content    TEXT,
  created_at TEXT
);
`);

// Columnas permitidas por tabla (whitelist anti-inyección e integridad)
const SCHEMA = {
  profiles:  ['id', 'email', 'name', 'role', 'status', 'created_at', 'updated_at'],
  projects:  ['id', 'name', 'address', 'supervisor', 'engineer_id', 'color', 'status', 'notes', 'created_at', 'updated_at'],
  items:     ['id', 'name', 'category', 'unit', 'quantity', 'min_stock', 'estado', 'notes', 'project_id', 'updated_by', 'updated_at', 'created_at'],
  transfers: ['id', 'item_name', 'from_project', 'to_project', 'quantity', 'unit', 'by_user', 'notes', 'date'],
  rutas:     ['id', 'date', 'hora', 'origen', 'destino', 'conductor', 'descripcion', 'status', 'updated_by', 'updated_at', 'created_at'],
  messages:  ['id', 'user_id', 'content', 'created_at']
};

// ── Secreto JWT: del entorno, o generado y persistido en la DB ──
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('jwt_secret');
  if (row) {
    JWT_SECRET = row.value;
  } else {
    JWT_SECRET = crypto.randomBytes(48).toString('hex');
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('jwt_secret', JWT_SECRET);
  }
}

// ============================================================
// DATOS INICIALES (equivalente al seed del schema SQL)
// Solo corre si la tabla projects está vacía.
// ============================================================
function seedDefaults() {
  const now = new Date().toISOString();

  const projects = [
    ['bodega',          'PATIO (Base Central)', 'Almacen principal - Base CMI',  'GABRIEL', '#9B1B30'],
    ['pedro_miguel',    'Pedro Miguel',         'ACP - Pedro Miguel',            'PINO',    '#C62040'],
    ['gamboa',          'Gamboa',               'ACP - Gamboa',                  'PINO',    '#7A1526'],
    ['corozal',         'Corozal',              'ACP - Corozal',                 'MARTA',   '#C8960C'],
    ['monte_esperanza', 'Monte Esperanza',      'ACP - Monte Esperanza (Colon)', 'GABRIEL', '#1D4ED8'],
    ['maquinarias',     'Maquinarias',          'PATIO - Area de Maquinarias',   'GABRIEL', '#0F766E'],
    ['miraflores',      'Miraflores',           'ACP - Miraflores',              'PINO',    '#4338CA'],
    ['finca',           'Finca',                'Finca CMI',                     'GABRIEL', '#BE185D'],
    ['balboa',          'Balboa',               'ACP - Balboa',                  'MARTA',   '#065F46'],
    ['cercas_gatun',    'Cercas Gatun',         'ACP - Gatun',                   'PINO',    '#7C3AED'],
    ['potabilizadora',  'Potabilizadora',       'ACP - Potabilizadora',          'GABRIEL', '#B45309']
  ];
  const insP = db.prepare(
    'INSERT INTO projects (id, name, address, supervisor, color, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
  );
  tx(() => {
    projects.forEach(p => insP.run(p[0], p[1], p[2], p[3], p[4], 'active', now, now));
  });

  const rutas = [
    ['2026-10-12', '07:30', 'bodega', 'bodega',          'Gabriel / Martin', 'Mantenimiento Megapolis GC'],
    ['2026-10-12', '08:00', 'bodega', 'balboa',          'Gabriel / Martin', 'COHCEZ Material - ACP Balboa MC'],
    ['2026-10-12', '09:00', 'balboa', 'balboa',          'Gabriel / Martin', 'ACP Balboa Entrega MC'],
    ['2026-10-13', '07:30', 'bodega', 'bodega',          'Gabriel / Martin', 'Mantenimiento Atrio Mall GC'],
    ['2026-10-13', '08:00', 'bodega', 'balboa',          'Gabriel / Martin', 'ACP Balboa MC'],
    ['2026-10-13', '09:30', 'bodega', 'bodega',          'Gabriel / Martin', 'Compras Discovery'],
    ['2026-10-13', '11:00', 'bodega', 'bodega',          'Gabriel / Martin', 'PPG Panama Pacifico MC'],
    ['2026-10-13', '13:00', 'bodega', 'miraflores',      'Gabriel / Martin', 'Miraflores ACP MC'],
    ['2026-10-14', '07:30', 'bodega', 'monte_esperanza', 'Gabriel / Martin', 'ACP Colon - Monte Esperanza MC'],
    ['2026-10-14', '09:00', 'bodega', 'miraflores',      'Gabriel / Martin', 'Miraflores ACP MC'],
    ['2026-10-15', '07:30', 'bodega', 'bodega',          'Gabriel / Martin', 'ACP Colon - Caseta NC'],
    ['2026-10-17', '14:00', 'bodega', 'bodega',          'Gabriel / Martin', 'Mantenimiento del Camion y PATIO']
  ];
  const insR = db.prepare(
    'INSERT INTO rutas (id, date, hora, origen, destino, conductor, descripcion, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  );
  tx(() => {
    rutas.forEach(r => insR.run(crypto.randomUUID(), r[0], r[1], r[2], r[3], r[4], r[5], 'pendiente', now, now));
  });

  console.log('Seed inicial cargado: proyectos y rutas (datos de ejemplo).');
}

// Importa datos exportados de Supabase (import.json) en el primer arranque.
function importData(file) {
  const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sets = ['profiles', 'projects', 'items', 'transfers', 'rutas'];
  let total = 0;
  tx(() => {
    for (const table of sets) {
      const rows = dump[table] || [];
      const allowed = SCHEMA[table];
      for (const raw of rows) {
        const v = {};
        for (const k of Object.keys(raw)) if (allowed.includes(k)) v[k] = raw[k];
        if (!v.id) continue;
        const keys = Object.keys(v);
        const sql = `INSERT OR REPLACE INTO "${table}" (${keys.map(k => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
        db.prepare(sql).run(...keys.map(k => v[k]));
        total++;
      }
    }
  });
  const profs = (dump.profiles || []).length;
  console.log(`Importados ${total} registros desde ${path.basename(file)} (${profs} perfiles sin login — se enganchan al registrarse con su email).`);
}

// Arranque: si la base está vacía, importa import.json o siembra ejemplos.
function bootstrap() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
  if (count > 0) return;
  const importPath = process.env.IMPORT_PATH || path.join(__dirname, 'import.json');
  if (fs.existsSync(importPath)) importData(importPath);
  else seedDefaults();
}
bootstrap();

// ============================================================
// REALTIME (Server-Sent Events)
// ============================================================
const sseClients = new Set();

function broadcast(evt) {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch (e) { /* cliente caído */ }
  }
}

app.get('/api/realtime', (req, res) => {
  const user = userFromToken(req.query.token);
  if (!user) return res.status(401).end();
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write(':ok\n\n');
  sseClients.add(res);
  const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch (e) {} }, 25000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
});

// ============================================================
// AUTENTICACIÓN
// ============================================================
function userFromToken(token) {
  if (!token) return null;
  let decoded;
  try { decoded = jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
  return db.prepare('SELECT id, email, name, role, status FROM profiles WHERE id = ?').get(decoded.sub) || null;
}

function getUser(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  const token = m ? m[1] : (req.query.token || null);
  return userFromToken(token);
}

app.post('/api/auth/signup', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.json({ error: { message: 'Email y contraseña requeridos' } });
  if (String(password).length < 6) return res.json({ error: { message: 'La contraseña debe tener al menos 6 caracteres' } });
  const em = String(email).trim().toLowerCase();
  const exists = db.prepare('SELECT id FROM auth_users WHERE email = ?').get(em);
  if (exists) return res.json({ error: { message: 'User already registered' } });

  const now = new Date().toISOString();
  const hash = bcrypt.hashSync(String(password), 10);

  // ¿Hay un perfil migrado con este email y todavía sin login? -> lo reclama,
  // conservando su id original (y con él, su rol, estado e historial).
  const migrated = db.prepare(
    'SELECT id FROM profiles WHERE lower(email) = ? AND id NOT IN (SELECT id FROM auth_users)'
  ).get(em);
  if (migrated) {
    db.prepare('INSERT INTO auth_users (id, email, password_hash) VALUES (?,?,?)').run(migrated.id, em, hash);
    return res.json({ data: { id: migrated.id, claimed: true }, error: null });
  }

  const count = db.prepare('SELECT COUNT(*) AS c FROM profiles').get().c;
  const id = crypto.randomUUID();
  // El primer usuario registrado queda como admin activo; el resto, pendiente de aprobación.
  const role = count === 0 ? 'admin' : 'engineer';
  const status = count === 0 ? 'active' : 'pending';
  const name = em.split('@')[0];

  tx(() => {
    db.prepare('INSERT INTO auth_users (id, email, password_hash) VALUES (?,?,?)').run(id, em, hash);
    db.prepare('INSERT INTO profiles (id, email, name, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, em, name, role, status, now, now);
  });
  res.json({ data: { id }, error: null });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  const u = db.prepare('SELECT * FROM auth_users WHERE email = ?').get(em);
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) {
    return res.json({ error: { message: 'Invalid login credentials' } });
  }
  const token = jwt.sign({ sub: u.id, email: u.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: u.id, email: u.email }, error: null });
});

app.post('/api/auth/me', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: { message: 'No autenticado' } });
  res.json({ user: { id: u.id, email: u.email }, error: null });
});

app.post('/api/auth/logout', (req, res) => res.json({ ok: true }));

// ============================================================
// PERMISOS DE ESCRITURA (equivalente a las políticas RLS)
// ============================================================
function canWrite(table, op, user, values, filters) {
  switch (table) {
    case 'projects':
      return user.role === 'admin';
    case 'rutas':
      return op === 'update' ? true : user.role === 'admin'; // status: cualquiera; alta/baja: admin
    case 'items':
      return true;
    case 'transfers':
      return op === 'insert';
    case 'messages':
      return op === 'insert';
    case 'profiles': {
      if (op !== 'update') return false;
      const keys = Object.keys(values || {});
      const touchesPriv = keys.includes('role') || keys.includes('status');
      if (touchesPriv) return user.role === 'admin';
      const idf = (filters || []).find(f => f.col === 'id');
      return user.role === 'admin' || (idf && idf.val === user.id); // nombre propio
    }
    default:
      return false;
  }
}

// ============================================================
// DATA API (select / insert / update / delete)
// ============================================================
function runSelect(table, { columns, filters, order, limit, single }) {
  const allowed = SCHEMA[table];
  let cols = '*';
  if (Array.isArray(columns) && columns.length) {
    const c = columns.filter(x => allowed.includes(x));
    cols = c.length ? c.map(q => `"${q}"`).join(',') : '*';
  }
  const where = [], params = [];
  (filters || []).forEach(f => {
    if (allowed.includes(f.col)) { where.push(`"${f.col}" = ?`); params.push(f.val); }
  });
  let sql = `SELECT ${cols} FROM "${table}"`;
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  const ords = (order || []).filter(o => allowed.includes(o.col)).map(o => `"${o.col}" ${o.asc ? 'ASC' : 'DESC'}`);
  if (ords.length) sql += ' ORDER BY ' + ords.join(', ');
  if (Number.isInteger(limit) && limit > 0) sql += ` LIMIT ${limit}`;
  const rows = db.prepare(sql).all(...params);
  return single ? (rows[0] || null) : rows;
}

function cleanValues(table, values, user) {
  const allowed = SCHEMA[table];
  const v = {};
  for (const k of Object.keys(values || {})) if (allowed.includes(k)) v[k] = values[k];
  // Integridad: el autor siempre es el usuario autenticado, no lo que mande el cliente.
  if (allowed.includes('updated_by')) v.updated_by = user.id;
  if (table === 'messages') v.user_id = user.id;
  if (table === 'transfers') v.by_user = user.id;
  return v;
}

function doInsert(table, values, user) {
  const allowed = SCHEMA[table];
  const v = cleanValues(table, values, user);
  if (!v.id) {
    if (table === 'projects') throw { message: 'Falta el id del proyecto' };
    v.id = crypto.randomUUID();
  }
  const now = new Date().toISOString();
  if (allowed.includes('created_at') && !v.created_at) v.created_at = now;
  if (allowed.includes('updated_at')) v.updated_at = now;
  if (table === 'transfers' && !v.date) v.date = now;

  const keys = Object.keys(v);
  const sql = `INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  db.prepare(sql).run(...keys.map(k => v[k]));
  const row = db.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(v.id);
  broadcast({ table, eventType: 'INSERT', new: row, old: null });
  return row;
}

function doUpdate(table, values, filters, user) {
  const allowed = SCHEMA[table];
  const v = cleanValues(table, values, user);
  if (allowed.includes('updated_at')) v.updated_at = new Date().toISOString();
  const setKeys = Object.keys(v);
  if (!setKeys.length) return [];

  const where = [], params = [];
  (filters || []).forEach(f => {
    if (allowed.includes(f.col)) { where.push(`"${f.col}" = ?`); params.push(f.val); }
  });
  if (!where.length) throw { message: 'Un update requiere un filtro' };

  const sql = `UPDATE "${table}" SET ${setKeys.map(k => `"${k}" = ?`).join(',')} WHERE ${where.join(' AND ')}`;
  db.prepare(sql).run(...setKeys.map(k => v[k]), ...params);
  const rows = db.prepare(`SELECT * FROM "${table}" WHERE ${where.join(' AND ')}`).all(...params);
  rows.forEach(r => broadcast({ table, eventType: 'UPDATE', new: r, old: null }));
  return rows;
}

function doDelete(table, filters) {
  const allowed = SCHEMA[table];
  const where = [], params = [];
  (filters || []).forEach(f => {
    if (allowed.includes(f.col)) { where.push(`"${f.col}" = ?`); params.push(f.val); }
  });
  if (!where.length) throw { message: 'Un delete requiere un filtro' };
  const rows = db.prepare(`SELECT * FROM "${table}" WHERE ${where.join(' AND ')}`).all(...params);
  db.prepare(`DELETE FROM "${table}" WHERE ${where.join(' AND ')}`).run(...params);
  rows.forEach(r => broadcast({ table, eventType: 'DELETE', new: null, old: r }));
  return rows.length;
}

app.post('/api/select', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ data: null, error: { message: 'No autenticado' } });
  const { table } = req.body || {};
  if (!SCHEMA[table]) return res.json({ data: null, error: { message: 'Tabla inválida' } });
  try { res.json({ data: runSelect(table, req.body), error: null }); }
  catch (e) { res.json({ data: null, error: { message: e.message } }); }
});

app.post('/api/insert', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ data: null, error: { message: 'No autenticado' } });
  if (u.status !== 'active') return res.status(403).json({ data: null, error: { message: 'Cuenta no activa' } });
  const { table, values } = req.body || {};
  if (!SCHEMA[table]) return res.json({ data: null, error: { message: 'Tabla inválida' } });
  if (!canWrite(table, 'insert', u, values, [])) return res.status(403).json({ data: null, error: { message: 'No autorizado' } });
  try { res.json({ data: [doInsert(table, values, u)], error: null }); }
  catch (e) { res.json({ data: null, error: { message: e.message } }); }
});

app.post('/api/update', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ data: null, error: { message: 'No autenticado' } });
  if (u.status !== 'active') return res.status(403).json({ data: null, error: { message: 'Cuenta no activa' } });
  const { table, values, filters } = req.body || {};
  if (!SCHEMA[table]) return res.json({ data: null, error: { message: 'Tabla inválida' } });
  if (!canWrite(table, 'update', u, values, filters)) return res.status(403).json({ data: null, error: { message: 'No autorizado' } });
  try { res.json({ data: doUpdate(table, values, filters, u), error: null }); }
  catch (e) { res.json({ data: null, error: { message: e.message } }); }
});

app.post('/api/delete', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ data: null, error: { message: 'No autenticado' } });
  if (u.status !== 'active') return res.status(403).json({ data: null, error: { message: 'Cuenta no activa' } });
  const { table, filters } = req.body || {};
  if (!SCHEMA[table]) return res.json({ data: null, error: { message: 'Tabla inválida' } });
  if (!canWrite(table, 'delete', u, null, filters)) return res.status(403).json({ data: null, error: { message: 'No autorizado' } });
  try { res.json({ data: null, count: doDelete(table, filters), error: null }); }
  catch (e) { res.json({ data: null, error: { message: e.message } }); }
});

// ============================================================
// EMAILS (Resend) — sin cambios respecto a la versión previa
// ============================================================
app.post('/api/send-ruta', async (req, res) => {
  const { to, conductor, fecha, hora, origen, destino, descripcion } = req.body;
  if (!to || !descripcion) return res.status(400).json({ error: 'Faltan datos' });

  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return res.status(500).json({ error: 'Sin API key configurada' });

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:#9B1B30;padding:24px 28px;border-radius:12px 12px 0 0">
        <div style="color:#fff;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;opacity:.7">CMI Construction Corp</div>
        <div style="color:#fff;font-size:22px;font-weight:700;margin-top:4px">Ruta Asignada</div>
      </div>
      <div style="background:#fff;border:1px solid #E2E1DE;border-top:none;padding:28px;border-radius:0 0 12px 12px">
        <div style="font-size:15px;color:#1B1B20;margin-bottom:20px">Hola <strong>${conductor}</strong>, tienes una ruta asignada:</div>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:10px 14px;background:#F0EEE9;border-radius:8px 8px 0 0;font-size:11px;font-weight:700;color:#6B6B78;text-transform:uppercase;letter-spacing:.07em">Descripción</td></tr>
          <tr><td style="padding:10px 14px;background:#FDF0F2;font-size:15px;font-weight:600;color:#9B1B30;border-radius:0 0 8px 8px;margin-bottom:12px">${descripcion}</td></tr>
        </table>
        <div style="height:12px"></div>
        <table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden">
          ${hora ? `<tr><td style="padding:10px 14px;background:#F0EEE9;font-size:12px;color:#6B6B78;font-weight:600;width:120px">Hora</td><td style="padding:10px 14px;background:#F0EEE9;font-size:13px;color:#1B1B20;font-weight:700">${hora} hrs</td></tr>` : ''}
          ${fecha ? `<tr><td style="padding:10px 14px;background:#fff;font-size:12px;color:#6B6B78;font-weight:600">Fecha</td><td style="padding:10px 14px;background:#fff;font-size:13px;color:#1B1B20">${fecha}</td></tr>` : ''}
          ${origen ? `<tr><td style="padding:10px 14px;background:#F0EEE9;font-size:12px;color:#6B6B78;font-weight:600">Origen</td><td style="padding:10px 14px;background:#F0EEE9;font-size:13px;color:#1B1B20">${origen}</td></tr>` : ''}
          ${destino ? `<tr><td style="padding:10px 14px;background:#fff;font-size:12px;color:#6B6B78;font-weight:600">Destino</td><td style="padding:10px 14px;background:#fff;font-size:13px;color:#1B1B20">${destino}</td></tr>` : ''}
        </table>
        <div style="margin-top:24px;padding:14px;background:#FEF08A;border-radius:8px;border-left:3px solid #EAB308;font-size:12px;color:#854D0E">
          Estado inicial: <strong>PENDIENTE</strong> — recuerda actualizar el estado al iniciar y completar la ruta.
        </div>
        <div style="margin-top:24px;font-size:11px;color:#6B6B78;text-align:center">ObraControl CMI · Sistema de Inventario y Logística</div>
      </div>
    </div>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'ObraControl CMI <onboarding@resend.dev>',
        to: [to],
        subject: `🚛 Ruta asignada: ${descripcion}`,
        html
      })
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(400).json(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/send-report', async (req, res) => {
  const { to, fecha, totalItems, totalProjects, lowStock = [], noOp = [], summary = [] } = req.body;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return res.status(500).json({ error: 'Sin API key' });

  const sumRows = summary.map(p => `<tr><td style="padding:8px 14px;border-bottom:1px solid #E2E1DE;font-size:13px;color:#1B1B20">${p.name}</td><td style="padding:8px 14px;border-bottom:1px solid #E2E1DE;font-size:13px;font-weight:700;color:#1B1B20;text-align:right">${p.count}</td></tr>`).join('');
  const lowRows = lowStock.length === 0
    ? '<p style="color:#6B6B78;font-size:13px;padding:8px 0">Sin alertas de stock bajo ✓</p>'
    : lowStock.map(i => `<div style="padding:6px 0;border-bottom:1px solid #F0EEE9;font-size:13px;color:#1B1B20"><b>${i.name}</b> — <span style="color:#D97706">Qty: ${i.quantity} / Mín: ${i.minStock}</span></div>`).join('');
  const noOpRows = noOp.length === 0
    ? '<p style="color:#6B6B78;font-size:13px;padding:8px 0">Sin equipos no operativos ✓</p>'
    : noOp.map(i => `<div style="padding:6px 0;border-bottom:1px solid #F0EEE9;font-size:13px;color:#DC2626"><b>${i.name}</b></div>`).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#9B1B30;padding:24px 28px;border-radius:12px 12px 0 0">
        <div style="color:#fff;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;opacity:.7">CMI Construction Corp</div>
        <div style="color:#fff;font-size:22px;font-weight:700;margin-top:4px">Reporte de Inventario</div>
        <div style="color:#fff;font-size:13px;opacity:.8;margin-top:4px">${fecha}</div>
      </div>
      <div style="background:#fff;border:1px solid #E2E1DE;border-top:none;padding:28px;border-radius:0 0 12px 12px">
        <div style="display:flex;gap:16px;margin-bottom:24px">
          <div style="flex:1;background:#F0EEE9;border-radius:10px;padding:14px;text-align:center">
            <div style="font-size:28px;font-weight:700;color:#9B1B30">${totalItems}</div>
            <div style="font-size:11px;color:#6B6B78;font-weight:600;text-transform:uppercase">Artículos</div>
          </div>
          <div style="flex:1;background:#F0EEE9;border-radius:10px;padding:14px;text-align:center">
            <div style="font-size:28px;font-weight:700;color:#1D4ED8">${totalProjects}</div>
            <div style="font-size:11px;color:#6B6B78;font-weight:600;text-transform:uppercase">Proyectos</div>
          </div>
          <div style="flex:1;background:${lowStock.length > 0 ? '#FEF3C7' : '#F0EEE9'};border-radius:10px;padding:14px;text-align:center">
            <div style="font-size:28px;font-weight:700;color:${lowStock.length > 0 ? '#D97706' : '#166534'}">${lowStock.length}</div>
            <div style="font-size:11px;color:#6B6B78;font-weight:600;text-transform:uppercase">Stock Bajo</div>
          </div>
        </div>
        <h3 style="font-size:14px;font-weight:700;color:#1B1B20;margin:0 0 10px">Artículos por Proyecto</h3>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">${sumRows}</table>
        <h3 style="font-size:14px;font-weight:700;color:#D97706;margin:0 0 10px">⚠ Stock Bajo</h3>
        <div style="margin-bottom:20px">${lowRows}</div>
        <h3 style="font-size:14px;font-weight:700;color:#DC2626;margin:0 0 10px">🔴 No Operativos</h3>
        <div>${noOpRows}</div>
        <div style="margin-top:28px;font-size:11px;color:#6B6B78;text-align:center">ObraControl CMI · Reporte generado automáticamente</div>
      </div>
    </div>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'ObraControl CMI <onboarding@resend.dev>', to: [to], subject: `📊 Reporte de Inventario CMI — ${fecha}`, html })
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(400).json(data);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ESTÁTICOS + SPA
// ============================================================
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CMI Logistica (SQLite, autónomo) corriendo en el puerto ${PORT}`);
  console.log(`Base de datos: ${DB_PATH}`);
});
