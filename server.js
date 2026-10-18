const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Remitente de los correos. Por defecto usa el dominio de prueba de Resend
// (solo entrega al dueño de la cuenta). Cuando verifiques un dominio propio
// en Resend, basta con definir MAIL_FROM en Railway, sin tocar el codigo.
// Ej: MAIL_FROM="ObraControl CMI <no-reply@cmipanama.com>"
const MAIL_FROM = process.env.MAIL_FROM || 'ObraControl CMI <onboarding@resend.dev>';

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
  photo_id   TEXT,
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
  project_id TEXT,
  created_at TEXT
);

-- ── Archivos subidos (comprobantes, documentos de licitación, piezas) ──
CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  mime        TEXT,
  size        INTEGER,
  path        TEXT,
  scope       TEXT,
  ref_id      TEXT,
  uploaded_by TEXT,
  uploaded_at TEXT
);

-- ── Contabilidad (partida doble) ──
CREATE TABLE IF NOT EXISTS cuentas (
  id         TEXT PRIMARY KEY,
  codigo     TEXT,
  nombre     TEXT NOT NULL,
  tipo       TEXT NOT NULL,            -- activo|pasivo|patrimonio|ingreso|gasto
  parent_id  TEXT,
  activa     INTEGER DEFAULT 1,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS asientos (
  id               TEXT PRIMARY KEY,
  fecha            TEXT NOT NULL,
  descripcion      TEXT,
  referencia       TEXT,
  estado           TEXT DEFAULT 'confirmado',
  comprobante_file TEXT,
  created_by       TEXT,
  created_at       TEXT,
  updated_at       TEXT
);
CREATE TABLE IF NOT EXISTS movimientos (
  id          TEXT PRIMARY KEY,
  asiento_id  TEXT NOT NULL,
  cuenta_id   TEXT NOT NULL,
  debe        REAL DEFAULT 0,
  haber       REAL DEFAULT 0,
  proyecto_id TEXT,
  descripcion TEXT
);

-- ── Licitaciones ──
CREATE TABLE IF NOT EXISTS licitaciones (
  id                TEXT PRIMARY KEY,
  titulo            TEXT NOT NULL,
  entidad           TEXT,
  numero            TEXT,
  fecha_publicacion TEXT,
  fecha_limite      TEXT,
  monto_estimado    REAL,
  moneda            TEXT DEFAULT 'USD',
  estado            TEXT DEFAULT 'borrador',  -- borrador|en_revision|aprobada|rechazada|presentada|adjudicada|perdida
  responsable       TEXT,
  notas             TEXT,
  aprobado_por      TEXT,
  aprobado_at       TEXT,
  created_by        TEXT,
  created_at        TEXT,
  updated_at        TEXT
);

-- ── Mercadeo ──
CREATE TABLE IF NOT EXISTS campanas (
  id            TEXT PRIMARY KEY,
  nombre        TEXT NOT NULL,
  descripcion   TEXT,
  estado        TEXT DEFAULT 'activa',    -- activa|pausada|finalizada
  fecha_inicio  TEXT,
  fecha_fin     TEXT,
  responsable   TEXT,
  created_by    TEXT,
  created_at    TEXT,
  updated_at    TEXT
);
CREATE TABLE IF NOT EXISTS publicaciones (
  id          TEXT PRIMARY KEY,
  campana_id  TEXT,
  fecha       TEXT,
  canal       TEXT,
  contenido   TEXT,
  estado      TEXT DEFAULT 'planificada', -- planificada|publicada
  created_by  TEXT,
  created_at  TEXT,
  updated_at  TEXT
);
CREATE TABLE IF NOT EXISTS mercadeo_tareas (
  id          TEXT PRIMARY KEY,
  titulo      TEXT NOT NULL,
  descripcion TEXT,
  responsable TEXT,
  prioridad   TEXT DEFAULT 'media',       -- baja|media|alta
  estado      TEXT DEFAULT 'pendiente',   -- pendiente|en_progreso|hecho
  created_by  TEXT,
  created_at  TEXT,
  updated_at  TEXT
);

-- Vales de Salida / Entrada de equipos y herramientas (formato CMI)
CREATE TABLE IF NOT EXISTS equipo_movs (
  id              TEXT PRIMARY KEY,
  tipo            TEXT,            -- salida | entrada
  numero          TEXT,
  fecha           TEXT,
  proyecto_motivo TEXT,
  placa           TEXT,
  responsable     TEXT,
  cedula          TEXT,
  cargo           TEXT,
  tel             TEXT,
  sitio           TEXT,
  supervisor      TEXT,
  fecha_mov       TEXT,
  fecha_ret       TEXT,
  condicion       TEXT,
  observaciones   TEXT,
  firma_sol       TEXT,
  firma_aut       TEXT,
  firma_sup       TEXT,
  items           TEXT,            -- JSON con las líneas de equipos
  created_by      TEXT,
  created_at      TEXT,
  updated_at      TEXT
);

-- Tokens de recuperación de contraseña (autoservicio por email)
CREATE TABLE IF NOT EXISTS password_resets (
  token   TEXT PRIMARY KEY,
  user_id TEXT,
  expires INTEGER
);
`);

// Migraciones ligeras: agrega columnas que falten en bases ya creadas.
function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
ensureColumn('messages', 'project_id', 'TEXT');
ensureColumn('messages', 'room', 'TEXT');
ensureColumn('messages', 'file_id', 'TEXT');
ensureColumn('items', 'photo_id', 'TEXT');
ensureColumn('equipo_movs', 'origen_id', 'TEXT');
ensureColumn('equipo_movs', 'destino_id', 'TEXT');
// Backfill idempotente: mensajes previos quedan en su sala correcta.
db.exec("UPDATE messages SET room = 'proyecto:' || project_id WHERE room IS NULL AND project_id IS NOT NULL");
db.exec("UPDATE messages SET room = 'general' WHERE room IS NULL");

// Columnas permitidas por tabla (whitelist anti-inyección e integridad)
const SCHEMA = {
  profiles:  ['id', 'email', 'name', 'role', 'status', 'created_at', 'updated_at'],
  projects:  ['id', 'name', 'address', 'supervisor', 'engineer_id', 'color', 'status', 'notes', 'created_at', 'updated_at'],
  items:     ['id', 'name', 'category', 'unit', 'quantity', 'min_stock', 'estado', 'notes', 'photo_id', 'project_id', 'updated_by', 'updated_at', 'created_at'],
  transfers: ['id', 'item_name', 'from_project', 'to_project', 'quantity', 'unit', 'by_user', 'notes', 'date'],
  equipo_movs: ['id', 'tipo', 'numero', 'fecha', 'proyecto_motivo', 'placa', 'responsable', 'cedula', 'cargo', 'tel', 'sitio', 'supervisor', 'fecha_mov', 'fecha_ret', 'condicion', 'observaciones', 'firma_sol', 'firma_aut', 'firma_sup', 'items', 'origen_id', 'destino_id', 'created_by', 'created_at', 'updated_at'],
  rutas:     ['id', 'date', 'hora', 'origen', 'destino', 'conductor', 'descripcion', 'status', 'updated_by', 'updated_at', 'created_at'],
  messages:  ['id', 'user_id', 'content', 'project_id', 'room', 'file_id', 'created_at'],
  files:        ['id', 'name', 'mime', 'size', 'path', 'scope', 'ref_id', 'uploaded_by', 'uploaded_at'],
  cuentas:      ['id', 'codigo', 'nombre', 'tipo', 'parent_id', 'activa', 'created_at'],
  asientos:     ['id', 'fecha', 'descripcion', 'referencia', 'estado', 'comprobante_file', 'created_by', 'created_at', 'updated_at'],
  movimientos:  ['id', 'asiento_id', 'cuenta_id', 'debe', 'haber', 'proyecto_id', 'descripcion'],
  licitaciones: ['id', 'titulo', 'entidad', 'numero', 'fecha_publicacion', 'fecha_limite', 'monto_estimado', 'moneda', 'estado', 'responsable', 'notas', 'aprobado_por', 'aprobado_at', 'created_by', 'created_at', 'updated_at'],
  campanas:     ['id', 'nombre', 'descripcion', 'estado', 'fecha_inicio', 'fecha_fin', 'responsable', 'created_by', 'created_at', 'updated_at'],
  publicaciones:['id', 'campana_id', 'fecha', 'canal', 'contenido', 'estado', 'created_by', 'created_at', 'updated_at'],
  mercadeo_tareas:['id', 'titulo', 'descripcion', 'responsable', 'prioridad', 'estado', 'created_by', 'created_at', 'updated_at']
};

// ── Control de acceso por módulo (lectura y escritura) ──
// Qué roles pueden ver/usar cada módulo sensible. admin ve todo.
const MODULE_ROLES = {
  conta: ['admin', 'contador'],
  licit: ['admin', 'licitaciones'],  // rol propio; el supervisor solo opera logística
  mkt:   ['admin', 'mercadeo']
};
const TABLE_MODULE = {
  cuentas: 'conta', asientos: 'conta', movimientos: 'conta',
  licitaciones: 'licit',
  campanas: 'mkt', publicaciones: 'mkt', mercadeo_tareas: 'mkt'
};
const SCOPE_MODULE = { asiento: 'conta', licitacion: 'licit', campana: 'mkt' };
// Salas de chat restringidas (heredan el permiso del módulo). Las demás
// (general, inventario, rutas, proyecto:*) son abiertas a todo usuario activo.
const CHAT_ROOM_MODULE = { contabilidad: 'conta', licitaciones: 'licit', mercadeo: 'mkt' };
function chatRoomModule(room) { return CHAT_ROOM_MODULE[room] || null; }
// Módulo que protege un archivo: por scope del documento, o —para fotos de
// chat (scope 'chat')— por la sala del chat, que viaja en ref_id.
function fileModule(scope, refId) {
  if (scope === 'chat') return chatRoomModule(refId);
  return SCOPE_MODULE[scope] || null;
}

function roleCan(module, user) {
  if (!module) return true;               // tabla no restringida
  const roles = MODULE_ROLES[module];
  return roles ? roles.includes(user.role) : false;
}

// Módulo al que pertenece una petición (según tabla y, para files, según scope).
function moduleFor(table, reqBody) {
  if (table === 'files') {
    const scope = (reqBody && reqBody.values && reqBody.values.scope)
      || (reqBody && reqBody.filters || []).find?.(f => f.col === 'scope')?.val
      || (reqBody && reqBody.scope);
    return SCOPE_MODULE[scope] || null;   // files sin scope reconocido: sin módulo restringido
  }
  if (table === 'messages') {
    const rf = ((reqBody && reqBody.filters) || []).find(f => f.col === 'room');
    return chatRoomModule(rf && rf.val);  // sala de chat → módulo (o null si abierta)
  }
  return TABLE_MODULE[table] || null;
}

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

// Plan de cuentas base (contabilidad). Se siembra si la tabla está vacía.
function seedCuentas() {
  const c = db.prepare('SELECT COUNT(*) AS c FROM cuentas').get().c;
  if (c > 0) return;
  const now = new Date().toISOString();
  const cuentas = [
    ['1',    'Activo',                 'activo'],
    ['1101', 'Caja',                   'activo'],
    ['1102', 'Bancos',                 'activo'],
    ['1103', 'Cuentas por cobrar',     'activo'],
    ['1104', 'Inventario',             'activo'],
    ['1201', 'Maquinaria y equipo',    'activo'],
    ['1202', 'Vehículos',              'activo'],
    ['2',    'Pasivo',                 'pasivo'],
    ['2101', 'Cuentas por pagar',      'pasivo'],
    ['2102', 'Impuestos por pagar',    'pasivo'],
    ['2201', 'Préstamos bancarios',    'pasivo'],
    ['3',    'Patrimonio',             'patrimonio'],
    ['3101', 'Capital',                'patrimonio'],
    ['3102', 'Utilidades retenidas',   'patrimonio'],
    ['4',    'Ingresos',               'ingreso'],
    ['4101', 'Ingresos por obra',      'ingreso'],
    ['4102', 'Otros ingresos',         'ingreso'],
    ['5',    'Costos y gastos',        'gasto'],
    ['5101', 'Costo de obra',          'gasto'],
    ['5102', 'Mano de obra',           'gasto'],
    ['5103', 'Materiales',             'gasto'],
    ['5104', 'Gastos administrativos', 'gasto'],
    ['5105', 'Gastos de ventas',       'gasto']
  ];
  const ins = db.prepare('INSERT INTO cuentas (id,codigo,nombre,tipo,activa,created_at) VALUES (?,?,?,?,1,?)');
  tx(() => { cuentas.forEach(x => ins.run(crypto.randomUUID(), x[0], x[1], x[2], now)); });
  console.log('Plan de cuentas base sembrado.');
}

// Arranque: si la base está vacía, importa import.json o siembra ejemplos.
function bootstrap() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
  if (count === 0) {
    const importPath = process.env.IMPORT_PATH || path.join(__dirname, 'import.json');
    if (fs.existsSync(importPath)) importData(importPath);
    else seedDefaults();
  }
  seedCuentas(); // contabilidad es módulo nuevo: sembrar plan base si falta
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
    'SELECT id FROM profiles WHERE lower(trim(email)) = ? AND id NOT IN (SELECT id FROM auth_users)'
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

// Autoservicio: el usuario pide un enlace para recuperar su contraseña.
app.post('/api/auth/forgot', async (req, res) => {
  const em = String((req.body && req.body.email) || '').trim().toLowerCase();
  const u = em && db.prepare('SELECT * FROM auth_users WHERE lower(trim(email)) = ?').get(em);
  if (u) {
    const token = crypto.randomBytes(24).toString('hex');
    const expires = Date.now() + 3600 * 1000; // 1 hora
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(u.id);
    db.prepare('INSERT INTO password_resets (token, user_id, expires) VALUES (?,?,?)').run(token, u.id, expires);
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const link = `${proto}://${req.get('host')}/?reset=${token}`;
    const KEY = process.env.RESEND_API_KEY;
    if (KEY) {
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
          <div style="background:#9B1B30;padding:20px 24px;border-radius:12px 12px 0 0">
            <div style="color:#fff;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;opacity:.75">CMI Construction Corp</div>
            <div style="color:#fff;font-size:20px;font-weight:700;margin-top:4px">Recuperar contraseña</div>
          </div>
          <div style="background:#fff;border:1px solid #E2E1DE;border-top:none;padding:24px;border-radius:0 0 12px 12px;color:#1B1B20;font-size:14px;line-height:1.6">
            <p>Recibimos una solicitud para restablecer tu contraseña. El enlace es válido por 1 hora:</p>
            <p style="text-align:center;margin:24px 0"><a href="${link}" style="background:#9B1B30;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;display:inline-block">Definir nueva contraseña</a></p>
            <p style="font-size:12px;color:#6B6B78">Si el botón no funciona, copiá este enlace: <br>${link}</p>
            <p style="font-size:12px;color:#6B6B78">Si no fuiste vos, ignorá este correo.</p>
          </div>
        </div>`;
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: MAIL_FROM, to: [u.email], subject: 'Recuperar contraseña — ObraControl CMI', html })
        });
      } catch (e) { /* el correo puede fallar; no revelamos nada */ }
    }
  }
  res.json({ ok: true }); // respuesta neutra: no revela si el email existe
});

// Define la nueva contraseña a partir de un token válido.
app.post('/api/auth/reset', (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.json({ error: { message: 'Datos incompletos' } });
  if (String(password).length < 6) return res.json({ error: { message: 'La contraseña debe tener al menos 6 caracteres' } });
  const row = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(token);
  if (!row || row.expires < Date.now()) {
    if (row) db.prepare('DELETE FROM password_resets WHERE token = ?').run(token);
    return res.json({ error: { message: 'El enlace venció o no es válido. Pedí uno nuevo.' } });
  }
  const hash = bcrypt.hashSync(String(password), 10);
  db.prepare('UPDATE auth_users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
  db.prepare('DELETE FROM password_resets WHERE token = ?').run(token);
  res.json({ ok: true });
});

// Admin fija/resetea la contraseña de un usuario (p. ej. usuarios migrados que
// no lograron "engancharse"). Deja el login listo, limpia duplicados y activa.
app.post('/api/admin/set-password', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: { message: 'No autenticado' } });
  if (u.role !== 'admin') return res.status(403).json({ error: { message: 'Solo admin' } });
  const { userId, password } = req.body || {};
  if (!userId || !password) return res.json({ error: { message: 'Falta usuario o contraseña' } });
  if (String(password).length < 6) return res.json({ error: { message: 'La contraseña debe tener al menos 6 caracteres' } });
  const prof = db.prepare('SELECT * FROM profiles WHERE id = ?').get(userId);
  if (!prof) return res.json({ error: { message: 'Usuario no encontrado' } });
  const email = String(prof.email || '').trim().toLowerCase();
  if (!email) return res.json({ error: { message: 'El usuario no tiene email registrado' } });
  const hash = bcrypt.hashSync(String(password), 10);
  tx(() => {
    db.prepare('DELETE FROM auth_users WHERE lower(trim(email)) = ?').run(email);        // limpia logins previos con ese email
    db.prepare('DELETE FROM profiles WHERE lower(trim(email)) = ? AND id != ?').run(email, prof.id); // limpia perfiles duplicados
    db.prepare('INSERT INTO auth_users (id, email, password_hash) VALUES (?,?,?)').run(prof.id, email, hash);
    db.prepare("UPDATE profiles SET status = 'active' WHERE id = ?").run(prof.id);
  });
  res.json({ data: { id: prof.id, email }, error: null });
});

// Admin borra TODAS las demás cuentas (login + perfil), conservando SOLO la suya.
// Los demás deberán registrarse de nuevo y quedarán "pending" para que el admin
// los apruebe. No toca proyectos, inventario ni rutas: solo usuarios.
app.post('/api/admin/reset-others', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: { message: 'No autenticado' } });
  if (u.role !== 'admin') return res.status(403).json({ error: { message: 'Solo admin' } });
  let deleted = 0;
  tx(() => {
    deleted = db.prepare('SELECT COUNT(*) AS c FROM profiles WHERE id != ?').get(u.id).c;
    db.prepare('DELETE FROM auth_users WHERE id != ?').run(u.id);
    db.prepare('DELETE FROM profiles WHERE id != ?').run(u.id);
    db.prepare('DELETE FROM password_resets WHERE user_id != ?').run(u.id);
  });
  res.json({ data: { deleted, kept: u.id }, error: null });
});

// Admin elimina UN usuario puntual (login + perfil). No puede eliminarse a si mismo.
app.post('/api/admin/delete-user', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: { message: 'No autenticado' } });
  if (u.role !== 'admin') return res.status(403).json({ error: { message: 'Solo admin' } });
  const { userId } = req.body || {};
  if (!userId) return res.json({ error: { message: 'Falta el usuario' } });
  if (userId === u.id) return res.json({ error: { message: 'No podés eliminar tu propia cuenta' } });
  const prof = db.prepare('SELECT id, email FROM profiles WHERE id = ?').get(userId);
  const email = prof ? String(prof.email || '').trim().toLowerCase() : '';
  tx(() => {
    db.prepare('DELETE FROM auth_users WHERE id = ?').run(userId);
    if (email) db.prepare('DELETE FROM auth_users WHERE lower(trim(email)) = ?').run(email);
    db.prepare('DELETE FROM profiles WHERE id = ?').run(userId);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
  });
  res.json({ data: { deleted: prof ? 1 : 0, id: userId }, error: null });
});

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
    case 'equipo_movs':
      return op === 'delete' ? user.role === 'admin' : true; // crear/editar: cualquier activo; borrar: admin
    case 'messages':
      if (op !== 'insert') return false;
      return roleCan(chatRoomModule(values && values.room), user); // sala restringida → rol del módulo
    case 'profiles': {
      if (op !== 'update') return false;
      const keys = Object.keys(values || {});
      const touchesPriv = keys.includes('role') || keys.includes('status');
      if (touchesPriv) return user.role === 'admin';
      const idf = (filters || []).find(f => f.col === 'id');
      return user.role === 'admin' || (idf && idf.val === user.id); // nombre propio
    }
    // ── Contabilidad ──
    case 'cuentas':
      return roleCan('conta', user);
    case 'asientos':
    case 'movimientos':
    case 'files':
      return false; // sólo vía endpoints dedicados (/api/asiento, /api/upload)
    // ── Licitaciones ──
    case 'licitaciones': {
      if (!roleCan('licit', user)) return false;
      if (op === 'delete') return user.role === 'admin';
      if (op === 'update') {
        const est = values && values.estado;
        if (est === 'aprobada' || est === 'rechazada') return user.role === 'admin'; // aprobar: solo admin
      }
      return true; // crear/editar: admin + supervisor
    }
    // ── Mercadeo ──
    case 'campanas':
    case 'publicaciones':
    case 'mercadeo_tareas':
      return roleCan('mkt', user);
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
    if (!allowed.includes(f.col)) return;
    if (f.val === null) { where.push(`"${f.col}" IS NULL`); }       // chat general: project_id nulo
    else { where.push(`"${f.col}" = ?`); params.push(f.val); }
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
  if (allowed.includes('created_by') && !v.created_by) v.created_by = user.id;
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
  const module = moduleFor(table, req.body);
  if (table === 'files' && !module) return res.status(403).json({ data: null, error: { message: 'Falta scope' } });
  if (table === 'messages' && !((req.body.filters || []).some(f => f.col === 'room')))
    return res.status(400).json({ data: null, error: { message: 'Falta la sala del chat' } });
  if (!roleCan(module, u)) return res.status(403).json({ data: null, error: { message: 'No autorizado' } });
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
// ARCHIVOS (subida/descarga al volumen)
// ============================================================
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(DB_PATH), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 25 * 1024 * 1024 } });

app.post('/api/upload', upload.single('file'), (req, res) => {
  const u = getUser(req);
  const cleanup = () => { if (req.file) { try { fs.unlinkSync(req.file.path); } catch (e) {} } };
  if (!u) { cleanup(); return res.status(401).json({ error: { message: 'No autenticado' } }); }
  if (u.status !== 'active') { cleanup(); return res.status(403).json({ error: { message: 'Cuenta no activa' } }); }
  if (!req.file) return res.status(400).json({ error: { message: 'No se recibió archivo' } });
  const scope = req.body.scope;
  const module = fileModule(scope, req.body.ref_id);
  if (!roleCan(module, u)) { cleanup(); return res.status(403).json({ error: { message: 'No autorizado' } }); }
  const id = crypto.randomUUID();
  const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const now = new Date().toISOString();
  db.prepare('INSERT INTO files (id,name,mime,size,path,scope,ref_id,uploaded_by,uploaded_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, name, req.file.mimetype, req.file.size, path.basename(req.file.path), scope || null, req.body.ref_id || null, u.id, now);
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  broadcast({ table: 'files', eventType: 'INSERT', new: row, old: null });
  res.json({ data: { id, name, scope: scope || null, ref_id: req.body.ref_id || null, url: '/api/files/' + id }, error: null });
});

app.get('/api/files/:id', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).end();
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).end();
  if (!roleCan(fileModule(f.scope, f.ref_id), u)) return res.status(403).end();
  const full = path.join(UPLOAD_DIR, f.path);
  if (!fs.existsSync(full)) return res.status(404).end();
  if (f.mime) res.type(f.mime);
  const disp = req.query.download ? 'attachment' : 'inline';
  res.set('Content-Disposition', `${disp}; filename="${encodeURIComponent(f.name || 'archivo')}"`);
  res.sendFile(full);
});

app.delete('/api/files/:id', (req, res) => {
  const u = getUser(req);
  if (!u || u.status !== 'active') return res.status(401).json({ error: { message: 'No autenticado' } });
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: { message: 'No existe' } });
  const module = fileModule(f.scope, f.ref_id);
  if (!(u.role === 'admin' || (roleCan(module, u) && f.uploaded_by === u.id)))
    return res.status(403).json({ error: { message: 'No autorizado' } });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, f.path)); } catch (e) {}
  db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
  broadcast({ table: 'files', eventType: 'DELETE', new: null, old: f });
  res.json({ error: null });
});

// ============================================================
// CONTABILIDAD (partida doble)
// ============================================================
app.post('/api/asiento', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: { message: 'No autenticado' } });
  if (u.status !== 'active' || !roleCan('conta', u)) return res.status(403).json({ error: { message: 'No autorizado' } });
  const { fecha, descripcion, referencia, comprobante_file } = req.body || {};
  const lineas = Array.isArray(req.body && req.body.movimientos) ? req.body.movimientos : [];
  if (!fecha) return res.json({ error: { message: 'Falta la fecha' } });
  if (lineas.length < 2) return res.json({ error: { message: 'Un asiento necesita al menos 2 líneas' } });

  let totDebe = 0, totHaber = 0;
  for (const l of lineas) {
    const d = Number(l.debe) || 0, h = Number(l.haber) || 0;
    if (!l.cuenta_id) return res.json({ error: { message: 'Hay una línea sin cuenta' } });
    if (d < 0 || h < 0) return res.json({ error: { message: 'No se permiten montos negativos' } });
    if (d > 0 && h > 0) return res.json({ error: { message: 'Una línea no puede tener debe y haber a la vez' } });
    totDebe += d; totHaber += h;
  }
  if (Math.round((totDebe - totHaber) * 100) !== 0)
    return res.json({ error: { message: `Asiento descuadrado: debe ${totDebe.toFixed(2)} ≠ haber ${totHaber.toFixed(2)}` } });
  if (totDebe === 0) return res.json({ error: { message: 'El asiento no puede ser en cero' } });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  tx(() => {
    db.prepare('INSERT INTO asientos (id,fecha,descripcion,referencia,estado,comprobante_file,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, fecha, descripcion || '', referencia || '', 'confirmado', comprobante_file || null, u.id, now, now);
    const insM = db.prepare('INSERT INTO movimientos (id,asiento_id,cuenta_id,debe,haber,proyecto_id,descripcion) VALUES (?,?,?,?,?,?,?)');
    for (const l of lineas) {
      insM.run(crypto.randomUUID(), id, l.cuenta_id, Number(l.debe) || 0, Number(l.haber) || 0, l.proyecto_id || null, l.descripcion || '');
    }
  });
  const row = db.prepare('SELECT * FROM asientos WHERE id = ?').get(id);
  broadcast({ table: 'asientos', eventType: 'INSERT', new: row, old: null });
  res.json({ data: row, error: null });
});

// ============================================================
// VALES DE SALIDA / ENTRADA  (mueven stock entre ubicaciones)
// ------------------------------------------------------------
// Un vale nuevo descuenta las líneas enlazadas a un artículo del
// inventario (item_id + cant) de su ubicación de ORIGEN y las suma
// en la de DESTINO (bodega o un proyecto). Al editar un vale sólo se
// corrigen los datos del documento; el stock NO se vuelve a mover
// para no duplicar el movimiento.
// ============================================================
const MOV_FIELDS = ['tipo', 'numero', 'fecha', 'proyecto_motivo', 'placa', 'responsable', 'cedula', 'cargo', 'tel', 'sitio', 'supervisor', 'fecha_mov', 'fecha_ret', 'condicion', 'observaciones', 'firma_sol', 'firma_aut', 'firma_sup', 'origen_id', 'destino_id'];

app.post('/api/mov', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: { message: 'No autenticado' } });
  if (u.status !== 'active') return res.status(403).json({ error: { message: 'Cuenta no activa' } });

  const b = req.body || {};
  const tipo = b.tipo === 'entrada' ? 'entrada' : 'salida';
  const lines = Array.isArray(b.items) ? b.items : [];
  const origen = b.origen_id || (tipo === 'salida' ? 'bodega' : '');
  const destino = b.destino_id || (tipo === 'entrada' ? 'bodega' : '');

  // Campos del documento (el autor y el stock los pone el servidor).
  const fields = { tipo, origen_id: origen || null, destino_id: destino || null, items: JSON.stringify(lines) };
  for (const k of MOV_FIELDS) if (k !== 'tipo' && k !== 'origen_id' && k !== 'destino_id') fields[k] = b[k] || '';

  const now = new Date().toISOString();

  // ── EDICIÓN: sólo actualiza el documento, sin tocar stock ──
  if (b.id) {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE equipo_movs SET ${keys.map(k => `"${k}" = ?`).join(',')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map(k => fields[k]), now, b.id);
    const row = db.prepare('SELECT * FROM equipo_movs WHERE id = ?').get(b.id);
    if (!row) return res.json({ error: { message: 'Vale no encontrado' } });
    broadcast({ table: 'equipo_movs', eventType: 'UPDATE', new: row, old: null });
    return res.json({ data: { mov: row, items: [] }, error: null });
  }

  // ── NUEVO: aplica stock a las líneas enlazadas ──
  const stockLines = lines
    .filter(l => l && l.item_id && Math.round(Number(l.cant) || 0) > 0)
    .map(l => ({ item_id: l.item_id, cant: Math.round(Number(l.cant) || 0) }));

  if (stockLines.length) {
    if (!origen) return res.json({ error: { message: 'Elegí la ubicación de origen (de dónde salen los artículos).' } });
    if (!destino) return res.json({ error: { message: 'Elegí la ubicación de destino (a dónde van los artículos).' } });
    if (origen === destino) return res.json({ error: { message: 'El origen y el destino no pueden ser el mismo.' } });
    for (const l of stockLines) {
      const src = db.prepare('SELECT * FROM items WHERE id = ?').get(l.item_id);
      if (!src) return res.json({ error: { message: 'Un artículo enlazado ya no existe en el inventario.' } });
      if (src.project_id !== origen) return res.json({ error: { message: `"${src.name}" no está en el origen seleccionado.` } });
      if (l.cant > (src.quantity || 0)) return res.json({ error: { message: `No hay suficiente "${src.name}" en el origen (hay ${src.quantity || 0}, pedís ${l.cant}).` } });
    }
  }

  const movId = crypto.randomUUID();
  const touched = new Set();
  try {
    tx(() => {
      const keys = ['id', ...Object.keys(fields), 'created_by', 'created_at', 'updated_at'];
      const vals = [movId, ...Object.keys(fields).map(k => fields[k]), u.id, now, now];
      db.prepare(`INSERT INTO equipo_movs (${keys.map(k => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...vals);

      for (const l of stockLines) {
        const src = db.prepare('SELECT * FROM items WHERE id = ?').get(l.item_id);
        db.prepare('UPDATE items SET quantity = ?, updated_by = ?, updated_at = ? WHERE id = ?')
          .run((src.quantity || 0) - l.cant, u.id, now, src.id);
        touched.add(src.id);

        const dst = db.prepare('SELECT * FROM items WHERE project_id = ? AND lower(name) = lower(?) AND category = ? LIMIT 1')
          .get(destino, src.name, src.category);
        if (dst) {
          db.prepare('UPDATE items SET quantity = ?, updated_by = ?, updated_at = ? WHERE id = ?')
            .run((dst.quantity || 0) + l.cant, u.id, now, dst.id);
          touched.add(dst.id);
        } else {
          const nid = crypto.randomUUID();
          db.prepare('INSERT INTO items (id,name,category,unit,quantity,min_stock,estado,notes,photo_id,project_id,updated_by,updated_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(nid, src.name, src.category, src.unit || '', l.cant, 0, src.estado || 'OPERATIVA', '', src.photo_id || null, destino, u.id, now, now);
          touched.add(nid);
        }
      }
    });
  } catch (e) {
    return res.json({ error: { message: e.message || 'No se pudo guardar el vale' } });
  }

  const movRow = db.prepare('SELECT * FROM equipo_movs WHERE id = ?').get(movId);
  broadcast({ table: 'equipo_movs', eventType: 'INSERT', new: movRow, old: null });
  const items = [];
  for (const iid of touched) {
    const r = db.prepare('SELECT * FROM items WHERE id = ?').get(iid);
    if (r) { broadcast({ table: 'items', eventType: 'UPDATE', new: r, old: null }); items.push(r); }
  }
  res.json({ data: { mov: movRow, items }, error: null });
});

