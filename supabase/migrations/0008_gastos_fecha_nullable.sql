-- B1: Permitir fecha nula en gastos cuando Gemini no pudo leer la fecha del
-- comprobante. El gasto se guarda con fecha=null y pendiente_revision=true;
-- el flujo de Telegram le pregunta la fecha real al usuario.
ALTER TABLE public.gastos ALTER COLUMN fecha DROP NOT NULL;
