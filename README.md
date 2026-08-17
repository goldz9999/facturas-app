# Facturas — Backend (NestJS) + Frontend (React/Vite)

Muestra los datos de la tabla `tabla_2` de Supabase (fecha, empresa, n_factura, producto, cantidad, costo) con filtros y paginación.

## Estructura

```
facturas-app/
├── backend/    # API NestJS que consulta Supabase
└── frontend/   # React + Vite, consume la API
```

## 1. Backend

```bash
cd backend
npm install
cp .env.example .env
```

Edita `.env` y coloca tus credenciales reales de Supabase:

```
PORT=3000
SUPABASE_URL=https://TU-PROYECTO.supabase.co
SUPABASE_KEY=TU-SERVICE-ROLE-O-ANON-KEY
```

- Encuentra estos valores en tu proyecto de Supabase → **Settings → API**.
- Si esta API solo la vas a usar tú (no expuesta públicamente), puedes usar la `service_role` key para tener acceso completo. Si el frontend va a ser público, considera usar la `anon` key + Row Level Security (RLS) en Supabase para restringir el acceso.

Ejecutar en desarrollo:

```bash
npm run start:dev
```

Esto expone la API en `http://localhost:3000`.

### Endpoint disponible

```
GET /facturas
```

Query params opcionales:
- `empresa` — filtro parcial (contiene texto)
- `n_factura` — filtro parcial
- `desde` — fecha ISO (YYYY-MM-DD), filtra `fecha >= desde`
- `hasta` — fecha ISO (YYYY-MM-DD), filtra `fecha <= hasta`
- `page` — número de página (default 1)
- `pageSize` — registros por página (default 20)

Respuesta:

```json
{
  "data": [ { "id": 1, "fecha": "2030-08-15", "empresa": "BORCELLE", "n_factura": "F001-00012345", "producto": "Diseño web", "cantidad": 1, "costo": 100 } ],
  "page": 1,
  "pageSize": 20,
  "total": 42
}
```

## 2. Frontend

```bash
cd frontend
npm install
cp .env.example .env
```

Por defecto `.env` apunta a `http://localhost:3000` (tu backend local). Ajusta `VITE_API_URL` si tu backend corre en otra URL/puerto.

Ejecutar en desarrollo:

```bash
npm run dev
```

Abre `http://localhost:5173`.

## Notas

- El backend usa `@supabase/supabase-js` para consultar directo la tabla `tabla_2`.
- CORS está abierto (`origin: true`) para desarrollo; en producción restringe al dominio real de tu frontend en `backend/src/main.ts`.
- La tabla espera columnas: `id, fecha, empresa, n_factura, producto, cantidad, costo` (tal como se definieron previamente en Supabase).
