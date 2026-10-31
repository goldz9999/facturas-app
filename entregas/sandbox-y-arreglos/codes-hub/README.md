# codes-hub (Schedaup API)

API multitenant de distribución de códigos digitales (FastAPI + Supabase), desplegada como servicio independiente en Railway.

## Estructura

```
app/
  core/        # configuración y clientes (Supabase, Redis)
  routes/      # endpoints (health, /v1/*, /admin/dist/*)
  services/    # lógica de negocio
  middleware/  # auth Basic + IP whitelist, rate limiting
tests/
```

## Probar en local con datos ficticios (Docker + Postman)

Levanta Postgres + PostgREST (igual que Supabase) + Redis + la API, con las migraciones y datos de prueba ya cargados:

```bash
docker compose -f dev/docker-compose.yml up --build
```

- API: http://localhost:8000 (docs en http://localhost:8000/docs)
- Base: `localhost:54322`, usuario `postgres`, clave `postgres`
- Productos de prueba: `1` Amazon $10 (20 códigos), `2` PSN $20 (3 códigos), `3` Steam $50 (sin stock), `4` Free Fire (recarga directa: 100 diamantes en Coda con respaldo en Hankgames, y 200 solo en Coda)
- Empezar de cero: `docker compose -f dev/docker-compose.yml down -v`

Importa `postman/Schedaup_API.postman_collection.json` en Postman y ejecútala completa con **Run collection**
(o carpeta por carpeta en el orden en que aparecen). Cada corrida crea un cliente nuevo, así que se puede repetir.
Las credenciales del cliente, el `request_id` y el id de la orden se guardan solos en las variables de la colección.

- **Admin**: la colección genera el token de admin con `jwt_secret` (el `JWT_SECRET` local). Para producción, usa la carpeta
  *4. Login backend* (o pega el token del frontend en `admin_token`).
- **IP**: en local el header `X-Forwarded-For: {{client_ip}}` simula la IP del cliente; en Railway se ignora.
- Si cambias la colección, edita `postman/build_collection.py` y regenérala con `python postman/build_collection.py`.

Para probar solo los endpoints del cliente (`/v1`) contra producción, usa
`postman/Schedaup_API_Cliente.postman_collection.json`: pon `client_id` y `client_secret` en sus variables.
La carpeta *2. Compra* hace una compra real. Se regenera con `python postman/build_client_collection.py`.

Todas las claves de `dev/` son solo para desarrollo local.

