-- Clientes de prueba (sandbox): sus recargas no llaman a ningún proveedor.
-- Solo agrega una columna con valor por defecto false: los clientes que ya
-- existen siguen funcionando igual.
ALTER TABLE public.dist_clients
  ADD COLUMN IF NOT EXISTS sandbox boolean NOT NULL DEFAULT false;

-- Que la API (PostgREST) vea los cambios de inmediato.
NOTIFY pgrst, 'reload schema';
