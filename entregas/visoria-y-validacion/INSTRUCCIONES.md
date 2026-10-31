# Visoria, validación con nombre y recarga con el más barato

Todo parte de los zips que me pasaste. Cada carpeta de esta entrega tiene el nombre de su repo, y dentro cada archivo está en la misma ruta que en ese repo.

**codes-hub ya está subido a `main`** (commit `47c7dd0`): la validación ahora devuelve `name_verified`.

## Qué cambia

### 1. Validar: se busca el nombre del jugador
En cada validación, el motor pregunta a los proveedores del grupo de esa recarga, en el orden de las flechas del panel:
- **El primero que devuelve el nombre real del jugador gana.** Si Coda no lo da para ese juego y Hankgames sí, valida Hankgames.
- **Si uno dice "cuenta no existe", pregunta al siguiente.** Así un proveedor que no conoce ese juego no frena la recarga.
- **Si nadie da el nombre pero alguno dice que la cuenta existe**, se acepta sin nombre.
- **Si todos dicen "no existe"**, la respuesta es `valid: false`.
- **Si ningún proveedor del grupo puede validar** (por ejemplo, solo Visoria), responde "no se puede validar" y no se recarga.

**Lo que ve TISI** en `POST /v1/topups/validate`:

| Campo | Valor |
|---|---|
| `user_name` | El nombre del jugador |
| `name_verified` | `true` si es el nombre real; `false` si la cuenta existe pero ningún proveedor dio el nombre (entonces `user_name` viene `null`) |

El canje de códigos del WordPress sigue exigiendo el nombre.

### 2. Recargar: del más barato al más caro
- **Se intenta primero la variante con menor costo.** Si la rechaza, la siguiente más barata, y así hasta la más cara.
- **El que validó también entra**, en el lugar que le toque por precio.
- **Solo pasa al siguiente si el proveedor rechazó.** Si quedó en proceso o sin confirmar, se detiene para no recargar dos veces.
- **Costos en otras monedas:** se pasan a USD con la variable `TOPUP_FX_TO_USD`, por ejemplo `PEN=0.27`.
- **Una variante sin costo, o en una moneda que no está en esa variable**, va al final.
- **Para que el orden sea bueno**, los costos tienen que estar al día. Usa el botón de refrescar precio de cada variante.

### 3. "Usar para validar" (por variante)
- En el panel, al agregar o editar una variante de Coda o Hankgames, hay un interruptor **Usar para validar la cuenta**.
- **Apágalo cuando ese proveedor no da el nombre en ese juego.** El motor no le pregunta al validar, pero la sigue usando para recargar.
- **En la lista del grupo** cada variante muestra **Valida** o **Solo recarga**.
- **Si ninguna del grupo valida**, aparece un aviso.

### 4. Visoria para recargas (yape-gaming)
- **Visoria no valida cuentas**, así que en recargas es solo recarga: el nombre lo da Coda o Hankgames del mismo grupo. Agrégala siempre como **respaldo** de la misma recarga en uno de ellos.
- **En el panel:** Agregar variante → **Visoria** → escribe el juego y pulsa **Buscar** → elige el producto. Los datos que pide (ID, zona) se sugieren solos.
- **La orden se identifica con una clave única.** Si Visoria no responde a tiempo, la recarga queda "en revisión" y se puede buscar en su portal por esa clave. Reintentar nunca crea una segunda orden.
- **No soportado todavía:** los 5 juegos de Visoria que piden elegir personaje (Ragnarok Origin, Captain Tsubasa: Ace, Perfect World W, Ragnarok Twilight, Paw Tales). El motor los salta y usa otro proveedor.

### 5. Visoria para códigos (fastapi-gift-cards)
- **Se mapea igual que cualquier proveedor de códigos:** Productos → Proveedores → Visoria → buscar → elegir.
- **Solo aparecen productos de código de precio fijo.** Los de monto libre y las recargas no aparecen.
- **Compra automática y reposición:** crea la orden, espera los códigos y los guarda en inventario.
  - Si quedan pendientes, se retoman en el próximo ciclo y aparecen en **Recuperación de órdenes**.
  - Si Visoria rechaza la orden (4xx: sin saldo, producto no disponible), pasa al siguiente proveedor sin dejar una orden "dudosa".
  - Si Visoria no responde (5xx o timeout), queda como dudosa, igual que con los otros proveedores.
- **Saldo y precios:** se leen de Visoria, para la alerta de saldo bajo y la actualización automática de precios.
- **Venta de Eneba con stock declarado:** también puede comprar en Visoria.
- **Tarjetas con código y PIN distintos:** se guardan juntos como `CODIGO PIN: 1234`.

## Orden para aplicarlo

### 1. Supabase (SQL Editor)
Ejecuta los dos archivos:

| Archivo | Qué hace |
|---|---|
| `yape-gaming/supabase_migrations/20261031_topup_validates.sql` | Agrega a `direct_topup_suppliers` la columna `validates`, que vale `true` en todas las variantes que ya tienes |
| `fastapi-gift-cards/supabase_migrations/20261031_visoria_provider.sql` | Agrega la fila `visoria` a `providers`, si no existe |

Los dos se pueden correr más de una vez. Los probé en Postgres, dos veces cada uno, sin errores.

