-- ============================================================
-- CMI Construction Corp - Supabase Database Schema
-- Run this in Supabase SQL Editor (supabase.com → SQL Editor)
-- ============================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ============================================================
-- TABLES
-- ============================================================

-- User profiles (linked to Supabase auth.users)
create table public.profiles (
  id uuid references auth.users on delete cascade not null primary key,
  name text,
  role text not null default 'engineer' check (role in ('admin', 'engineer')),
  created_at timestamptz default now() not null
);

-- Projects / Sites
create table public.projects (
  id text primary key,
  name text not null,
  address text,
  supervisor text,
  engineer_id uuid references public.profiles(id),
  color text default '#9B1B30',
  status text default 'active',
  notes text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

-- Inventory items
create table public.items (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  category text not null,
  unit text,
  quantity integer default 0,
  min_stock integer default 0,
  estado text default 'OPERATIVA',
  notes text,
  project_id text references public.projects(id) on delete cascade,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz default now() not null,
  created_at timestamptz default now() not null
);

-- Transfer history
create table public.transfers (
  id uuid primary key default uuid_generate_v4(),
  item_name text,
  from_project text references public.projects(id),
  to_project text references public.projects(id),
  quantity integer,
  unit text,
  by_user uuid references public.profiles(id),
  notes text,
  date timestamptz default now() not null
);

-- Truck routes calendar
create table public.rutas (
  id uuid primary key default uuid_generate_v4(),
  date text not null,
  hora text,
  origen text,
  destino text,
  conductor text,
  descripcion text,
  status text default 'pendiente' check (status in ('pendiente','en_ruta','completada')),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz default now() not null,
  created_at timestamptz default now() not null
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.items enable row level security;
alter table public.transfers enable row level security;
alter table public.rutas enable row level security;

-- Helper: is current user an admin?
create or replace function public.is_admin()
returns boolean
language sql security definer stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- PROFILES
create policy "Read all profiles" on public.profiles for select using (auth.role() = 'authenticated');
create policy "Update own profile" on public.profiles for update using (auth.uid() = id);

-- PROJECTS
create policy "Read all projects" on public.projects for select using (auth.role() = 'authenticated');
create policy "Admin insert projects" on public.projects for insert with check (public.is_admin());
create policy "Admin update projects" on public.projects for update using (public.is_admin());
create policy "Admin delete projects" on public.projects for delete using (public.is_admin());

-- ITEMS (engineers can manage inventory)
create policy "Read all items" on public.items for select using (auth.role() = 'authenticated');
create policy "Auth insert items" on public.items for insert with check (auth.role() = 'authenticated');
create policy "Auth update items" on public.items for update using (auth.role() = 'authenticated');
create policy "Auth delete items" on public.items for delete using (auth.role() = 'authenticated');

-- TRANSFERS
create policy "Read all transfers" on public.transfers for select using (auth.role() = 'authenticated');
create policy "Auth insert transfers" on public.transfers for insert with check (auth.role() = 'authenticated');

-- RUTAS
create policy "Read all rutas" on public.rutas for select using (auth.role() = 'authenticated');
create policy "Auth update ruta status" on public.rutas for update using (auth.role() = 'authenticated');
create policy "Admin insert rutas" on public.rutas for insert with check (public.is_admin());
create policy "Admin delete rutas" on public.rutas for delete using (public.is_admin());

-- ============================================================
-- TRIGGER: Auto-create profile on signup
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
as $$
begin
  insert into public.profiles (id, name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    'engineer'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- REALTIME: Enable for all tables
-- ============================================================
alter publication supabase_realtime add table public.projects;
alter publication supabase_realtime add table public.items;
alter publication supabase_realtime add table public.transfers;
alter publication supabase_realtime add table public.rutas;

-- ============================================================
-- INITIAL DATA: CMI Projects
-- ============================================================
insert into public.projects (id, name, address, supervisor, color, status) values
('bodega',          'PATIO (Base Central)',  'Almacen principal - Base CMI',     'GABRIEL', '#9B1B30', 'active'),
('pedro_miguel',    'Pedro Miguel',          'ACP - Pedro Miguel',               'PINO',    '#C62040', 'active'),
('gamboa',          'Gamboa',                'ACP - Gamboa',                     'PINO',    '#7A1526', 'active'),
('corozal',         'Corozal',               'ACP - Corozal',                    'MARTA',   '#C8960C', 'active'),
('monte_esperanza', 'Monte Esperanza',       'ACP - Monte Esperanza (Colon)',    'GABRIEL', '#1D4ED8', 'active'),
('maquinarias',     'Maquinarias',           'PATIO - Area de Maquinarias',      'GABRIEL', '#0F766E', 'active'),
('miraflores',      'Miraflores',            'ACP - Miraflores',                 'PINO',    '#4338CA', 'active'),
('finca',           'Finca',                 'Finca CMI',                        'GABRIEL', '#BE185D', 'active'),
('balboa',          'Balboa',                'ACP - Balboa',                     'MARTA',   '#065F46', 'active'),
('cercas_gatun',    'Cercas Gatun',          'ACP - Gatun',                      'PINO',    '#7C3AED', 'active'),
('potabilizadora',  'Potabilizadora',        'ACP - Potabilizadora',             'GABRIEL', '#B45309', 'active');

-- ============================================================
-- INITIAL DATA: Routes (week of Oct 12-17, 2026)
-- ============================================================
insert into public.rutas (date, hora, origen, destino, conductor, descripcion, status) values
('2026-10-12','07:30','bodega','bodega',       'Gabriel / Martin','Mantenimiento Megapolis GC',         'pendiente'),
('2026-10-12','08:00','bodega','balboa',        'Gabriel / Martin','COHCEZ Material - ACP Balboa MC',   'pendiente'),
('2026-10-12','09:00','balboa','balboa',        'Gabriel / Martin','ACP Balboa Entrega MC',             'pendiente'),
('2026-10-13','07:30','bodega','bodega',        'Gabriel / Martin','Mantenimiento Atrio Mall GC',       'pendiente'),
('2026-10-13','08:00','bodega','balboa',        'Gabriel / Martin','ACP Balboa MC',                     'pendiente'),
('2026-10-13','09:30','bodega','bodega',        'Gabriel / Martin','Compras Discovery',                 'pendiente'),
('2026-10-13','11:00','bodega','bodega',        'Gabriel / Martin','PPG Panama Pacifico MC',            'pendiente'),
('2026-10-13','13:00','bodega','miraflores',    'Gabriel / Martin','Miraflores ACP MC',                 'pendiente'),
('2026-10-14','07:30','bodega','monte_esperanza','Gabriel / Martin','ACP Colon - Monte Esperanza MC',   'pendiente'),
('2026-10-14','09:00','bodega','miraflores',    'Gabriel / Martin','Miraflores ACP MC',                 'pendiente'),
('2026-10-15','07:30','bodega','bodega',        'Gabriel / Martin','ACP Colon - Caseta NC',             'pendiente'),
('2026-10-17','14:00','bodega','bodega',        'Gabriel / Martin','Mantenimiento del Camion y PATIO',  'pendiente');

-- ============================================================
-- AFTER RUNNING THIS SQL:
-- 1. Go to Authentication > Users in Supabase dashboard
-- 2. Create your account (sign up via the app)
-- 3. Then run this to make yourself admin (replace with your real UUID):
--    UPDATE profiles SET role = 'admin' WHERE id = '<your-user-uuid>';
--    OR: UPDATE profiles SET role = 'admin' WHERE name = '<your-email-username>';
-- ============================================================
