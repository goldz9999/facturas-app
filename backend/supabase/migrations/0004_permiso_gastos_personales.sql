-- Gastos personales: el propietario decide quién puede registrarlos.
-- El propietario (y el super admin) siempre puede; el resto de roles, no,
-- salvo que un propietario se lo active (usuarios.puede_registrar_personal).

alter table public.usuarios alter column puede_registrar_personal set default false;

-- Hasta ahora el valor por defecto era true: se apaga para todos y cada
-- propietario lo vuelve a activar a quien corresponda.
update public.usuarios u
set puede_registrar_personal = false
where not u.es_super_admin
  and not exists (
    select 1 from public.usuario_empresas ue
    where ue.usuario_id = u.id and ue.rol = 'propietario'
  );

-- REVERSA:
--   alter table public.usuarios alter column puede_registrar_personal set default true;