// Saldos por cuenta en un rango: base del balance de comprobación, el estado
// de resultados y el balance general (el front arma cada vista con esto).
app.post('/api/conta/saldos', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: { message: 'No autenticado' } });
  if (!roleCan('conta', u)) return res.status(403).json({ error: { message: 'No autorizado' } });
  const { desde, hasta, proyecto_id } = req.body || {};
  const cond = [], params = [];
  if (desde) { cond.push('a.fecha >= ?'); params.push(desde); }
  if (hasta) { cond.push('a.fecha <= ?'); params.push(hasta); }
  if (proyecto_id) { cond.push('m.proyecto_id = ?'); params.push(proyecto_id); }
  // El filtro de fecha va en el ON para no descartar cuentas sin movimientos.
  const sql = `
    SELECT c.id AS cuenta_id, c.codigo, c.nombre, c.tipo,
           COALESCE(SUM(m.debe),0) AS debe, COALESCE(SUM(m.haber),0) AS haber
    FROM cuentas c
    LEFT JOIN movimientos m ON m.cuenta_id = c.id
    LEFT JOIN asientos a ON a.id = m.asiento_id ${cond.length ? 'AND ' + cond.join(' AND ') : ''}
    GROUP BY c.id
    ORDER BY c.codigo`;
  const rows = db.prepare(sql).all(...params).map(r => ({ ...r, saldo: Number(r.debe) - Number(r.haber) }));
  res.json({ data: rows, error: null });
});

