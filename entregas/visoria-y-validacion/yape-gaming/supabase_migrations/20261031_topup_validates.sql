-- UBICACIÓN EN TU REPO: yape-gaming/supabase_migrations/20261031_topup_validates.sql
-- (repositorio: yape-gaming · ruta: supabase_migrations/20261031_topup_validates.sql)
-- Motor de recargas: elegir por variante si ese proveedor se usa para validar.
-- false = "solo recarga": el motor no le pregunta el nombre del jugador,
-- pero sí la usa para recargar (del más barato al más caro).
-- Solo agrega una columna con valor por defecto true: todo sigue igual.
ALTER TABLE public.direct_topup_suppliers
  ADD COLUMN IF NOT EXISTS validates boolean NOT NULL DEFAULT true;

NOTIFY pgrst, 'reload schema';
