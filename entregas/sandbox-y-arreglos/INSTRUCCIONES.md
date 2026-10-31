# Sandbox para TISI, notificaciones y 99Cards

Todo parte de los zips que me pasaste hoy. Cada carpeta de esta entrega tiene el nombre de su repo, y dentro cada archivo está en la misma ruta que en ese repo.

## 1. Notificaciones "Stock bajo: Steam…" — backend-yape

### Por qué solo algunas
Los avisos salen de dos servicios distintos:

| Venta por | Servicio que avisa | Título |
|---|---|---|
| Eneba, G2A, Falabella, reposición | fastapi-gift-cards | `⚠️ IMVU 25 USD: Stock bajo` (ya estaba bien) |
| Yape (pines) | **backend-yape** | `⚠️ Stock bajo: Steam 40 Soles` (el viejo) |

backend-yape tiene su propia copia del aviso (`app/main.py`, función `check_and_notify_stock`) con el título viejo. Por eso todos los Steam, que se venden por Yape, salían al revés.

### Archivos

| Archivo | Qué hacer |
|---|---|
| `backend-yape/app/main.py` | Reemplazar (solo cambia la línea del título) |
| `fastapi-gift-cards/app/services/inventory_stock_alert_service.py` | Reemplazar |
| `fastapi-gift-cards/app/services/eneba_declared_stock_service.py` | Reemplazar |

**Qué cambia en cada uno:**
- **backend-yape `app/main.py`:** el título pasa a `⚠️ {producto}: Stock bajo`.
- **`inventory_stock_alert_service.py`:** el aviso agrupado (varios productos a la vez) pasa a `⚠️ Steam 4, PSN 1 y 2 más: Stock bajo`. La lista completa sigue en el cuerpo.
- **`eneba_declared_stock_service.py`:** `⚠️ {producto}: Stock insuficiente`, para que siga el mismo orden.

## 2. 99Cards en "En recuperación" — fastapi-gift-cards

| Archivo | Qué hacer |
|---|---|
| `fastapi-gift-cards/app/core/provider_http_monitor.py` | Reemplazar |
| `fastapi-gift-cards/tests/test_provider_http_monitor_cardone.py` | Nuevo (pruebas) |

**Qué pasaba:**
- 99Cards cifra cada mensaje con un POST a `/encryAndDencry` antes de pedir el token y antes de enviar la orden.
- El sistema tomaba ese POST como si fuera el envío de la orden. Si respondía 502, marcaba la orden como "no se sabe si se creó":
  - la mandaba a **En recuperación**;
  - bloqueaba el producto 24 h;
  - no probaba el siguiente proveedor.

**Ahora:**
- Si falla el cifrado antes de la orden, se toma como "no se envió": pasa al siguiente proveedor sin crear ninguna fila.
- Si la orden sí salió y falla lo que viene después, sigue quedando en recuperación, porque pudo crearse.

**Las 3 filas que ya tienes** (Steam 40 Soles, PSN 1 USD, Roblox 4 USD):
1. Confirma en el portal de 99Cards que no hay órdenes a esas horas.
2. Bórralas con la papelera.

## 3. Sandbox para TISI — codes-hub + panel

### Cómo funciona
TISI recibe credenciales de un **cliente de prueba** aparte:
- Usa la misma URL y las mismas rutas que en producción.
- Sus recargas las resuelve un motor simulado: no llaman a yape-gaming ni a ningún proveedor, y no llega nada al juego.
- No mandan avisos de Telegram.
- El saldo, los precios, el `request_id` repetido y la validación de un solo uso funcionan igual que en producción. El saldo es el que tú le cargues al cliente de prueba.

**El resultado lo decide el final del ID de jugador:**

