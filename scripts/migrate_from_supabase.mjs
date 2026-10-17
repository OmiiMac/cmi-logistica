// ============================================================
// Migración one-shot: Supabase -> import.json
// Uso (PowerShell, desde la carpeta del proyecto):
//   $env:SB_URL="https://TU_PROYECTO.supabase.co"
//   $env:SB_KEY="sb_secret_...."      # service_role / secret key
//   node scripts/migrate_from_supabase.mjs
//
// Genera ./import.json con projects, items, rutas, transfers y profiles.
// El servidor lo importa en el PRIMER arranque si la base está vacía.
// Las contraseñas NO se migran: cada usuario se registra con su mismo
// email y queda enganchado a su perfil (id, rol y estado) original.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

const URL = process.env.SB_URL;
const KEY = process.env.SB_KEY;
const OUT = process.env.OUT || path.join(process.cwd(), 'import.json');

if (!URL || !KEY) {
  console.error('Falta SB_URL y/o SB_KEY en el entorno.');
  process.exit(1);
}
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };

async function rest(table) {
  const r = await fetch(`${URL}/rest/v1/${table}?select=*`, { headers: H });
  if (!r.ok) {
    if (r.status === 404) return []; // tabla inexistente (p.ej. messages)
    throw new Error(`${table}: ${r.status} ${await r.text()}`);
  }
  return r.json();
}

async function authUsers() {
  const r = await fetch(`${URL}/auth/v1/admin/users?per_page=1000`, { headers: H });
  if (!r.ok) return [];
  const j = await r.json();
  return j.users || j || [];
}

const [profiles, projects, items, transfers, rutas, users] = await Promise.all([
  rest('profiles'), rest('projects'), rest('items'), rest('transfers'), rest('rutas'), authUsers()
]);

// Garantizar email en cada perfil (fallback desde auth.users por id)
const emailById = Object.fromEntries(users.map(u => [u.id, u.email]));
for (const p of profiles) {
  if (!p.email && emailById[p.id]) p.email = emailById[p.id];
}

const dump = { exported_at: new Date().toISOString(), profiles, projects, items, transfers, rutas };
fs.writeFileSync(OUT, JSON.stringify(dump, null, 2));

console.log('Exportado a', OUT);
console.log(`  profiles:  ${profiles.length}`);
console.log(`  projects:  ${projects.length}`);
console.log(`  items:     ${items.length}`);
console.log(`  transfers: ${transfers.length}`);
console.log(`  rutas:     ${rutas.length}`);
console.log('\nPerfiles (se enganchan al registrarse con el mismo email):');
profiles.forEach(p => console.log(`  - ${p.email || '(sin email)'}  [${p.role}/${p.status}]`));
