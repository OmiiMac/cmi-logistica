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

-- ── Carga Express: vehículos (kilometraje actual) y registro de combustible ──
CREATE TABLE IF NOT EXISTS vehiculos (
  id         TEXT PRIMARY KEY,
  placa      TEXT,
  nombre     TEXT,
  km_actual  REAL DEFAULT 0,
  activo     INTEGER DEFAULT 1,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS combustible (
  id          TEXT PRIMARY KEY,
  placa       TEXT,
  vehiculo_id TEXT,
  fecha       TEXT,
  monto       REAL,
  galones     REAL,
  km          REAL,
  estacion    TEXT,
  notas       TEXT,
  created_by  TEXT,
  created_at  TEXT
);
CREATE TABLE IF NOT EXISTS kilometraje (
  id          TEXT PRIMARY KEY,
  placa       TEXT,
  vehiculo_id TEXT,
  fecha       TEXT,
  km_salida   REAL,
  km_entrada  REAL,
  notas       TEXT,
  created_by  TEXT,
  created_at  TEXT
);

-- ── Contabilidad: pagos/gastos mensuales recurrentes por empresa ──
CREATE TABLE IF NOT EXISTS gastos_mensuales (
  id         TEXT PRIMARY KEY,
  empresa    TEXT,
  mes        TEXT,       -- YYYY-MM
  categoria  TEXT,       -- planilla|gasolina|luz|telefono|alquiler|internet|agua|seguro|otros
  concepto   TEXT,
  monto      REAL,
  estado     TEXT DEFAULT 'pendiente',  -- pendiente|pagado
  fecha_pago TEXT,
  notas      TEXT,
  created_by TEXT,
  created_at TEXT
);

-- ── Competidores por licitación ──
CREATE TABLE IF NOT EXISTS lic_competidores (
  id              TEXT PRIMARY KEY,
  licitacion_id   TEXT NOT NULL,
  nombre          TEXT NOT NULL,
  monto           REAL,
  resultado       TEXT DEFAULT 'sin_info',  -- ganó|perdió|sin_info
  notas           TEXT,
  created_by      TEXT,
  created_at      TEXT
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

-- Pendientes y compromisos mensuales (cuentas por pagar / gastos fijos)
CREATE TABLE IF NOT EXISTS compromisos (
  id          TEXT PRIMARY KEY,
  concepto    TEXT NOT NULL,
  tipo        TEXT DEFAULT 'pendiente',   -- pendiente | mensual
  monto       REAL DEFAULT 0,
  categoria   TEXT,
  proyecto_id TEXT,
  vencimiento TEXT,                        -- fecha (YYYY-MM-DD) o dia del mes
  estado      TEXT DEFAULT 'pendiente',    -- pendiente | pagado
  notas       TEXT,
  created_by  TEXT,
  created_at  TEXT,
  updated_at  TEXT
);

-- Caja chica por proyecto (ingresos de fondo y gastos con comprobante)
CREATE TABLE IF NOT EXISTS caja_chica (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  fecha        TEXT,                        -- YYYY-MM-DD
  concepto     TEXT NOT NULL,
  tipo         TEXT DEFAULT 'gasto',        -- ingreso (fondo/reembolso) | gasto
  monto        REAL DEFAULT 0,
  categoria    TEXT,
  comprobante_file TEXT,                    -- id de archivo (foto/factura)
  estado       TEXT DEFAULT 'registrado',   -- registrado | reembolsado | pendiente
  notas        TEXT,
  created_by   TEXT,
  created_at   TEXT,
  updated_at   TEXT
);

-- Cuadrilla (trabajadores de planilla) por proyecto
CREATE TABLE IF NOT EXISTS cuadrilla (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  nombre     TEXT NOT NULL,
  cargo      TEXT,
  salario_dia REAL DEFAULT 0,              -- cuánto gana por día
  foto_file  TEXT,                         -- id de foto del rostro
  activo     INTEGER DEFAULT 1,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
);
-- Cuadrillas (grupos de trabajo) de un proyecto, cada una con su capataz
CREATE TABLE IF NOT EXISTS cuadrilla_grupos (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  nombre     TEXT NOT NULL,
  capataz    TEXT,
  color      TEXT,
  notas      TEXT,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
);
-- Asistencia diaria de la cuadrilla
CREATE TABLE IF NOT EXISTS asistencia (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  trabajador_id TEXT NOT NULL,
  fecha        TEXT,                       -- YYYY-MM-DD
  estado       TEXT DEFAULT 'presente',    -- presente | tarde | justificado | ausente
  hora_entrada TEXT,                       -- HH:MM
  hora_salida  TEXT,                        -- HH:MM
  notas        TEXT,
  created_by   TEXT,
  created_at   TEXT,
  updated_at   TEXT
);

-- ── Paint Pro (venta de pintura): inventario, clientes, visitas, cotizaciones, calendario ──
CREATE TABLE IF NOT EXISTS pp_inventario (
  id TEXT PRIMARY KEY, producto TEXT, marca TEXT, color TEXT, codigo TEXT, categoria TEXT,
  cantidad REAL DEFAULT 0, unidad TEXT, costo REAL DEFAULT 0, precio REAL DEFAULT 0,
  min_stock REAL DEFAULT 0, foto_file TEXT, notas TEXT, created_by TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS pp_ordenes (
  id TEXT PRIMARY KEY, fecha TEXT, numero TEXT, proveedor TEXT, producto TEXT, cantidad REAL,
  costo_unitario REAL DEFAULT 0, total REAL DEFAULT 0, estado TEXT DEFAULT 'solicitada',
  notas TEXT, created_by TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS pp_eventos (
  id TEXT PRIMARY KEY, fecha TEXT, hora TEXT, titulo TEXT, tipo TEXT, color TEXT, notas TEXT,
  created_by TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS pp_clientes (
  id TEXT PRIMARY KEY, nombre TEXT, empresa TEXT, telefono TEXT, email TEXT, direccion TEXT,
  ruc TEXT, tipo TEXT, notas TEXT, created_by TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS pp_visitas (
  id TEXT PRIMARY KEY, fecha TEXT, hora TEXT, titulo TEXT, cliente TEXT, responsable TEXT,
  motivo TEXT, estado TEXT DEFAULT 'programada', lugar TEXT, reporte_file TEXT, notas TEXT,
  created_by TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS pp_leads (
  id TEXT PRIMARY KEY, cliente TEXT, prioridad TEXT DEFAULT 'media', tipo TEXT, proyecto TEXT,
  contacto TEXT, cargo TEXT, telefono TEXT, email TEXT, estado TEXT DEFAULT 'contactado',
  notas TEXT, created_by TEXT, created_at TEXT, updated_at TEXT
);
-- Cotizaciones enviadas al cliente (reemplazan a las órdenes de compra)
CREATE TABLE IF NOT EXISTS pp_cotizaciones (
  id TEXT PRIMARY KEY, fecha TEXT, numero TEXT, cliente TEXT, cliente_id TEXT,
  descripcion TEXT, monto REAL DEFAULT 0, estado TEXT DEFAULT 'enviada',
  notas TEXT, created_by TEXT, created_at TEXT, updated_at TEXT
);
-- Hilo de notas / comunicación por cliente (seguimiento conversado)
CREATE TABLE IF NOT EXISTS pp_notas (
  id TEXT PRIMARY KEY, cliente_id TEXT, texto TEXT, file_id TEXT,
  created_by TEXT, created_at TEXT, updated_at TEXT
);

-- Mercadeo: calendario de mensajes push (planificación, por empresa)
CREATE TABLE IF NOT EXISTS mkt_push (
  id           TEXT PRIMARY KEY,
  empresa      TEXT,
  fecha        TEXT,
  hora         TEXT,
  titulo       TEXT,
  mensaje      TEXT,
  estado       TEXT DEFAULT 'borrador',   -- borrador|revision|aprobado|enviado|no_enviado
  responsable  TEXT,
  observaciones TEXT,
  created_by   TEXT,
  created_at   TEXT,
  updated_at   TEXT
);

-- Mercadeo: efemérides / fechas comerciales (capa del calendario)
CREATE TABLE IF NOT EXISTS mkt_efemerides (
  id           TEXT PRIMARY KEY,
  empresa      TEXT,                        -- vacío = aplica a todas
  fecha        TEXT,                        -- YYYY-MM-DD (o se usa MM-DD si recurrente)
  titulo       TEXT NOT NULL,
  color        TEXT,
  recurrente   INTEGER DEFAULT 0,           -- 1 = se repite cada año
  created_by   TEXT,
  created_at   TEXT,
  updated_at   TEXT
);

-- Mercadeo: enlaces de biblioteca (Google Drive y otros), por empresa
CREATE TABLE IF NOT EXISTS mkt_biblioteca (
  id           TEXT PRIMARY KEY,
  empresa      TEXT,
  titulo       TEXT NOT NULL,
  categoria    TEXT,                        -- Planes|Grillas|Artes|Videos|Documentos…
  url          TEXT,
  created_by   TEXT,
  created_at   TEXT,
  updated_at   TEXT
);

-- Mercadeo: piezas en preaprobación (grillas, artes, reels, copys, propuestas)
CREATE TABLE IF NOT EXISTS mkt_piezas (
  id           TEXT PRIMARY KEY,
  empresa      TEXT,
  titulo       TEXT NOT NULL,
  tipo         TEXT,                       -- grilla|arte|reel|historia|copy|propuesta
  formato      TEXT,
  red_social   TEXT,
  copy         TEXT,
  fecha        TEXT,                        -- fecha sugerida de publicación
  responsable  TEXT,
  version      INTEGER DEFAULT 1,
  comentarios  TEXT,
  estado       TEXT DEFAULT 'borrador',     -- borrador|enviado|correcciones|aprobado|programado
  archivo_file TEXT,
  campana_id   TEXT,
  publicacion_id TEXT,
  created_by   TEXT,
  created_at   TEXT,
  updated_at   TEXT
);

-- Salidas de material por proyecto (trazabilidad: a qué actividad/área se usó)
CREATE TABLE IF NOT EXISTS salidas_material (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  item_id     TEXT,
  item_name   TEXT,
  cantidad    REAL DEFAULT 0,
  unidad      TEXT,
  actividad   TEXT,                        -- a qué actividad se destinó
  area        TEXT,                        -- edificación / área
  fecha       TEXT,
  notas       TEXT,
  created_by  TEXT,
  created_at  TEXT,
  updated_at  TEXT
);

-- Compras y cotizaciones por proyecto (solicitud -> cotizada -> aprobada -> entregada)
CREATE TABLE IF NOT EXISTS compras (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  descripcion   TEXT NOT NULL,
  cantidad      TEXT,
  proveedor     TEXT,
  monto         REAL DEFAULT 0,
  estado        TEXT DEFAULT 'solicitud',  -- solicitud | cotizada | aprobada | en_camino | entregada
  fecha_solicitud TEXT,
  fecha_entrega TEXT,
  aprobado_por  TEXT,
  factura_file  TEXT,
  notas         TEXT,
  created_by    TEXT,
  created_at    TEXT,
  updated_at    TEXT
);

-- Costos ejecutados del proyecto por rubro (mano de obra, material, equipo, transporte).
CREATE TABLE IF NOT EXISTS proyecto_costos (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  rubro          TEXT NOT NULL,  -- mano_obra | material | equipo | transporte
  concepto       TEXT,
  monto          REAL DEFAULT 0,
  fecha          TEXT,
  proveedor      TEXT,
  comprobante_file TEXT,
  notas          TEXT,
  created_by     TEXT,
  created_at     TEXT,
  updated_at     TEXT
);

-- Resumen gerencial por proyecto (avance físico y presupuesto). Una fila por proyecto (id = project_id).
CREATE TABLE IF NOT EXISTS obra_resumen (
  id           TEXT PRIMARY KEY,
  project_id   TEXT,
  avance_pct   REAL DEFAULT 0,
  presupuesto  REAL DEFAULT 0,
  notas        TEXT,
  updated_by   TEXT,
  updated_at   TEXT
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
ensureColumn('equipo_movs', 'stock_aplicado', 'INTEGER');   // 1 = alguna línea del vale movió stock (el detalle va en items[].ap)
ensureColumn('profiles', 'restrict_mods', 'TEXT'); // módulos ocultos para este usuario (ej: 'conta,licit')
ensureColumn('profiles', 'phone', 'TEXT');          // teléfono para avisos por WhatsApp (formato +503...)
ensureColumn('profiles', 'wa_optin', 'INTEGER DEFAULT 0'); // 1 = acepta recibir avisos por WhatsApp
ensureColumn('licitaciones', 'responsable_presupuesto', 'TEXT'); // responsable del presupuesto
ensureColumn('licitaciones', 'precio_costo', 'REAL');            // precio costo
ensureColumn('licitaciones', 'fecha_homologacion', 'TEXT');     // fecha de homologación
ensureColumn('licitaciones', 'hora_homologacion', 'TEXT');      // hora de homologación
ensureColumn('licitaciones', 'url', 'TEXT');                    // enlace a la página de la licitación
ensureColumn('compras', 'encargado', 'TEXT');                   // encargado de la compra
ensureColumn('compras', 'observaciones', 'TEXT');              // observaciones de la compra
ensureColumn('compras', 'observacion_file', 'TEXT');          // foto adjunta a la observación
ensureColumn('items', 'obs_noop', 'TEXT');                     // observaciones de equipo no operativo
ensureColumn('items', 'costo', 'REAL DEFAULT 0');             // costo unitario del artículo
// Carga Express (rutas): vehículo, carga, cliente, flete, kilometraje y entrega.
ensureColumn('rutas', 'placa', 'TEXT');
ensureColumn('rutas', 'tipo_carga', 'TEXT');
ensureColumn('rutas', 'cliente', 'TEXT');
ensureColumn('rutas', 'costo_flete', 'REAL');
ensureColumn('rutas', 'km_salida', 'REAL');
ensureColumn('rutas', 'km_entrada', 'REAL');
ensureColumn('rutas', 'observaciones', 'TEXT');
ensureColumn('rutas', 'recibido_por', 'TEXT');
ensureColumn('rutas', 'comprobante_file', 'TEXT');
ensureColumn('vehiculos', 'condicion', 'TEXT');   // operativo | necesita_mant | en_mant
ensureColumn('cuadrilla', 'salario_dia', 'REAL'); // planilla: pago por día
ensureColumn('cuadrilla', 'foto_file', 'TEXT');   // foto del rostro
ensureColumn('cuadrilla', 'valor_hora_extra', 'REAL'); // pago por cada hora extra
ensureColumn('cuadrilla', 'grupo_id', 'TEXT');   // cuadrilla (grupo) a la que pertenece
ensureColumn('asistencia', 'hora_entrada', 'TEXT');
ensureColumn('asistencia', 'hora_salida', 'TEXT');
ensureColumn('asistencia', 'horas_extra', 'REAL');   // horas extra del día
// Paint Pro: Entregas y Devoluciones se retiraron del módulo; se descartan sus tablas.
db.exec('DROP TABLE IF EXISTS pp_entregas; DROP TABLE IF EXISTS pp_devoluciones;');
// Paint Pro: vínculo al inventario (item) y control de movimiento de stock ya aplicado
ensureColumn('pp_ordenes', 'item_id', 'TEXT');
ensureColumn('pp_ordenes', 'stock_aplicado', 'REAL');
// Paint Pro: Seguimiento quedó unificado dentro de la Base de Clientes.
ensureColumn('pp_clientes', 'prioridad', "TEXT DEFAULT 'media'");
ensureColumn('pp_clientes', 'tipo_lead', 'TEXT');
ensureColumn('pp_clientes', 'proyecto', 'TEXT');
ensureColumn('pp_clientes', 'contacto', 'TEXT');
ensureColumn('pp_clientes', 'cargo', 'TEXT');
ensureColumn('pp_clientes', 'estado', "TEXT DEFAULT 'contactado'");
// Visitas y cotizaciones se enganchan al cliente por id (el nombre queda como respaldo).
ensureColumn('pp_visitas', 'cliente_id', 'TEXT');

// Migración única: vuelca los leads de Seguimiento dentro de la Base de Clientes.
// Si ya existe un cliente con ese nombre, completa sus campos de seguimiento;
// si no existe, lo crea. Marca la meta para no repetirla en cada arranque.
if (!db.prepare('SELECT value FROM meta WHERE key = ?').get('pp_leads_merged')) {
  const leads = db.prepare('SELECT * FROM pp_leads').all();
  const now = new Date().toISOString();
  tx(() => {
    for (const l of leads) {
      const nom = String(l.cliente || '').trim();
      if (!nom) continue;
      const ex = db.prepare('SELECT id FROM pp_clientes WHERE lower(trim(nombre)) = ?').get(nom.toLowerCase());
      if (ex) {
        db.prepare(`UPDATE pp_clientes SET
            prioridad = COALESCE(NULLIF(prioridad,''), ?), tipo_lead = COALESCE(NULLIF(tipo_lead,''), ?),
            proyecto  = COALESCE(NULLIF(proyecto,''),  ?), contacto  = COALESCE(NULLIF(contacto,''),  ?),
            cargo     = COALESCE(NULLIF(cargo,''),     ?), estado    = COALESCE(NULLIF(estado,''),    ?),
            telefono  = COALESCE(NULLIF(telefono,''),  ?), email     = COALESCE(NULLIF(email,''),     ?),
            updated_at = ?
          WHERE id = ?`)
          .run(l.prioridad || 'media', l.tipo || '', l.proyecto || '', l.contacto || '', l.cargo || '',
               l.estado || 'contactado', l.telefono || '', l.email || '', now, ex.id);
      } else {
        db.prepare(`INSERT INTO pp_clientes
            (id,nombre,empresa,telefono,email,direccion,ruc,tipo,notas,prioridad,tipo_lead,proyecto,contacto,cargo,estado,created_by,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(crypto.randomUUID(), nom, '', l.telefono || '', l.email || '', '', '', '', l.notas || '',
               l.prioridad || 'media', l.tipo || '', l.proyecto || '', l.contacto || '', l.cargo || '',
               l.estado || 'contactado', l.created_by || null, l.created_at || now, now);
      }
    }
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('pp_leads_merged', new Date().toISOString());
  });
  if (leads.length) console.log(`Paint Pro: ${leads.length} registro(s) de Seguimiento unificados en la Base de Clientes.`);
}
// Siembra inicial de la flota (solo si no hay vehículos): HINO, JMC, L200 y Ford Figo.
try {
  if (db.prepare('SELECT COUNT(*) AS c FROM vehiculos').get().c === 0) {
    const now = new Date().toISOString();
    const ins = db.prepare('INSERT INTO vehiculos (id,placa,nombre,km_actual,activo,created_at) VALUES (?,?,?,?,1,?)');
    [['', 'Camión HINO'], ['', 'Camión JMC'], ['', 'Pickup Mitsubishi L200'], ['', 'Sedán Ford Figo']]
      .forEach(([placa, nombre]) => ins.run(crypto.randomUUID(), placa, nombre, 0, now));
  }
} catch (e) { console.error('seed vehiculos:', e.message); }
// Flujo de compras: solicitud → aprobado → comprado → en_camino → entregada.
db.exec("UPDATE compras SET estado='aprobado' WHERE estado IN ('cotizada','aprobada')");
db.exec("UPDATE compras SET estado='comprado' WHERE estado='pagado'");
ensureColumn('campanas', 'empresa', 'TEXT');           // mercadeo por empresa
ensureColumn('campanas', 'objetivo', 'TEXT');
ensureColumn('campanas', 'drive_link', 'TEXT');
ensureColumn('publicaciones', 'empresa', 'TEXT');
ensureColumn('publicaciones', 'hora', 'TEXT');
ensureColumn('publicaciones', 'titulo', 'TEXT');
ensureColumn('publicaciones', 'formato', 'TEXT');
ensureColumn('publicaciones', 'responsable', 'TEXT');
ensureColumn('publicaciones', 'reemplazo', 'TEXT');   // sustituida por (nombre/enlace)
ensureColumn('publicaciones', 'motivo', 'TEXT');      // motivo de sustitución/reprogramación
ensureColumn('publicaciones', 'color', 'TEXT');
ensureColumn('publicaciones', 'categoria', 'TEXT');       // color elegido por el usuario (tipo de publicación)
db.exec("UPDATE publicaciones SET estado='publicado' WHERE estado='publicada'");
db.exec("UPDATE publicaciones SET estado='programado' WHERE estado IN ('planificada','planificado') OR estado IS NULL");
ensureColumn('mercadeo_tareas', 'empresa', 'TEXT');
ensureColumn('mercadeo_tareas', 'fecha_inicio', 'TEXT');
ensureColumn('mercadeo_tareas', 'fecha_limite', 'TEXT');
ensureColumn('mercadeo_tareas', 'fecha_publicacion', 'TEXT');
ensureColumn('mercadeo_tareas', 'campana_id', 'TEXT');
ensureColumn('mercadeo_tareas', 'enlace', 'TEXT');
db.exec("UPDATE mercadeo_tareas SET estado='en_proceso' WHERE estado='en_progreso'");
db.exec("UPDATE mercadeo_tareas SET estado='completado' WHERE estado='hecho'");
// Migración de estados de licitaciones al nuevo esquema (idempotente):
// por_evaluar, aprobada, participada, rechazada, adjudicada.
db.exec("UPDATE licitaciones SET estado='por_evaluar' WHERE estado IN ('borrador','en_revision','en_preparacion')");
db.exec("UPDATE licitaciones SET estado='participada' WHERE estado='presentada'");
db.exec("UPDATE licitaciones SET estado='rechazada'   WHERE estado='perdida'");
// Backfill idempotente: mensajes previos quedan en su sala correcta.
db.exec("UPDATE messages SET room = 'proyecto:' || project_id WHERE room IS NULL AND project_id IS NOT NULL");
db.exec("UPDATE messages SET room = 'general' WHERE room IS NULL");

// Columnas permitidas por tabla (whitelist anti-inyección e integridad)
const SCHEMA = {
  profiles:  ['id', 'email', 'name', 'role', 'status', 'restrict_mods', 'phone', 'wa_optin', 'created_at', 'updated_at'],
  projects:  ['id', 'name', 'address', 'supervisor', 'engineer_id', 'color', 'status', 'notes', 'created_at', 'updated_at'],
  items:     ['id', 'name', 'category', 'unit', 'quantity', 'min_stock', 'estado', 'notes', 'obs_noop', 'costo', 'photo_id', 'project_id', 'updated_by', 'updated_at', 'created_at'],
  transfers: ['id', 'item_name', 'from_project', 'to_project', 'quantity', 'unit', 'by_user', 'notes', 'date'],
  equipo_movs: ['id', 'tipo', 'numero', 'fecha', 'proyecto_motivo', 'placa', 'responsable', 'cedula', 'cargo', 'tel', 'sitio', 'supervisor', 'fecha_mov', 'fecha_ret', 'condicion', 'observaciones', 'firma_sol', 'firma_aut', 'firma_sup', 'items', 'origen_id', 'destino_id', 'stock_aplicado', 'created_by', 'created_at', 'updated_at'],
  rutas:     ['id', 'date', 'hora', 'origen', 'destino', 'conductor', 'descripcion', 'status', 'placa', 'tipo_carga', 'cliente', 'costo_flete', 'km_salida', 'km_entrada', 'observaciones', 'recibido_por', 'comprobante_file', 'updated_by', 'updated_at', 'created_at'],
  vehiculos: ['id', 'placa', 'nombre', 'km_actual', 'activo', 'condicion', 'created_at'],
  combustible: ['id', 'placa', 'vehiculo_id', 'fecha', 'monto', 'galones', 'km', 'estacion', 'notas', 'created_by', 'created_at'],
  kilometraje: ['id', 'placa', 'vehiculo_id', 'fecha', 'km_salida', 'km_entrada', 'notas', 'created_by', 'created_at'],
  gastos_mensuales: ['id', 'empresa', 'mes', 'categoria', 'concepto', 'monto', 'estado', 'fecha_pago', 'notas', 'created_by', 'created_at'],
  messages:  ['id', 'user_id', 'content', 'project_id', 'room', 'file_id', 'created_at'],
  files:        ['id', 'name', 'mime', 'size', 'path', 'scope', 'ref_id', 'uploaded_by', 'uploaded_at'],
  cuentas:      ['id', 'codigo', 'nombre', 'tipo', 'parent_id', 'activa', 'created_at'],
  asientos:     ['id', 'fecha', 'descripcion', 'referencia', 'estado', 'comprobante_file', 'created_by', 'created_at', 'updated_at'],
  movimientos:  ['id', 'asiento_id', 'cuenta_id', 'debe', 'haber', 'proyecto_id', 'descripcion'],
  licitaciones: ['id', 'titulo', 'entidad', 'numero', 'fecha_publicacion', 'fecha_limite', 'monto_estimado', 'precio_costo', 'moneda', 'estado', 'responsable', 'responsable_presupuesto', 'fecha_homologacion', 'hora_homologacion', 'url', 'notas', 'aprobado_por', 'aprobado_at', 'created_by', 'created_at', 'updated_at'],
  campanas:     ['id', 'nombre', 'descripcion', 'estado', 'fecha_inicio', 'fecha_fin', 'responsable', 'empresa', 'objetivo', 'drive_link', 'created_by', 'created_at', 'updated_at'],
  mkt_push:     ['id', 'empresa', 'fecha', 'hora', 'titulo', 'mensaje', 'estado', 'responsable', 'observaciones', 'created_by', 'created_at', 'updated_at'],
  mkt_efemerides:['id', 'empresa', 'fecha', 'titulo', 'color', 'recurrente', 'created_by', 'created_at', 'updated_at'],
  mkt_biblioteca:['id', 'empresa', 'titulo', 'categoria', 'url', 'created_by', 'created_at', 'updated_at'],
  publicaciones:['id', 'campana_id', 'fecha', 'canal', 'contenido', 'estado', 'empresa', 'hora', 'titulo', 'formato', 'responsable', 'reemplazo', 'motivo', 'color', 'categoria', 'created_by', 'created_at', 'updated_at'],
  mercadeo_tareas:['id', 'titulo', 'descripcion', 'responsable', 'prioridad', 'estado', 'empresa', 'fecha_inicio', 'fecha_limite', 'fecha_publicacion', 'campana_id', 'enlace', 'created_by', 'created_at', 'updated_at'],
  mkt_piezas:   ['id', 'empresa', 'titulo', 'tipo', 'formato', 'red_social', 'copy', 'fecha', 'responsable', 'version', 'comentarios', 'estado', 'archivo_file', 'campana_id', 'publicacion_id', 'created_by', 'created_at', 'updated_at'],
  compromisos:  ['id', 'concepto', 'tipo', 'monto', 'categoria', 'proyecto_id', 'vencimiento', 'estado', 'notas', 'created_by', 'created_at', 'updated_at'],
  caja_chica:   ['id', 'project_id', 'fecha', 'concepto', 'tipo', 'monto', 'categoria', 'comprobante_file', 'estado', 'notas', 'created_by', 'created_at', 'updated_at'],
  salidas_material: ['id', 'project_id', 'item_id', 'item_name', 'cantidad', 'unidad', 'actividad', 'area', 'fecha', 'notas', 'created_by', 'created_at', 'updated_at'],
  compras:      ['id', 'project_id', 'descripcion', 'cantidad', 'proveedor', 'monto', 'estado', 'fecha_solicitud', 'fecha_entrega', 'aprobado_por', 'encargado', 'observaciones', 'observacion_file', 'factura_file', 'notas', 'created_by', 'created_at', 'updated_at'],
  obra_resumen: ['id', 'project_id', 'avance_pct', 'presupuesto', 'notas', 'updated_by', 'updated_at'],
  lic_competidores: ['id', 'licitacion_id', 'nombre', 'monto', 'resultado', 'notas', 'created_by', 'created_at'],
  proyecto_costos: ['id', 'project_id', 'rubro', 'concepto', 'monto', 'fecha', 'proveedor', 'comprobante_file', 'notas', 'created_by', 'created_at', 'updated_at'],
  cuadrilla:    ['id', 'project_id', 'nombre', 'cargo', 'salario_dia', 'valor_hora_extra', 'foto_file', 'grupo_id', 'activo', 'created_by', 'created_at', 'updated_at'],
  cuadrilla_grupos: ['id', 'project_id', 'nombre', 'capataz', 'color', 'notas', 'created_by', 'created_at', 'updated_at'],
  asistencia:   ['id', 'project_id', 'trabajador_id', 'fecha', 'estado', 'hora_entrada', 'hora_salida', 'horas_extra', 'notas', 'created_by', 'created_at', 'updated_at'],
  pp_inventario:   ['id', 'producto', 'marca', 'color', 'codigo', 'categoria', 'cantidad', 'unidad', 'costo', 'precio', 'min_stock', 'foto_file', 'notas', 'created_by', 'created_at', 'updated_at'],
  pp_ordenes:      ['id', 'fecha', 'numero', 'proveedor', 'producto', 'cantidad', 'costo_unitario', 'total', 'estado', 'item_id', 'stock_aplicado', 'notas', 'created_by', 'created_at', 'updated_at'],
  pp_eventos:      ['id', 'fecha', 'hora', 'titulo', 'tipo', 'color', 'notas', 'created_by', 'created_at', 'updated_at'],
  pp_clientes:     ['id', 'nombre', 'empresa', 'telefono', 'email', 'direccion', 'ruc', 'tipo', 'notas', 'prioridad', 'tipo_lead', 'proyecto', 'contacto', 'cargo', 'estado', 'created_by', 'created_at', 'updated_at'],
  pp_visitas:      ['id', 'fecha', 'hora', 'titulo', 'cliente', 'cliente_id', 'responsable', 'motivo', 'estado', 'lugar', 'reporte_file', 'notas', 'created_by', 'created_at', 'updated_at'],
  pp_leads:        ['id', 'cliente', 'prioridad', 'tipo', 'proyecto', 'contacto', 'cargo', 'telefono', 'email', 'estado', 'notas', 'created_by', 'created_at', 'updated_at'],
  pp_cotizaciones: ['id', 'fecha', 'numero', 'cliente', 'cliente_id', 'descripcion', 'monto', 'estado', 'notas', 'created_by', 'created_at', 'updated_at'],
  pp_notas:        ['id', 'cliente_id', 'texto', 'file_id', 'created_by', 'created_at', 'updated_at']
};

// ── Control de acceso por módulo (lectura y escritura) ──
// Qué roles pueden ver/usar cada módulo sensible. admin ve todo.
const MODULE_ROLES = {
  conta: ['admin', 'contador'],
  licit: ['admin', 'licitaciones'],  // rol propio; el supervisor solo opera logística
  mkt:   ['admin', 'mercadeo'],
  paintpro: ['admin', 'paintpro']
};
const TABLE_MODULE = {
  cuentas: 'conta', asientos: 'conta', movimientos: 'conta', compromisos: 'conta', gastos_mensuales: 'conta',
  licitaciones: 'licit',
  lic_competidores: 'licit',
  campanas: 'mkt', publicaciones: 'mkt', mercadeo_tareas: 'mkt', mkt_piezas: 'mkt', mkt_push: 'mkt', mkt_efemerides: 'mkt', mkt_biblioteca: 'mkt',
  pp_inventario: 'paintpro', pp_ordenes: 'paintpro', pp_eventos: 'paintpro', pp_clientes: 'paintpro', pp_visitas: 'paintpro', pp_leads: 'paintpro', pp_cotizaciones: 'paintpro', pp_notas: 'paintpro'
};
const SCOPE_MODULE = { asiento: 'conta', licitacion: 'licit', campana: 'mkt', mercadeo: 'mkt', paintpro: 'paintpro' };
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

function isFullAdmin(user) {
  return !!user && user.role === 'admin' && !(user.restrict_mods && String(user.restrict_mods).trim());
}
// Tablas financieras/confidenciales del proyecto: los supervisores no las ven ni editan.
// (Contabilidad, licitaciones y mercadeo ya quedan fuera por módulo en roleCan.)
const FINANZAS_PROYECTO = new Set(['caja_chica', 'compras', 'proyecto_costos', 'obra_resumen', 'cuadrilla', 'cuadrilla_grupos', 'asistencia']);
function supervisorBloqueado(table, user) {
  return !!user && user.role === 'supervisor' && FINANZAS_PROYECTO.has(table);
}

function roleCan(module, user) {
  if (!module) return true;               // tabla no restringida
  if (!user) return false;
  // Restricción por usuario: oculta el módulo aunque sea admin.
  const blocked = String(user.restrict_mods || '').split(',').map(s => s.trim()).filter(Boolean);
  if (blocked.includes(module)) return false;
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
// NOTIFICACIONES POR WHATSAPP (mensajes de chat)
// ============================================================
// Configuración por variables de entorno (Railway):
//   WHATSAPP_PROVIDER = 'twilio' | 'meta' | 'dry'  (default: 'dry' = no envía, solo log)
//   Twilio: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM (ej: +14155238886)
//   Meta:   WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_TEMPLATE (plantilla aprobada), WHATSAPP_LANG (ej: es)
const WA_PROVIDER = (process.env.WHATSAPP_PROVIDER || 'dry').toLowerCase();
const WA_COOLDOWN_MS = 60 * 1000;       // máx. 1 aviso por sala por minuto (anti-spam)
const _waLastByRoom = new Map();

function waRoomLabel(room) {
  const fixed = { general: 'Chat general', inventario: 'Inventario', rutas: 'Rutas',
                  contabilidad: 'Contabilidad', licitaciones: 'Licitaciones', mercadeo: 'Mercadeo' };
  if (fixed[room]) return fixed[room];
  if (room && room.indexOf('proyecto:') === 0) {
    const p = db.prepare('SELECT name FROM projects WHERE id = ?').get(room.slice(9));
    return p ? p.name : 'Proyecto';
  }
  return 'Chat';
}

// Todos los usuarios activos con teléfono y opt-in.
function waOptinUsers() {
  return db.prepare(
    "SELECT id, name, phone, role, restrict_mods FROM profiles " +
    "WHERE status = 'active' AND wa_optin = 1 AND phone IS NOT NULL AND TRIM(phone) <> ''"
  ).all();
}
// Miembros de una sala (canal/proyecto) dentro de un conjunto de usuarios.
function waMembers(room, users) {
  const mod = chatRoomModule(room);
  if (mod) {
    const roles = MODULE_ROLES[mod] || [];
    return users.filter(u => {
      const blocked = String(u.restrict_mods || '').split(',').map(s => s.trim()).filter(Boolean);
      return roles.includes(u.role) && !blocked.includes(mod);
    });
  }
  if (room && room.indexOf('proyecto:') === 0) {
    const proj = db.prepare('SELECT engineer_id FROM projects WHERE id = ?').get(room.slice(9));
    return users.filter(u => u.role === 'admin' || u.role === 'supervisor' || (proj && u.id === proj.engineer_id));
  }
  return users; // salas abiertas (general, inventario, rutas): todos
}
// Destinatarios del aviso automático de un mensaje en `room` (excluye al autor).
function waRecipients(room, senderId) {
  return waMembers(room, waOptinUsers()).filter(u => u.id !== senderId);
}

// Normaliza un número a E.164: "+" seguido solo de dígitos (quita espacios, guiones, etc.).
function waE164(x) {
  const d = String(x || '').replace(/[^\d]/g, '');
  return d ? '+' + d : '';
}
async function waSendTwilio(phone, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !tok || !from) throw new Error('Faltan credenciales de Twilio');
  const to = waE164(phone), fromN = waE164(from);
  if (!to) throw new Error('Teléfono del destinatario inválido: ' + phone);
  const params = new URLSearchParams({ From: `whatsapp:${fromN}`, To: `whatsapp:${to}`, Body: body });
  const auth = Buffer.from(`${sid}:${tok}`).toString('base64');
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });
  if (!r.ok) throw new Error('Twilio HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
}

async function waSendMeta(phone, name, area) {
  const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_ID;
  const tpl = process.env.WHATSAPP_TEMPLATE, lang = process.env.WHATSAPP_LANG || 'es';
  if (!token || !phoneId || !tpl) throw new Error('Faltan credenciales/plantilla de Meta');
  const to = String(phone).replace(/[^\d]/g, '');
  const payload = {
    messaging_product: 'whatsapp', to, type: 'template',
    template: { name: tpl, language: { code: lang },
      components: [{ type: 'body', parameters: [{ type: 'text', text: name }, { type: 'text', text: area }] }] }
  };
  const r = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error('Meta HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
}

// Envía un texto libre a un número (para los envíos manuales del admin).
async function waSendMetaText(phone, text) {
  const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) throw new Error('Faltan credenciales de Meta');
  const to = String(phone).replace(/[^\d]/g, '');
  const r = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
  });
  if (!r.ok) throw new Error('Meta HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
}
async function waSendText(phone, text) {
  if (WA_PROVIDER === 'twilio') return waSendTwilio(phone, text);
  if (WA_PROVIDER === 'meta')   return waSendMetaText(phone, text);
  console.log(`[WhatsApp:dry] enviaría a ${phone}: ${text}`);
}

// Dispara los avisos de WhatsApp para un mensaje recién insertado (no bloquea).
function notifyWhatsApp(msg) {
  try {
    const room = msg.room || 'general';
    const now = Date.now();
    const last = _waLastByRoom.get(room) || 0;
    if (now - last < WA_COOLDOWN_MS) return;   // anti-spam por sala
    const recips = waRecipients(room, msg.user_id);
    if (!recips.length) return;
    _waLastByRoom.set(room, now);
    const senderName = (db.prepare('SELECT name FROM profiles WHERE id = ?').get(msg.user_id) || {}).name || 'Alguien';
    const area = waRoomLabel(room);
    const preview = msg.content ? String(msg.content).slice(0, 160) : '(foto)';
    const body = `*ObraControl CMI*\n${senderName} escribió en *${area}*:\n${preview}`;
    recips.forEach(u => {
      const p = String(u.phone).trim();
      if (WA_PROVIDER === 'twilio') {
        waSendTwilio(p, body).catch(e => console.error('WhatsApp(Twilio) a', p, '-', e.message));
      } else if (WA_PROVIDER === 'meta') {
        waSendMeta(p, senderName, area).catch(e => console.error('WhatsApp(Meta) a', p, '-', e.message));
      } else {
        console.log(`[WhatsApp:dry] avisaría a ${u.name} (${p}) · ${area}: ${preview}`);
      }
    });
  } catch (e) { console.error('notifyWhatsApp:', e.message); }
}

// ============================================================
// AUTENTICACIÓN
// ============================================================
function userFromToken(token) {
  if (!token) return null;
  let decoded;
  try { decoded = jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
  return db.prepare('SELECT id, email, name, role, status, restrict_mods FROM profiles WHERE id = ?').get(decoded.sub) || null;
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
  if (!isFullAdmin(u)) return res.status(403).json({ error: { message: 'Solo el administrador principal' } });
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
  if (!isFullAdmin(u)) return res.status(403).json({ error: { message: 'Solo el administrador principal' } });
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
  if (!isFullAdmin(u)) return res.status(403).json({ error: { message: 'Solo el administrador principal' } });
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

// Admin limpia todos los mensajes del chat general.
app.post('/api/admin/clear-chat', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: { message: 'No autenticado' } });
  if (!isFullAdmin(u)) return res.status(403).json({ error: { message: 'Solo el administrador principal' } });
  const count = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE project_id IS NULL').get().c;
  db.prepare('DELETE FROM messages WHERE project_id IS NULL').run();
  broadcast({ table: 'messages', eventType: 'CLEAR', new: null, old: null });
  res.json({ data: { deleted: count }, error: null });
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
    case 'vehiculos':
    case 'combustible':
    case 'kilometraje':
      return op === 'delete' ? user.role === 'admin' : true; // registrar/editar: cualquier activo; borrar: admin
    case 'items':
      return true;
    case 'transfers':
      return op === 'insert';
    case 'equipo_movs':
      return op === 'delete' ? user.role === 'admin' : true; // crear/editar: cualquier activo; borrar: admin
    case 'salidas_material':
      return op === 'delete' ? user.role === 'admin' : true; // logística de material: cualquier activo; borrar: admin
    case 'caja_chica':
      if (user.role === 'supervisor') return false; // confidencial para supervisores
      // El ingeniero que lleva el proyecto administra su caja chica (incl. borrar para corregir)
      return op === 'delete' ? (user.role === 'admin' || user.role === 'engineer') : true;
    case 'compras':
    case 'proyecto_costos':
      if (user.role === 'supervisor') return false; // financiero del proyecto: confidencial para supervisores
      return op === 'delete' ? user.role === 'admin' : true; // registrar/editar: cualquier activo; borrar: admin
    case 'cuadrilla':
    case 'cuadrilla_grupos':
    case 'asistencia':
      if (user.role === 'supervisor') return false; // planilla: confidencial para supervisores
      // La maneja el ingeniero del proyecto (y admin)
      return op === 'delete' ? (user.role === 'admin' || user.role === 'engineer') : true;
    case 'obra_resumen':
      if (user.role === 'supervisor') return false; // presupuesto: confidencial para supervisores
      return op !== 'delete'; // crear/actualizar: cualquier activo; no se borra
    case 'messages':
      if (op !== 'insert') return false;
      return roleCan(chatRoomModule(values && values.room), user); // sala restringida → rol del módulo
    case 'profiles': {
      if (op !== 'update') return false;
      const keys = Object.keys(values || {});
      const touchesPriv = keys.includes('role') || keys.includes('status') || keys.includes('restrict_mods');
      if (touchesPriv) return isFullAdmin(user); // rol/estado/permisos: solo Admin 1 (admin sin restricciones)
      const idf = (filters || []).find(f => f.col === 'id');
      return user.role === 'admin' || (idf && idf.val === user.id); // nombre propio
    }
    // ── Contabilidad ──
    case 'cuentas':
    case 'compromisos':
    case 'gastos_mensuales':
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
    case 'lic_competidores':
      return roleCan('licit', user); // competidores: admin + rol licitaciones (crear/editar/borrar)
    // ── Mercadeo ──
    case 'campanas':
    case 'publicaciones':
    case 'mercadeo_tareas':
    case 'mkt_piezas':
    case 'mkt_push':
    case 'mkt_efemerides':
    case 'mkt_biblioteca':
      return roleCan('mkt', user);
    // ── Paint Pro ──
    case 'pp_inventario':
    case 'pp_ordenes':
    case 'pp_eventos':
    case 'pp_clientes':
    case 'pp_visitas':
    case 'pp_leads':
    case 'pp_cotizaciones':
    case 'pp_notas':
      return roleCan('paintpro', user);
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
    const op = f.op || 'eq';
    if (op === 'not.in') {
      const vals = typeof f.val === 'string' ? f.val.replace(/^\(|\)$/g,'').split(',').map(s=>s.trim().replace(/^["']|["']$/g,'')) : (Array.isArray(f.val) ? f.val : []);
      if (vals.length) { where.push(`"${f.col}" NOT IN (${vals.map(()=>'?').join(',')})`); params.push(...vals); }
    } else if (op === 'in') {
      const vals = Array.isArray(f.val) ? f.val : [];
      if (vals.length) { where.push(`"${f.col}" IN (${vals.map(()=>'?').join(',')})`); params.push(...vals); }
    } else if (op === 'neq') {
      where.push(`"${f.col}" != ?`); params.push(f.val);
    } else if (f.val === null) { where.push(`"${f.col}" IS NULL`); }
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
  if (table === 'messages') notifyWhatsApp(row);   // aviso por WhatsApp a los miembros del canal
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
  if (table === 'files' && !((req.body.filters || []).some(f => f.col === 'scope')))
    return res.status(403).json({ data: null, error: { message: 'Falta scope' } });
  if (table === 'messages' && !((req.body.filters || []).some(f => f.col === 'room')))
    return res.status(400).json({ data: null, error: { message: 'Falta la sala del chat' } });
  if (!roleCan(module, u)) return res.status(403).json({ data: null, error: { message: 'No autorizado' } });
  if (supervisorBloqueado(table, u)) return res.status(403).json({ data: null, error: { message: 'Información confidencial' } });
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

// Envío manual de mensajes por WhatsApp a los miembros de un canal/proyecto,
// a todos, o a personas específicas. Pueden enviar admin, supervisor e ingenieros.
app.post('/api/wa-send', async (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ data: null, error: { message: 'No autenticado' } });
  if (u.status !== 'active') return res.status(403).json({ data: null, error: { message: 'Cuenta no activa' } });
  if (!['admin', 'supervisor', 'engineer'].includes(u.role))
    return res.status(403).json({ data: null, error: { message: 'No autorizado para enviar avisos' } });
  const { scope, room, userIds, text } = req.body || {};
  const msg = String(text || '').trim();
  if (!msg) return res.json({ data: null, error: { message: 'Escribe un mensaje' } });

  // Prueba a uno mismo: sirve para verificar que el envío desde la app funciona.
  if (scope === 'test') {
    const me = db.prepare('SELECT id, name, phone FROM profiles WHERE id = ?').get(u.id);
    if (!me || !me.phone || !String(me.phone).trim())
      return res.json({ data: null, error: { message: 'Primero pon tu teléfono en Mi Perfil' } });
    const body = `*ObraControl CMI* — Prueba de WhatsApp. Si ves esto, el envío desde la app funciona. ✅`;
    try { await waSendText(String(me.phone).trim(), body); return res.json({ data: { total: 1, sent: 1, failed: 0, dry: WA_PROVIDER === 'dry' }, error: null }); }
    catch (e) { console.error('wa-send test:', e.message); return res.json({ data: null, error: { message: 'Twilio: ' + e.message } }); }
  }

  const base = waOptinUsers();
  let list;
  if (scope === 'all') list = base;
  else if (scope === 'users') { const set = new Set(userIds || []); list = base.filter(x => set.has(x.id)); }
  else if (scope === 'room') {
    if (!room) return res.json({ data: null, error: { message: 'Falta el canal' } });
    const mod = chatRoomModule(room);
    if (mod && !roleCan(mod, u)) return res.status(403).json({ data: null, error: { message: 'No tienes acceso a ese canal' } });
    list = waMembers(room, base);
  } else return res.json({ data: null, error: { message: 'Destino inválido' } });

  list = list.filter(x => x.id !== u.id);   // no enviárselo a sí mismo
  if (!list.length) return res.json({ data: { total: 0, sent: 0, failed: 0, dry: WA_PROVIDER === 'dry' }, error: null });
  const body = `*ObraControl CMI* — ${u.name || 'Equipo'}:\n${msg}`;
  const results = await Promise.allSettled(list.map(x => waSendText(String(x.phone).trim(), body)));
  const sent = results.filter(r => r.status === 'fulfilled').length;
  results.forEach(r => { if (r.status === 'rejected') console.error('wa-send:', r.reason && r.reason.message); });
  res.json({ data: { total: list.length, sent, failed: list.length - sent, dry: WA_PROVIDER === 'dry' }, error: null });
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
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 100 * 1024 * 1024 } }); // hasta 100MB (permite videos cortos)

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

// ── Vales de equipo: movimiento de stock POR LÍNEA ──────────────────────
// Cada línea del vale guarda en `ap` lo que YA movió en el inventario:
//   { s: id del artículo en el origen, o: origen, d: destino, c: cantidad, asumido?: 1 }
// Al crear o editar, el inventario se ajusta sólo por la DIFERENCIA entre lo ya
// movido y lo que pide el vale: nunca se duplica y, si se quita una línea, se devuelve.
function movParse(txt) { try { const a = JSON.parse(txt || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function movLocName(id) {
  if (id === 'bodega') return 'el Depósito';
  const p = id ? db.prepare('SELECT name FROM projects WHERE id = ?').get(id) : null;
  return p ? p.name : (id || '—');
}
function movItemAt(loc, name, category) {
  return db.prepare('SELECT * FROM items WHERE project_id = ? AND lower(trim(name)) = lower(trim(?)) AND category = ? LIMIT 1').get(loc, name, category);
}
// Artículo de ORIGEN de una línea: por su item_id (si sigue en el origen) o por el nombre escrito.
function movResolveSrc(line, origen) {
  if (!origen || !line) return null;
  const byName = n => db.prepare('SELECT * FROM items WHERE project_id = ? AND lower(trim(name)) = lower(trim(?)) LIMIT 1').get(origen, n) || null;
  let it = line.item_id ? db.prepare('SELECT * FROM items WHERE id = ?').get(line.item_id) : null;
  if (it && it.project_id !== origen) it = byName(it.name);
  const desc = String(line.desc || '').trim();
  if (!it && desc) it = byName(desc);
  return it || null;
}
// Mueve `qty` del artículo srcId a la ubicación dest (qty < 0 = devolver del destino al origen).
function movTransfer(srcId, dest, qty, userId, now, touched) {
  const src = db.prepare('SELECT * FROM items WHERE id = ?').get(srcId);
  if (!src || !qty) return 0;
  const upd = db.prepare('UPDATE items SET quantity = ?, updated_by = ?, updated_at = ? WHERE id = ?');
  const dst = movItemAt(dest, src.name, src.category);
  if (qty < 0) {
    if (!dst) return 0;
    const take = Math.min(-qty, dst.quantity || 0);
    if (take <= 0) return 0;
    upd.run((dst.quantity || 0) - take, userId, now, dst.id);
    upd.run((src.quantity || 0) + take, userId, now, src.id);
    touched.add(dst.id); touched.add(src.id);
    return -take;
  }
  upd.run((src.quantity || 0) - qty, userId, now, src.id);
  touched.add(src.id);
  if (dst) { upd.run((dst.quantity || 0) + qty, userId, now, dst.id); touched.add(dst.id); }
  else {
    const nid = crypto.randomUUID();
    db.prepare('INSERT INTO items (id,name,category,unit,quantity,min_stock,estado,notes,costo,photo_id,project_id,updated_by,updated_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(nid, src.name, src.category, src.unit || '', qty, 0, src.estado || 'OPERATIVA', '', src.costo || 0, src.photo_id || null, dest, userId, now, now);
    touched.add(nid);
  }
  return qty;
}
function broadcastItems(touched) {
  const out = [];
  for (const iid of touched) {
    const r = db.prepare('SELECT * FROM items WHERE id = ?').get(iid);
    if (r) { broadcast({ table: 'items', eventType: 'UPDATE', new: r, old: null }); out.push(r); }
  }
  return out;
}

app.post('/api/mov', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: { message: 'No autenticado' } });
  if (u.status !== 'active') return res.status(403).json({ error: { message: 'Cuenta no activa' } });

  const b = req.body || {};
  const tipo = b.tipo === 'entrada' ? 'entrada' : 'salida';
  const origen = b.origen_id || (tipo === 'salida' ? 'bodega' : '');
  const destino = b.destino_id || (tipo === 'entrada' ? 'bodega' : '');
  const now = new Date().toISOString();

  const existing = b.id ? db.prepare('SELECT * FROM equipo_movs WHERE id = ?').get(b.id) : null;
  if (b.id && !existing) return res.json({ error: { message: 'Vale no encontrado' } });

  // Lo que este vale YA movió (según sus líneas guardadas).
  const prevByKey = new Map(), prevE = new Map();
  for (const l of movParse(existing && existing.items)) {
    const a = l && l.ap;
    if (!a || !a.s || !(a.c > 0)) continue;
    if (!db.prepare('SELECT id FROM items WHERE id = ?').get(a.s)) continue;
    const k = `${a.s}|${a.o}|${a.d}`;
    prevByKey.set(k, (prevByKey.get(k) || 0) + a.c); prevE.set(k, a);
  }

  // Lo que el vale pide ahora: cada línea se resuelve contra el inventario del origen.
  const lines = (Array.isArray(b.items) ? b.items : []).map(l => { const x = { ...(l || {}) }; delete x.ap; return x; });
  const puedeMover = origen && destino && origen !== destino;
  if (puedeMover) for (const l of lines) {
    const cant = Math.round(Number(l.cant) || 0);
    if (cant <= 0) continue;
    const src = movResolveSrc(l, origen);
    if (!src) continue;
    l.item_id = src.id;
    l.ap = { s: src.id, o: origen, d: destino, c: cant };
  }

  // Verifica stock por artículo: si no alcanza, esa parte NO se mueve (queda pendiente) y se avisa.
  const pendientes = [];
  const groups = new Map();
  for (const l of lines) if (l.ap) { const k = `${l.ap.s}|${l.ap.o}|${l.ap.d}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
  for (const [k, ls] of groups) {
    const want = ls.reduce((s, l) => s + l.ap.c, 0), had = prevByKey.get(k) || 0, delta = want - had;
    if (delta <= 0) continue;
    const src = db.prepare('SELECT * FROM items WHERE id = ?').get(ls[0].ap.s);
    const disp = src ? (src.quantity || 0) : 0;
    if (disp >= delta) continue;
    let allow = had;   // se mantiene sólo lo que ya estaba movido
    for (const l of ls) { const c = Math.min(l.ap.c, allow); allow -= c; if (c > 0) l.ap.c = c; else delete l.ap; }
    pendientes.push(`"${src ? src.name : 'artículo'}": hay ${disp} en ${movLocName(origen)}, faltan ${delta - disp}`);
  }

  const wantByKey = new Map(), wantE = new Map();
  for (const l of lines) if (l.ap) { const k = `${l.ap.s}|${l.ap.o}|${l.ap.d}`; wantByKey.set(k, (wantByKey.get(k) || 0) + l.ap.c); wantE.set(k, l.ap); }

  const fields = { tipo, origen_id: origen || null, destino_id: destino || null, items: JSON.stringify(lines), stock_aplicado: wantByKey.size ? 1 : 0 };
  for (const k of MOV_FIELDS) if (k !== 'tipo' && k !== 'origen_id' && k !== 'destino_id') fields[k] = b[k] || '';

  const movId = b.id || crypto.randomUUID();
  const touched = new Set();
  let moved = 0, devuelto = 0;
  try {
    tx(() => {
      if (b.id) {
        const keys = Object.keys(fields);
        db.prepare(`UPDATE equipo_movs SET ${keys.map(k => `"${k}" = ?`).join(',')}, updated_at = ? WHERE id = ?`)
          .run(...keys.map(k => fields[k]), now, b.id);
      } else {
        const keys = ['id', ...Object.keys(fields), 'created_by', 'created_at', 'updated_at'];
        const vals = [movId, ...Object.keys(fields).map(k => fields[k]), u.id, now, now];
        db.prepare(`INSERT INTO equipo_movs (${keys.map(k => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...vals);
      }
      const allKeys = new Set([...prevByKey.keys(), ...wantByKey.keys()]);
      for (const k of allKeys) {   // primero devoluciones (líneas quitadas o reducidas)
        const delta = (wantByKey.get(k) || 0) - (prevByKey.get(k) || 0);
        if (delta < 0) { const e = prevE.get(k); devuelto += -movTransfer(e.s, e.d, delta, u.id, now, touched); }
      }
      for (const k of allKeys) {   // luego traspasos nuevos
        const delta = (wantByKey.get(k) || 0) - (prevByKey.get(k) || 0);
        if (delta > 0) { const e = wantE.get(k); movTransfer(e.s, e.d, delta, u.id, now, touched); moved++; }
      }
    });
  } catch (e) {
    return res.json({ error: { message: e.message || 'No se pudo guardar el vale' } });
  }

  const movRow = db.prepare('SELECT * FROM equipo_movs WHERE id = ?').get(movId);
  broadcast({ table: 'equipo_movs', eventType: b.id ? 'UPDATE' : 'INSERT', new: movRow, old: null });
  const items = broadcastItems(touched);
  res.json({ data: { mov: movRow, items, moved, devuelto, pendientes, lineas: wantByKey.size, yaAplicado: prevByKey.size > 0 && !moved && !devuelto }, error: null });
});

// ── Sincronización de vales existentes con el inventario ──
// Revisa las líneas que nunca movieron stock (sin `ap`) y las traspasa.
// En la primera pasada (asumir = true), si el artículo YA existía en el destino antes de
// empezar, se asume que ese vale sí lo había movido y NO se toca (para no duplicar);
// queda marcado como "asumido" y se puede forzar a mano desde el panel de revisión.
function movSincronizar(asumir, userId) {
  const now = new Date().toISOString();
  const touched = new Set();
  const r = { vales: 0, movidas: 0, asumidas: 0, sinStock: 0, sinCoincidencia: 0 };
  const antes = new Set(db.prepare('SELECT project_id, lower(trim(name)) AS n, category FROM items').all().map(i => `${i.project_id}|${i.n}|${i.category}`));
  for (const v of db.prepare('SELECT * FROM equipo_movs').all()) {
    const origen = v.origen_id || (v.tipo === 'salida' ? 'bodega' : '');
    const destino = v.destino_id || (v.tipo === 'entrada' ? 'bodega' : '');
    if (!origen || !destino || origen === destino) continue;
    const lines = movParse(v.items);
    let cambio = false;
    try {
      tx(() => {
        for (const l of lines) {
          if (!l || l.ap) continue;
          const cant = Math.round(Number(l.cant) || 0);
          if (cant <= 0) continue;
          const src = movResolveSrc(l, origen);
          if (!src) { r.sinCoincidencia++; continue; }
          l.item_id = src.id;
          if (asumir && antes.has(`${destino}|${String(src.name || '').trim().toLowerCase()}|${src.category}`)) {
            l.ap = { s: src.id, o: origen, d: destino, c: cant, asumido: 1 }; r.asumidas++; cambio = true; continue;
          }
          const fresh = db.prepare('SELECT quantity FROM items WHERE id = ?').get(src.id);
          if (!fresh || (fresh.quantity || 0) < cant) { r.sinStock++; continue; }
          movTransfer(src.id, destino, cant, userId, now, touched);
          l.ap = { s: src.id, o: origen, d: destino, c: cant };
          r.movidas++; cambio = true;
        }
        if (cambio) db.prepare('UPDATE equipo_movs SET items = ?, stock_aplicado = 1 WHERE id = ?').run(JSON.stringify(lines), v.id);
      });
    } catch (e) { console.error('[vales] no se pudo sincronizar', v.numero || v.id, e.message); }
    if (cambio) { r.vales++; broadcast({ table: 'equipo_movs', eventType: 'UPDATE', new: db.prepare('SELECT * FROM equipo_movs WHERE id = ?').get(v.id), old: null }); }
  }
  broadcastItems(touched);
  return r;
}

// Estado línea por línea de todos los vales (para el panel de revisión).
app.post('/api/mov/estado', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: { message: 'No autenticado' } });
  const out = [];
  for (const v of db.prepare('SELECT * FROM equipo_movs ORDER BY created_at DESC').all()) {
    const origen = v.origen_id || (v.tipo === 'salida' ? 'bodega' : '');
    const destino = v.destino_id || (v.tipo === 'entrada' ? 'bodega' : '');
    movParse(v.items).forEach((l, idx) => {
      if (!l) return;
      const cant = Math.round(Number(l.cant) || 0);
      if (cant <= 0 && !(l.desc || '').trim()) return;
      let estado, detalle = '';
      if (l.ap && l.ap.asumido) { estado = 'asumido'; detalle = 'Ya existía en el destino: se asumió movido para no duplicar.'; }
      else if (l.ap) { estado = 'movido'; detalle = `${l.ap.c} movido(s)`; }
      else if (!destino || !origen || origen === destino) { estado = 'sin_destino'; detalle = 'El vale no tiene origen/destino válidos.'; }
      else if (cant <= 0) { estado = 'sin_cantidad'; detalle = 'Sin cantidad.'; }
      else {
        const src = movResolveSrc(l, origen);
        if (!src) { estado = 'sin_coincidencia'; detalle = `No hay un artículo con ese nombre en ${movLocName(origen)}.`; }
        else { estado = 'pendiente'; detalle = `Disponible en ${movLocName(origen)}: ${src.quantity || 0}`; }
      }
      out.push({ mov_id: v.id, numero: v.numero, tipo: v.tipo, fecha: v.fecha, idx, desc: l.desc || '', cant, origen, destino, estado, detalle });
    });
  }
  res.json({ data: out, error: null });
});

// Forzar el traspaso de UNA línea (pendiente o asumida). Sólo admin.
app.post('/api/mov/mover-linea', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: { message: 'No autenticado' } });
  if (u.role !== 'admin') return res.status(403).json({ error: { message: 'Sólo el administrador' } });
  const { mov_id, idx } = req.body || {};
  const v = db.prepare('SELECT * FROM equipo_movs WHERE id = ?').get(mov_id);
  if (!v) return res.json({ error: { message: 'Vale no encontrado' } });
  const origen = v.origen_id || (v.tipo === 'salida' ? 'bodega' : '');
  const destino = v.destino_id || (v.tipo === 'entrada' ? 'bodega' : '');
  if (!origen || !destino || origen === destino) return res.json({ error: { message: 'El vale no tiene origen y destino válidos. Edítalo primero.' } });
  const lines = movParse(v.items);
  const l = lines[idx];
  if (!l) return res.json({ error: { message: 'Línea no encontrada' } });
  if (l.ap && !l.ap.asumido) return res.json({ error: { message: 'Esa línea ya movió su stock.' } });
  const cant = Math.round(Number(l.cant) || 0);
  if (cant <= 0) return res.json({ error: { message: 'La línea no tiene cantidad.' } });
  const src = movResolveSrc(l, origen);
  if (!src) return res.json({ error: { message: `No hay un artículo "${l.desc}" en ${movLocName(origen)}.` } });
  if ((src.quantity || 0) < cant) return res.json({ error: { message: `No hay suficiente "${src.name}" en ${movLocName(origen)} (hay ${src.quantity || 0}, se necesitan ${cant}).` } });
  const now = new Date().toISOString();
  const touched = new Set();
  try {
    tx(() => {
      movTransfer(src.id, destino, cant, u.id, now, touched);
      l.item_id = src.id;
      l.ap = { s: src.id, o: origen, d: destino, c: cant };
      db.prepare('UPDATE equipo_movs SET items = ?, stock_aplicado = 1, updated_at = ? WHERE id = ?').run(JSON.stringify(lines), now, v.id);
    });
  } catch (e) { return res.json({ error: { message: e.message } }); }
  broadcast({ table: 'equipo_movs', eventType: 'UPDATE', new: db.prepare('SELECT * FROM equipo_movs WHERE id = ?').get(v.id), old: null });
  broadcastItems(touched);
  res.json({ data: { ok: true, nombre: src.name, cant, destino: movLocName(destino) }, error: null });
});

// Reintentar las líneas pendientes de todos los vales (sin asumir nada). Sólo admin.
app.post('/api/mov/sincronizar', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: { message: 'No autenticado' } });
  if (u.role !== 'admin') return res.status(403).json({ error: { message: 'Sólo el administrador' } });
  res.json({ data: movSincronizar(false, u.id), error: null });
});

// Primera sincronización automática de los vales existentes (una sola vez).
try {
  if (!db.prepare('SELECT value FROM meta WHERE key = ?').get('vales_stock_v2')) {
    const r = movSincronizar(true, null);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('vales_stock_v2', JSON.stringify({ at: new Date().toISOString(), ...r }));
    console.log('[vales] sincronización inicial:', JSON.stringify(r));
  }
} catch (e) { console.error('[vales] sincronización inicial falló:', e.message); }

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
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // El HTML nunca se cachea: el navegador siempre trae la última versión.
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CMI Logistica (SQLite, autónomo) corriendo en el puerto ${PORT}`);
  console.log(`Base de datos: ${DB_PATH}`);
});
