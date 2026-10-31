# Schedaup API — Recargas de prueba (sandbox)

Con las **credenciales de prueba** puedes probar toda la integración de recargas sin recargar de verdad.

- **URL:** la misma de producción, `https://schedaup-api-production.up.railway.app`.
- **Rutas:** las mismas, `/v1/topups/*`.
- **Respuestas:** el mismo formato y los mismos estados que en producción.
- Ninguna recarga llega al juego ni a un proveedor.
- El saldo de prueba se descuenta y se devuelve igual que en producción.

Para pasar a producción solo cambias `client_id` y `client_secret` por los reales. No cambia nada más.

## Comprobar que estás en sandbox

`GET /v1/ping` → `{"ok": true, "client": "tisi_test", "ip": "…", "sandbox": true}`

## Elegir el resultado

El resultado de la recarga depende de **los últimos 4 dígitos del `user_id`** que envíes:

| `user_id` termina en | `POST /v1/topups` responde | Si consultas `GET /v1/topups/{request_id}` 30 s después |
|---|---|---|
| cualquier otro (ej. `123456789`) | `completed` | `completed` |
| `0002` | `failed` (el saldo ya se devolvió) | `failed` |
| `0003` | `processing` | `completed` |
| `0005` | `processing` | `failed` (el saldo se devuelve) |
| `0006` | `processing` (el proveedor no respondió a tiempo) | `completed` |
| `0004` | `under_review` (el saldo queda retenido) | `under_review` hasta que Schedaup la revise |

**Al validar** (`POST /v1/topups/validate`):

| `user_id` termina en | Respuesta |
|---|---|
| `0009` | `200` con `"valid": false` (la cuenta no existe) |
| `0008` | `503` con `"error": "provider_unavailable"`: reintenta en unos segundos |
| cualquier otro | `200`, `"valid": true`, `"user_name": "Jugador de prueba XXXX"`, `"name_verified": true` y un `validation_id` |

Los juegos que piden servidor devuelven dos servidores de prueba en `GET /v1/topups/servers`, con `id` `"1"` y `"2"`.

`name_verified` indica si `user_name` es el nombre real del jugador según el proveedor. En producción puede venir `false` (con `user_name: null`) cuando la cuenta existe pero ningún proveedor dio el nombre: muéstrale al usuario que no se pudo confirmar el nombre antes de recargar.

## Lo que también puedes probar

Todo esto funciona igual que en producción:

| Prueba | Resultado |
|---|---|
| Repetir el mismo `request_id` | Devuelve la misma recarga y no cobra otra vez |
| Usar un `validation_id` dos veces | `410 validation_expired` |
| Recargar sin saldo suficiente | `422 insufficient_balance` |
| No enviar un dato que el juego pide (ej. `zone_id`) | `422 missing_account_fields` |
| Enviar un `product_sku` que no tienes | `404 product_not_found` |

## Postman

Importa `Schedaup_API_Cliente_Sandbox.postman_collection.json`.

1. Pon `client_id` y `client_secret` de prueba en las variables de la colección.
2. Corre **0. Ping** y **0. Catálogo de recargas**. El catálogo guarda el primer SKU en `topup_sku`.
3. Cada carpeta (1 a 8) es un resultado: **Validar** → **Recargar**. En las de proceso, espera 30 s y corre **Consultar**.

## Lo que no está en sandbox

`POST /v1/orders` (compra de códigos) responde `403 sandbox_not_supported` con las credenciales de prueba.
