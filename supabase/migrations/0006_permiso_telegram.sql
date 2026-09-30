-- Cuentas autorizadas del bot de Telegram: el propietario decide quién más
-- puede vincular o quitar IDs de Telegram (además de él mismo).

alter table public.usuarios
  add column if not exists puede_gestionar_telegram boolean not null default false;

-- REVERSA:
--   alter table public.usuarios drop column puede_gestionar_telegram;
