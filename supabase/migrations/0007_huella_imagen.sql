-- Huella perceptual de cada imagen (dHash 256 bits en hex) para detectar
-- duplicados por imagen: la misma foto o captura enviada dos veces, aunque se
-- haya recomprimido. La calcula el backend al subir el archivo.

alter table public.evidencias add column if not exists huella text;

-- REVERSA:
--   alter table public.evidencias drop column huella;
