-- Datos de prueba para desarrollo. NO ejecutar en producción.
-- Requiere 0001 y 0002 aplicadas. Usuario: lucia@siregg.dev / Siregg123
create extension if not exists pgcrypto with schema extensions;

insert into public.empresas (nombre)
values ('Empresa Demo S.A.C.'), ('Constructora Andina S.A.C.');

insert into public.usuarios (nombre, email, password_hash, rol)
values ('Lucía Ramírez', 'lucia@siregg.dev', extensions.crypt('Siregg123', extensions.gen_salt('bf', 10)), 'admin');

insert into public.usuario_empresas (usuario_id, empresa_id, rol)
select u.id, e.id,
       case e.nombre when 'Empresa Demo S.A.C.' then 'administrador' else 'contador' end
from public.usuarios u, public.empresas e
where u.email = 'lucia@siregg.dev';

insert into public.categorias (empresa_id, nombre)
select e.id, c
from public.empresas e, unnest(array['Materiales','Transporte','Alimentación','Servicios']) as c
where e.nombre = 'Empresa Demo S.A.C.';

insert into public.gastos
  (usuario_id, empresa_id, categoria_id, es_personal, descripcion, monto, fecha, confianza, pendiente_revision, usuario_nombre)
select u.id, e.id,
       (select c.id from public.categorias c where c.empresa_id = e.id and c.nombre = g.cat),
       g.personal, g.descr, g.monto, current_date - g.dias, g.conf, g.pend, u.nombre
from public.empresas e
join public.usuarios u on u.email = 'lucia@siregg.dev'
cross join (values
  ('Materiales',   'Cemento y fierro para almacén', 1240.00, 1,  'alta',  false, false),
  ('Transporte',   'Taxi a reunión',                  28.90, 2,  'alta',  false, false),
  ('Transporte',   'Taxi a reunión (duplicado)',      28.90, 2,  'media', true,  false),
  ('Alimentación', 'Almuerzo de equipo',              96.00, 3,  'media', true,  false),
  ('Servicios',    'Hosting anual',                  389.00, 5,  'alta',  false, false),
  ('Alimentación', 'Almuerzo personal',               32.00, 6,  'alta',  false, true)
) as g(cat, descr, monto, dias, conf, pend, personal)
where e.nombre = 'Empresa Demo S.A.C.';

update public.gastos d
set posible_duplicado_de = o.id
from public.gastos o
where d.descripcion = 'Taxi a reunión (duplicado)'
  and o.descripcion = 'Taxi a reunión'
  and o.empresa_id = d.empresa_id;
