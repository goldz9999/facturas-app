-- Datos iniciales para empezar de cero (SIN gastos ni categorías de ejemplo).
-- Requiere 0001 y 0002 aplicadas. Cambia el nombre, el correo y la contraseña antes de ejecutarlo.
create extension if not exists pgcrypto with schema extensions;

insert into public.empresas (nombre) values ('Mi organización');

insert into public.usuarios (nombre, email, password_hash, rol)
values ('Tu nombre', 'tu-correo@ejemplo.com', extensions.crypt('cambia-esta-clave', extensions.gen_salt('bf', 10)), 'admin');

insert into public.usuario_empresas (usuario_id, empresa_id, rol)
select u.id, e.id, 'propietario'
from public.usuarios u, public.empresas e
where u.email = 'tu-correo@ejemplo.com' and e.nombre = 'Mi organización';
