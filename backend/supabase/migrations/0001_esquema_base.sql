-- Esquema base de SIREGG, reconstruido del proyecto Registrodefacturasn8n.
-- Solo estructura (sin datos). Ejecutar en el SQL Editor de un proyecto vacío.
-- RLS activado sin políticas: el backend usa la service-role key, que la omite.

create table public.empresas (
  id bigint generated always as identity primary key,
  nombre text not null,
  activa boolean not null default true,
  creado_en timestamptz not null default now(),
  logo_url text
);

create table public.usuarios (
  id bigint generated always as identity primary key,
  telegram_id bigint unique,
  nombre text,
  rol text not null default 'empleado',
  activo boolean not null default true,
  creado_en timestamptz not null default now(),
  email text unique,
  password_hash text,
  puede_registrar_personal boolean not null default true,
  ultima_empresa_id integer references public.empresas(id)
);

create table public.usuario_empresas (
  id bigint generated always as identity primary key,
  usuario_id bigint not null references public.usuarios(id),
  empresa_id bigint not null references public.empresas(id),
  creado_en timestamptz not null default now()
);

create table public.categorias (
  id bigint generated always as identity primary key,
  nombre text not null,
  activa boolean not null default true,
  creado_en timestamptz not null default now(),
  empresa_id bigint not null references public.empresas(id)
);

create table public.proveedores (
  id bigint generated always as identity primary key,
  nombre text not null,
  categoria_id bigint references public.categorias(id),
  creado_en timestamptz not null default now(),
  categoria_id_sugerida bigint references public.categorias(id),
  es_personal_sugerido boolean,
  ruc text,
  empresa_id bigint not null references public.empresas(id)
);

create table public.pedidos (
  id bigint generated always as identity primary key,
  empresa_id bigint not null references public.empresas(id),
  nombre text not null,
  cliente text,
  presupuesto numeric,
  estado text not null default 'activo'
    check (estado = any (array['activo','finalizado','cancelado'])),
  creado_en timestamptz not null default now(),
  celular varchar check (celular is null or celular ~ '^9[0-9]{8}$'),
  fecha_culminacion date
);

create table public.gastos (
  id bigint generated always as identity primary key,
  usuario_id bigint references public.usuarios(id),
  categoria_id bigint references public.categorias(id),
  proveedor_id bigint references public.proveedores(id),
  es_personal boolean not null default false,
  descripcion text,
  monto numeric not null default 0,
  fecha date not null,
  confianza text,
  pendiente_revision boolean not null default false,
  posible_duplicado_de bigint references public.gastos(id),
  pedido_id bigint,
  empresa_id bigint,
  creado_en timestamptz not null default now(),
  usuario_nombre text,
  constraint fk_gastos_pedido foreign key (pedido_id) references public.pedidos(id),
  constraint fk_gastos_empresa foreign key (empresa_id) references public.empresas(id)
);

create table public.comprobantes (
  id bigint generated always as identity primary key,
  gasto_id bigint not null references public.gastos(id),
  tipo text not null default 'factura',
  numero text,
  empresa_emisora text,
  subtotal numeric,
  igv numeric,
  total numeric,
  fecha_documento date,
  creado_en timestamptz not null default now()
);

create table public.comprobante_items (
  id bigint generated always as identity primary key,
  comprobante_id bigint not null references public.comprobantes(id),
  producto text not null,
  cantidad numeric,
  costo numeric,
  creado_en timestamptz not null default now()
);

create table public.pagos (
  id bigint generated always as identity primary key,
  gasto_id bigint not null references public.gastos(id),
  medio text not null,
  monto numeric not null default 0,
  numero_operacion text,
  fecha timestamptz,
  creado_en timestamptz not null default now()
);

create table public.evidencias (
  id bigint generated always as identity primary key,
  gasto_id bigint not null references public.gastos(id),
  tipo text not null,
  storage_path text not null,
  origen text not null default 'telegram',
  creado_en timestamptz not null default now()
);

create table public.telegram_estado (
  id bigint generated always as identity primary key,
  telegram_id bigint not null unique,
  esperando text not null,
  gasto_id bigint references public.gastos(id),
  expira_en timestamptz not null,
  creado_en timestamptz not null default now()
);

alter table public.empresas          enable row level security;
alter table public.usuarios          enable row level security;
alter table public.usuario_empresas  enable row level security;
alter table public.categorias        enable row level security;
alter table public.proveedores       enable row level security;
alter table public.pedidos           enable row level security;
alter table public.gastos            enable row level security;
alter table public.comprobantes      enable row level security;
alter table public.comprobante_items enable row level security;
alter table public.pagos             enable row level security;
alter table public.evidencias        enable row level security;
alter table public.telegram_estado   enable row level security;

-- Bucket de archivos que usa el backend (BUCKET = 'Facturas').
insert into storage.buckets (id, name, public)
values ('Facturas', 'Facturas', false)
on conflict (id) do nothing;