### 2. Visoria (panel de Visoria → Developers)
1. Crea una API key con los permisos `products:read`, `orders:read`, `orders:write`, `balance:read` y `keys:read`. Sin `keys:read` no llegan los códigos.
2. Agrega la IP de salida de Railway en las IPs permitidas de la key. Visoria lo exige, también para las keys de prueba.
3. **Empieza con una key de prueba (`vsk_test_...`):** usa las mismas rutas, pero las órdenes son simuladas, con saldo de prueba y códigos `SANDBOX-...`. Cuando todo funcione, cámbiala por la real (`vsk_live_...`).

### 3. Variables en Railway

| Servicio | Variable | Valor |
|---|---|---|
| yape-gaming | `VISORIA_API_KEY` | La key de Visoria |
| yape-gaming | `TOPUP_FX_TO_USD` | Ej. `PEN=0.27`. Sin ella, solo se comparan costos en USD |
| fastapi-gift-cards | `VISORIA_API_KEY` | La misma key |

### 4. Archivos y deploy

**yape-gaming:**

| Archivo | Qué hacer |
|---|---|
| `app/topups/engine.py` | Reemplazar |
| `app/topups/store.py` | Reemplazar |
| `app/main.py` | Reemplazar |
| `app/providers/visoria_client.py` | Nuevo |
| `supabase_migrations/20261031_topup_validates.sql` | Nuevo (el del paso 1) |
| `tests/test_topup_engine.py` | Reemplazar (pruebas) |
| `tests/test_visoria.py` | Nuevo (pruebas) |

El motor funciona aunque todavía no hayas corrido el SQL: si falta la columna, toma todas las variantes como "valida".

**fastapi-gift-cards:**

| Archivo | Qué hacer |
|---|---|
| `app/routes/direct_topup.py` | Reemplazar (rutas de Visoria para el panel y el campo `validates`) |
| `app/providers/visoria_client.py` | Nuevo |
| `app/services/auto_purchase_service.py` | Reemplazar |
| `app/services/eneba_declared_stock_service.py` | Reemplazar. Ya incluye el título "Stock insuficiente" que te pasé antes |
| `app/core/provider_http_monitor.py` | Reemplazar. Ya incluye el arreglo de 99Cards que te pasé antes |
| `app/core/config.py` | Reemplazar |
| `app/routes/catalog.py` | Reemplazar |
| `app/routes/recovery.py` | Reemplazar |
| `supabase_migrations/20261031_visoria_provider.sql` | Nuevo (el del paso 1) |
| `tests/test_visoria.py` | Nuevo (pruebas) |

El backend necesita el SQL `20261031_topup_validates.sql` antes del deploy: al guardar una variante manda `validates`.

**Panel (digital-wallet-manager):**

| Archivo | Qué hacer |
|---|---|
| `src/features/productos/components/TabProveedorCoda.tsx` | Reemplazar |
| `src/features/productos/components/TabProveedorCoda.test.tsx` | Nuevo (pruebas) |
| `src/features/productos/types.ts` | Reemplazar |
| `src/features/productos/api.ts` | Reemplazar |
| `src/features/recovery/utils.ts` | Reemplazar |
| `src/features/recovery/types.ts` | Reemplazar |

Partí de los zips de ayer. Si cambiaste alguno de estos archivos después, no lo reemplaces y avísame.

**Un detalle del panel:** en Inventario, los códigos de Visoria van a salir como `#<id>` hasta que agregues el id de Visoria en `src/features/inventario/constants.ts` (`PROVIDER_NAMES`). Mira el id en la tabla `providers` después del SQL, o pásamelo y lo agrego.

## Cómo probarlo

1. **Recarga con validación por otro proveedor:**
   - En un juego que Coda no valida, deja Coda y Hankgames en el mismo grupo.
   - Valida con tu ID: el nombre debe venir de Hankgames, con `name_verified: true`.
2. **Recarga con el más barato:**
   - Pon Visoria (más barata) como respaldo de Coda en una recarga.
   - Valida y recarga: el nombre lo da Coda y la recarga sale por Visoria.
   - En Supabase, `direct_topup_executions.attempts` muestra qué proveedor la hizo.
3. **Códigos:**
   - Mapea un producto de código de Visoria.
   - Corre la reposición con la key de prueba: deben entrar códigos `SANDBOX-...` al inventario.

## Pruebas

| Repo | Comando | Resultado |
|---|---|---|
| yape-gaming | `python -m pytest tests` (necesita `pip install pytest respx`) | 68 pasan (32 nuevas) |
| fastapi-gift-cards | `SUPABASE_URL=http://x SUPABASE_SERVICE_KEY=x python -m pytest tests/test_visoria.py tests/test_provider_http_monitor_cardone.py` (necesita `respx`) | 17 pasan |
| codes-hub | `python -m pytest` | 125 pasan (ya en `main`) |
| Panel | `npx vitest run` | 44 pasan; `tsc` sigue con los mismos 11 errores que ya tenías |

**Lo que no se probó:** la API real de Visoria (no tengo key ni acceso desde aquí). Las pruebas simulan sus respuestas tal como las describe su documentación. Por eso conviene empezar con la key de prueba.
