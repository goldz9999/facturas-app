-- UBICACIÓN EN TU REPO: fastapi-gift-cards/supabase_migrations/20261031_visoria_provider.sql
-- (repositorio: fastapi-gift-cards · ruta: supabase_migrations/20261031_visoria_provider.sql)
-- Visoria como proveedor de códigos (compra automática / reposición).
-- Solo agrega una fila a `providers` si todavía no existe; no cambia nada más.
-- Al final muestra el id que quedó: pásalo para mostrar "Visoria" en Inventario.
INSERT INTO public.providers (code, name, base_url, is_active)
SELECT 'visoria', 'Visoria', 'https://api.visoria.digital', true
WHERE NOT EXISTS (SELECT 1 FROM public.providers WHERE code = 'visoria');

SELECT id, code, name, base_url, is_active FROM public.providers WHERE code = 'visoria';