| Termina en | Resultado |
|---|---|
| `0002` | `failed` y se devuelve el saldo |
| `0003` | `processing`, y `completed` al consultarla 30 s después |
| `0004` | `under_review`; la cierras tú en el panel |
| `0005` | `processing`, y `failed` (con devolución) 30 s después |
| `0006` | el proveedor "no responde": `processing` y luego `completed` |
| `0008` | validar responde 503 (proveedor caído) |
| `0009` | validar responde `valid: false` (la cuenta no existe) |
| cualquier otro | `completed` |

- `POST /v1/orders` (compra de códigos) responde `403 sandbox_not_supported` con las credenciales de prueba, porque entrega códigos reales del inventario.
- Un cliente no se puede pasar de prueba a real ni al revés.

### Base de datos (Supabase → SQL Editor)
Ejecuta `codes-hub/migrations/009_dist_sandbox.sql`.

- Agrega a `dist_clients` una sola columna, `sandbox`, con valor por defecto `false`.
- Los clientes existentes quedan como reales y siguen igual.
- Se puede ejecutar más de una vez.
- La probé sobre las migraciones 001 a 008 en un Postgres real, dos veces, sin errores.

### Archivos

**codes-hub:**

| Archivo | Qué hacer |
|---|---|
| `migrations/009_dist_sandbox.sql` | Nuevo (el de arriba) |
| `app/services/sandbox_engine.py` | Nuevo: el motor simulado |
| `app/services/topup_service.py` | Reemplazar |
| `app/services/clients_repo.py` | Reemplazar |
| `app/schemas/clients.py` | Reemplazar |
| `app/routes/public.py` | Reemplazar |
| `README.md` | Reemplazar (sección "Clientes de prueba") |
| `postman/build_client_collection.py` | Reemplazar |
| `postman/Schedaup_API_Cliente_Sandbox.postman_collection.json` | Nuevo: la colección para TISI |
| `tests/test_sandbox.py` | Nuevo (pruebas) |
| `tests/test_client_auth.py` | Reemplazar (la prueba de `/v1/ping` ahora espera `sandbox`) |

**Panel (digital-wallet-manager, carpeta `src/features/distribucion/`):**

| Archivo | Qué hacer |
|---|---|
| `components/CreateClientDialog.tsx` | Reemplazar: interruptor **Cliente de prueba (sandbox)** |
| `components/CreateClientDialog.test.tsx` | Nuevo (pruebas) |
| `DistribucionPage.tsx` | Reemplazar: etiqueta violeta **Prueba** en la lista y en el detalle |
| `types.ts` | Reemplazar |
| `api.ts` | Reemplazar |

### Orden
1. Ejecuta la migración 009.
2. Haz deploy de codes-hub y del panel.

### Darle el sandbox a TISI
1. **Distribución → Nuevo cliente**: código `tisi_test`, nombre `TISI (prueba)`, sus IPs, y activa **Cliente de prueba**. Copia las credenciales.
2. **Productos → Canales**: asígnale las mismas recargas que a TISI, con su precio.
3. **Saldo**: cárgale saldo de prueba, por ejemplo 100.
4. Mándale a TISI:
   - las credenciales de prueba;
   - `GUIA-SANDBOX-TISI.md`;
   - `codes-hub/postman/Schedaup_API_Cliente_Sandbox.postman_collection.json`.
5. Cuando termine de probar, dale las credenciales reales. Puedes suspender `tisi_test` desde el panel.

## Pruebas

| Repo | Comando | Resultado |
|---|---|---|
| codes-hub | `python -m pytest` | 124 pasan (14 nuevas de sandbox) |
| Panel | `npx vitest run` | 41 pasan (2 nuevas) |
| Panel | `npx tsc --noEmit -p tsconfig.app.json` | Los mismos 11 errores que ya tenías, ninguno nuevo |
| fastapi-gift-cards | `SUPABASE_URL=http://x SUPABASE_SERVICE_KEY=x python -m pytest tests/test_provider_http_monitor_cardone.py` | 6 pasan; con el archivo anterior fallan 3 |

**Lo que no se probó:**
- La colección de Postman contra el servidor real.
- La pantalla del panel en el navegador.