// Libro mayor de una cuenta: movimientos ordenados con saldo corriente.
app.post('/api/conta/mayor', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: { message: 'No autenticado' } });
  if (!roleCan('conta', u)) return res.status(403).json({ error: { message: 'No autorizado' } });
  const { cuenta_id, desde, hasta, proyecto_id } = req.body || {};
  if (!cuenta_id) return res.json({ error: { message: 'Falta la cuenta' } });
  const cond = ['m.cuenta_id = ?'], params = [cuenta_id];
  if (desde) { cond.push('a.fecha >= ?'); params.push(desde); }
  if (hasta) { cond.push('a.fecha <= ?'); params.push(hasta); }
  if (proyecto_id) { cond.push('m.proyecto_id = ?'); params.push(proyecto_id); }
  const sql = `
    SELECT a.fecha, a.descripcion, a.referencia, m.debe, m.haber, m.proyecto_id, m.descripcion AS linea
    FROM movimientos m JOIN asientos a ON a.id = m.asiento_id
    WHERE ${cond.join(' AND ')}
    ORDER BY a.fecha, a.created_at`;
  let saldo = 0;
  const rows = db.prepare(sql).all(...params).map(r => { saldo += Number(r.debe) - Number(r.haber); return { ...r, saldo }; });
  res.json({ data: rows, error: null });
});

