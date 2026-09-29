-- Rol por empresa: el rol deja de ser global (usuarios.rol) y pasa a vivir en
-- usuario_empresas, igual que en el frontend SIREGG (una misma persona puede
-- ser Administrador en una empresa y Empleado en otra).
-- super_admin queda como flag de plataforma, separado del rol por empresa.

alter table public.usuarios
  add column es_super_admin boolean not null default false;

alter table public.usuario_empresas
  add column rol text not null default 'empleado'
    check (rol in ('propietario','administrador','supervisor','contador','empleado'));

-- Migrar lo existente.
update public.usuarios set es_super_admin = true where rol = 'super_admin';

update public.usuario_empresas ue
set rol = case u.rol
  when 'empleado' then 'empleado'
  else 'administrador'  -- admin y super_admin
end
from public.usuarios u
where u.id = ue.usuario_id;

-- Un usuario no puede repetirse en la misma empresa.
alter table public.usuario_empresas
  add constraint usuario_empresas_usuario_empresa_key unique (usuario_id, empresa_id);

-- usuarios.rol se conserva de momento para no romper el backend hasta que el
-- codigo lea usuario_empresas.rol. Se elimina en una migracion posterior.

-- REVERSA (por si hace falta deshacer):
--   alter table public.usuario_empresas drop constraint usuario_empresas_usuario_empresa_key;
--   alter table public.usuario_empresas drop column rol;
--   alter table public.usuarios drop column es_super_admin;