## Desarrollo local

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env   # completar SUPABASE_URL y SUPABASE_KEY
uvicorn app.main:app --reload
pytest
```

- `GET /health` → estado del servicio y conexión a Supabase.
- Documentación interactiva: `/docs`.

## Base de datos

Las tablas se crean ejecutando los archivos de `migrations/` en orden (001 → 009), en el SQL Editor de Supabase.
La 008 (recargas) necesita antes la migración del motor de yape-gaming (`20261028_topup_engine.sql`).
Solo se crean tablas nuevas con prefijo `dist_` (con RLS activado: se requiere la service_role key).

## Autenticación

- **Admin (`/admin/dist/*`)**: `Authorization: Bearer <token>` con el mismo JWT que emite
  `fastapi-gift-cards` en `/auth/login`. Requiere el mismo `JWT_SECRET` en ambos servicios.
- **Clientes (`/v1/*`)**, en este orden:
  1. Basic Auth (`client_id` / `client_secret`) → `401 unauthorized`
  2. Cliente `active` → `403 account_suspended`
  3. IP en la whitelist (IP o CIDR; whitelist vacía = nadie entra) → `403 ip_blocked`
  4. Rate limit por cliente (`rate_limit_rpm`) → `429 rate_limited`

  Además, más de `AUTH_FAIL_LIMIT_PER_MIN` intentos fallidos desde una IP la bloquean un minuto.
  Cada request a `/v1/*` queda en `dist_access_log` (aceptada o rechazada, con el motivo).

  `GET /v1/ping` devuelve `{"ok": true, "client": "...", "ip": "..."}` para que el cliente
  pruebe sus credenciales y vea con qué IP llega.

## Endpoints admin — clientes

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/admin/dist/clients?status=` | Listar clientes |
| POST | `/admin/dist/clients` | Crear cliente (devuelve `client_id` + `client_secret` una sola vez) |
| GET | `/admin/dist/clients/{id}` | Detalle |
| PUT | `/admin/dist/clients/{id}` | Editar nombre, rate limit, webhook, email, metadata |
| PATCH | `/admin/dist/clients/{id}/status` | `active` / `suspended` / `inactive` |
| POST | `/admin/dist/clients/{id}/rotate-key` | Nuevo `client_secret` (el anterior deja de servir) |
| GET | `/admin/dist/clients/{id}/ips` | Ver whitelist |
| POST | `/admin/dist/clients/{id}/ips` | Agregar IP o rango CIDR |
| DELETE | `/admin/dist/clients/{id}/ips/{ip}` | Quitar IP |

## Endpoints admin — productos por cliente

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/admin/dist/clients/{id}/products` | Productos habilitados para el cliente |
| POST | `/admin/dist/clients/{id}/products` | Habilitar producto: `product_id`, `sell_price`, `external_sku` opcional |
| PUT | `/admin/dist/clients/{id}/products/{product_id}` | Cambiar precio, SKU externo o activar/desactivar |
| DELETE | `/admin/dist/clients/{id}/products/{product_id}` | Quitar el producto del cliente |
| GET | `/admin/dist/products/{product_id}/clients` | Qué clientes tienen el producto (pestaña Distribución) |

- El precio queda en la moneda del saldo del cliente (`balance_currency`).
- Solo se pueden distribuir productos `product_type = 'code'`.
- El SKU que ve el cliente es `external_sku` si se definió, si no el `sku` interno; no se repite dentro de un cliente.

## Endpoints admin — saldo

No hay pasarela de pago: el cliente te paga por fuera y tú le cargas el saldo.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/admin/dist/clients/{id}/balance` | Saldo actual |
| POST | `/admin/dist/clients/{id}/balance/credit` | Cargar saldo: `amount` > 0, `description`, `reference_id` opcional (nro. de operación). `type: "refund"` para devoluciones |
| POST | `/admin/dist/clients/{id}/balance/adjust` | Corrección: `amount` positivo suma, negativo resta |
| GET | `/admin/dist/clients/{id}/ledger` | Historial: `start_date`, `end_date`, `page`, `page_size` |

Todo movimiento pasa por la función SQL `dist_apply_balance`, que bloquea al cliente,
impide saldo negativo y registra el movimiento en `dist_ledger` en la misma transacción.
`dist_clients.balance` siempre es igual al último `balance_after` del ledger.

## Endpoints admin — órdenes

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/admin/dist/clients/{id}/orders` | Órdenes del cliente |
| POST | `/admin/dist/orders/{id}/refund` | Devuelve el total al saldo y marca la orden `refunded` (los códigos no vuelven al inventario) |

## API pública

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/v1/ping` | Verifica credenciales e IP |
| GET | `/v1/balance` | Saldo del cliente |
| POST | `/v1/orders` | Comprar: `request_id`, `product_sku`, `quantity` (1-100). Los códigos vienen en la respuesta |
| GET | `/v1/orders/{request_id}` | Consultar una orden |
| GET | `/v1/orders` | Historial de órdenes: `start_date`, `end_date`, `page`, `page_size` |
| GET | `/v1/catalog` | Productos del cliente con precio y stock. Filtros: `name`, `sku`, `brand`, `in_stock`, `page`, `page_size` (máx 100) |

### Compra (`POST /v1/orders`)

Todo ocurre en una transacción (`dist_place_order`): bloquea al cliente, valida producto y saldo,
toma los códigos con `FOR UPDATE SKIP LOCKED` (igual que `claim_inventory_codes`, así nunca choca
con Eneba/G2A/Falabella), los marca `sold` con `sold_to_channel = 'dist:<código>'`, crea la orden
y descuenta el saldo. Si algo falla no cambia nada.

- Mismo `request_id` + mismo producto/cantidad → devuelve la misma orden, sin cobrar de nuevo.
- Mismo `request_id` con otro producto/cantidad → `409 request_id_conflict`.
- Una compra fallida no se guarda: se puede reintentar con el mismo `request_id`.

| HTTP | error | Cuándo |
|---|---|---|
| 404 | `product_not_found` | SKU no habilitado para el cliente |
| 409 | `request_id_conflict` | request_id reutilizado con otro pedido |
| 422 | `insufficient_balance` | Saldo insuficiente |
| 422 | `insufficient_stock` | Sin códigos suficientes (`details.available`) |

El stock es la cantidad de `inventory_codes` con `status = 'available'` (inventario compartido con los demás canales).

## Recargas directas (`/v1/topups`)

La recarga la hace el motor de **yape-gaming** (`/internal/topups/*`, con `TOPUP_ENGINE_URL` y `TOPUP_ENGINE_KEY`
= su `INTERNAL_TOPUP_KEY`). Aquí solo se decide qué recargas ve cada cliente, a qué precio, y se mueve su saldo.
Sin esas variables, `/v1/topups` responde `503 topups_unavailable` y lo demás funciona igual.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/v1/topups/catalog` | Recargas del cliente: `sku`, precio, `available` y `account_fields` (qué datos pide el juego) |
| GET | `/v1/topups/servers?product_sku=` | Servidores (solo juegos que piden `server`) |
| POST | `/v1/topups/validate` | `product_sku` + `account` → nombre del jugador y `validation_id` (5 min, un solo uso). No cobra |
| POST | `/v1/topups` | `request_id` + `product_sku` + `validation_id` → hace la recarga |
| GET | `/v1/topups/{request_id}` | Estado de una recarga |
| GET | `/v1/topups` | Historial: `start_date`, `end_date`, `page`, `page_size` |

Cómo se mueve el saldo:

1. `dist_start_topup` cobra y crea la recarga `pending` **antes** de llamar al motor. Mismo `request_id` = misma recarga.
2. Según el motor:
   - `fulfilled` → `completed`.
   - Rechazada en todos los proveedores → `failed` y se devuelve el saldo.
   - `uncertain` → el saldo queda retenido y llega una alerta ❓. Se cierra a mano en el panel.
   - Sin respuesta o en proceso → sigue `pending`. La reconciliación (cada minuto) pregunta al motor y la cierra.
     Si el motor no la conoce después de 3 minutos, nunca llegó: `failed` y se devuelve el saldo.

El cliente ve `processing` (pending), `under_review` (uncertain), `completed`, `failed` o `refunded`. Nunca ve el proveedor.
El respaldo entre proveedores lo hace el motor: el cliente no lo nota.

Admin:

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/admin/dist/topup-variants/{supplier_id}/clients` | Clientes de una variante (pestaña Canales) |
| GET / POST | `/admin/dist/clients/{id}/topup-products` | Asignar una variante: `supplier_id`, `sell_price`, `external_sku`, `name` opcional |
| PUT / DELETE | `/admin/dist/clients/{id}/topup-products/{assignment_id}` | Cambiar precio/SKU/activar, o quitar |
| GET | `/admin/dist/topups?client_id=&status=` | Recargas (p. ej. `status=uncertain` para revisar) |
| POST | `/admin/dist/topups/{id}/refresh` | Volver a preguntar al motor |
| POST | `/admin/dist/topups/{id}/resolve` | Cerrar a mano una en revisión: `outcome` = `completed` o `failed` (devuelve el saldo) |
| POST | `/admin/dist/topups/{id}/refund` | Devolver una recarga completada |

### Clientes de prueba (sandbox)

Un cliente creado con `sandbox: true` (panel → Nuevo cliente → **Cliente de prueba**) usa la misma URL y las mismas
rutas que uno real, pero sus recargas las resuelve un motor simulado (`app/services/sandbox_engine.py`):
no llama a yape-gaming ni a ningún proveedor y no manda alertas de Telegram. El saldo, los precios, los `request_id`
y las validaciones de un solo uso funcionan igual que en producción (el saldo es el que le cargues a ese cliente).

El resultado lo decide el final del `user_id`:

| Termina en | Resultado |
|---|---|
| `0002` | `failed` y se devuelve el saldo |
| `0003` | `processing`; pasa a `completed` al consultarla 30 s después |
| `0004` | `under_review`; se cierra a mano en el panel |
| `0005` | `processing`; pasa a `failed` (con devolución) 30 s después |
| `0006` | el proveedor "no responde": `processing` y luego `completed` |
| `0008` | validar responde `503 provider_unavailable` |
| `0009` | validar responde `valid: false` |
| otro | `completed` |

`GET /v1/ping` devuelve `"sandbox": true` con estas credenciales. `POST /v1/orders` responde
`403 sandbox_not_supported`, porque las órdenes entregan códigos reales del inventario.

## Alertas de Telegram

Usa las mismas variables que `fastapi-gift-cards` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`).
Solo envía mensajes: no registra el webhook del bot. Si no están configuradas, no se envía nada.

| Alerta | Cuándo | Repetición |
|---|---|---|
| 🛒 Venta | Cada compra exitosa (`ALERT_ON_ORDERS=false` para apagarla) | Cada vez |
| 🎮 Recarga | Cada recarga directa completada (misma variable) | Cada vez |
| ❓ Recarga sin confirmar | El proveedor no confirmó si la hizo: hay saldo retenido | Cada vez |
| ⚠️ Saldo bajo | Una compra deja el saldo por debajo de `low_balance_threshold` del cliente | Solo al cruzar el umbral |
| 📦 Sin stock | Un cliente quiere comprar y no hay códigos suficientes | 1 cada `ALERT_DEDUPE_SECONDS` por cliente+SKU |
| 💸 Sin saldo | Un cliente intenta comprar sin saldo | 1 cada `ALERT_DEDUPE_SECONDS` por cliente |
| 🚫 Acceso rechazado | IP no autorizada o cuenta suspendida | 1 cada `ALERT_DEDUPE_SECONDS` por cliente+motivo+IP |
| 🔐 Fuerza bruta | Una IP supera `AUTH_FAIL_LIMIT_PER_MIN` intentos fallidos | 1 cada `ALERT_DEDUPE_SECONDS` por IP |

El umbral de saldo bajo se configura por cliente (`low_balance_threshold` al crear o editar; vacío = sin alerta).
Las alertas se envían en segundo plano: si Telegram falla, la compra no se ve afectada.

## Deploy en Railway

1. New Service → GitHub repo `codes-hub`, nombre del servicio: `schedaup-api`.
2. Variables: las de `.env.example`.
3. Settings → Networking → Generate Domain → `schedaup-api-production.up.railway.app`.

`railway.json` define el comando de arranque y el healthcheck en `/health`.