// Ingresos y gastos agrupados por mes (para las gráficas del panel).
app.post('/api/conta/mensual', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: { message: 'No autenticado' } });
  if (!roleCan('conta', u)) return res.status(403).json({ error: { message: 'No autorizado' } });
  const { desde, hasta, proyecto_id } = req.body || {};
  const cond = [], params = [];
  if (desde) { cond.push('a.fecha >= ?'); params.push(desde); }
  if (hasta) { cond.push('a.fecha <= ?'); params.push(hasta); }
  if (proyecto_id) { cond.push('m.proyecto_id = ?'); params.push(proyecto_id); }
  const sql = `
    SELECT substr(a.fecha,1,7) AS mes,
           COALESCE(SUM(CASE WHEN c.tipo='ingreso' THEN (m.haber - m.debe) ELSE 0 END),0) AS ingresos,
           COALESCE(SUM(CASE WHEN c.tipo='gasto'   THEN (m.debe - m.haber) ELSE 0 END),0) AS gastos
    FROM movimientos m
    JOIN asientos a ON a.id = m.asiento_id
    JOIN cuentas c ON c.id = m.cuenta_id
    ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
    GROUP BY mes ORDER BY mes`;
  res.json({ data: db.prepare(sql).all(...params), error: null });
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
        from: MAIL_FROM,
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
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject: `📊 Reporte de Inventario CMI — ${fecha}`, html })
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
