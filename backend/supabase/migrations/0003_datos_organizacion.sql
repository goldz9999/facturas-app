-- Datos de la organización que muestra y edita el panel SIREGG
-- (Configuración de empresa): RUC, dirección y moneda. El logo ya existía
-- (empresas.logo_url); faltaba el bucket público donde se sube.

alter table public.empresas
  add column if not exists ruc text
    check (ruc is null or ruc ~ '^[0-9]{11}$'),
  add column if not exists direccion text,
  add column if not exists moneda text not null default 'PEN'
    check (moneda in ('PEN', 'USD'));

-- Bucket de logos (EmpresasService.actualizarLogo). Público: el logo se
-- muestra con su URL directa, sin firmar.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('logos-empresas', 'logos-empresas', true, 3145728,
        array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

-- REVERSA:
--   alter table public.empresas drop column ruc, drop column direccion, drop column moneda;
--   delete from storage.buckets where id = 'logos-empresas';
