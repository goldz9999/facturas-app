"""Genera Schedaup_API_Cliente.postman_collection.json: solo los endpoints /v1 del cliente.

Uso: python postman/build_client_collection.py
"""
import json
from pathlib import Path

OUT = Path(__file__).with_name("Schedaup_API_Cliente.postman_collection.json")


def test(*lines: str) -> list[dict]:
    return [{"listen": "test", "script": {"type": "text/javascript", "exec": list(lines)}}]


def prerequest(*lines: str) -> dict:
    return {"listen": "prerequest", "script": {"type": "text/javascript", "exec": list(lines)}}


def req(name, method, path, *, query=None, body=None, events=None, auth=None, description=""):
    url = {"raw": "{{base_url}}" + path, "host": ["{{base_url}}"], "path": [p for p in path.split("?")[0].split("/") if p]}
    if query:
        url["query"] = [{"key": k, "value": v, **({"disabled": True} if off else {})} for k, v, off in query]
        url["raw"] += "?" + "&".join(f"{k}={v}" for k, v, off in query if not off)
    request = {"method": method, "header": [], "url": url, "description": description}
    if body is not None:
        request["header"].append({"key": "Content-Type", "value": "application/json"})
        request["body"] = {"mode": "raw", "raw": json.dumps(body, indent=2, ensure_ascii=False)}
    if auth is not None:
        request["auth"] = auth
    return {"name": name, "event": events or [], "request": request}


ORDER_BODY = {"request_id": "{{request_id}}", "product_sku": "{{product_sku}}", "quantity": "{{quantity}}"}
ORDER_RAW = '{\n  "request_id": "{{request_id}}",\n  "product_sku": "{{product_sku}}",\n  "quantity": {{quantity}}\n}'

consultas = [
    req("Ping", "GET", "/v1/ping",
        description="Comprueba credenciales e IP. Si responde 200, ya puedes usar el resto.",
        events=test(
            "pm.test('200 OK', () => pm.response.to.have.status(200));",
        )),
    req("Catálogo", "GET", "/v1/catalog",
        query=[("in_stock", "true", False), ("name", "", True), ("sku", "", True), ("page", "1", True), ("page_size", "50", True)],
        description="Productos habilitados para este cliente, con su precio y stock. "
                    "Si la variable product_sku está vacía, guarda el SKU del primer producto con stock.",
        events=test(
            "pm.test('200 OK', () => pm.response.to.have.status(200));",
            "const products = pm.response.json().products || [];",
            "pm.test('Hay productos con stock', () => pm.expect(products.length).to.be.above(0));",
            "if (!pm.collectionVariables.get('product_sku') && products.length) {",
            "  pm.collectionVariables.set('product_sku', products[0].sku);",
            "  console.log('product_sku =', products[0].sku, '-', products[0].name, products[0].price, products[0].currency);",
            "}",
        )),
    req("Saldo", "GET", "/v1/balance",
        events=test(
            "pm.test('200 OK', () => pm.response.to.have.status(200));",
            "pm.collectionVariables.set('balance_before', pm.response.json().balance);",
        )),
    req("Órdenes", "GET", "/v1/orders",
        query=[("start_date", "2026-01-01", True), ("end_date", "2026-12-31", True), ("page", "1", True), ("page_size", "50", True)],
        events=test("pm.test('200 OK', () => pm.response.to.have.status(200));")),
]

compra = [
    req("Comprar", "POST", "/v1/orders", body=ORDER_BODY,
        description="⚠️ Compra REAL: descuenta saldo y entrega códigos de tu inventario. "
                    "Genera un request_id nuevo en cada ejecución.",
        events=[
            prerequest("pm.collectionVariables.set('request_id', 'postman-' + pm.variables.replaceIn('{{$guid}}'));"),
            *test(
                "pm.test('200 OK', () => pm.response.to.have.status(200));",
                "const o = pm.response.json();",
                "const qty = Number(pm.collectionVariables.get('quantity'));",
                "pm.test('Entrega la cantidad pedida', () => pm.expect(o.codes.length).to.eql(qty));",
                "pm.test('Descuenta el total del saldo', () => {",
                "  const before = Number(pm.collectionVariables.get('balance_before'));",
                "  if (!isNaN(before)) pm.expect(o.balance_after).to.be.closeTo(before - o.total, 0.001);",
                "});",
                "pm.collectionVariables.set('first_codes', JSON.stringify(o.codes));",
                "pm.collectionVariables.set('balance_after', o.balance_after);",
            ),
        ]),
    req("Repetir la misma compra (no cobra)", "POST", "/v1/orders", body=ORDER_BODY,
        description="Mismo request_id: devuelve la misma orden y los mismos códigos sin volver a cobrar.",
        events=test(
            "pm.test('200 OK', () => pm.response.to.have.status(200));",
            "const o = pm.response.json();",
            "pm.test('Mismos códigos', () => pm.expect(JSON.stringify(o.codes)).to.eql(pm.collectionVariables.get('first_codes')));",
        )),
    req("Saldo después (no cambió al repetir)", "GET", "/v1/balance",
        events=test(
            "pm.test('200 OK', () => pm.response.to.have.status(200));",
            "pm.test('Mismo saldo que tras la compra', () => pm.expect(pm.response.json().balance).to.be.closeTo(Number(pm.collectionVariables.get('balance_after')), 0.001));",
        )),
    req("Consultar orden por request_id", "GET", "/v1/orders/{{request_id}}",
        description="Para recuperar los códigos si se perdió la respuesta de la compra.",
        events=test(
            "pm.test('200 OK', () => pm.response.to.have.status(200));",
            "pm.test('Es la misma orden', () => pm.expect(pm.response.json().request_id).to.eql(pm.collectionVariables.get('request_id')));",
        )),
]

errores = [
    req("request_id usado con otra cantidad → 409", "POST", "/v1/orders",
        body={**ORDER_BODY, "quantity": "{{quantity_plus_one}}"},
        description="No cobra: un request_id ya usado no se puede reutilizar con otro producto o cantidad.",
        events=[
            prerequest("pm.collectionVariables.set('quantity_plus_one', Number(pm.collectionVariables.get('quantity')) + 1);"),
            *test(
                "pm.test('409 request_id_conflict', () => {",
                "  pm.response.to.have.status(409);",
                "  pm.expect(pm.response.json().error).to.eql('request_id_conflict');",
                "});",
            ),
        ]),
    req("SKU no habilitado → 404", "POST", "/v1/orders",
        body={"request_id": "{{request_id}}-sku", "product_sku": "NO-EXISTE-123", "quantity": 1},
        events=test(
            "pm.test('404 product_not_found', () => {",
            "  pm.response.to.have.status(404);",
            "  pm.expect(pm.response.json().error).to.eql('product_not_found');",
            "});",
        )),
    req("Cantidad inválida → 422", "POST", "/v1/orders",
        body={"request_id": "{{request_id}}-qty", "product_sku": "{{product_sku}}", "quantity": 0},
        events=test(
            "pm.test('422 validation_error', () => {",
            "  pm.response.to.have.status(422);",
            "  pm.expect(pm.response.json().error).to.eql('validation_error');",
            "});",
        )),
    req("Orden inexistente → 404", "GET", "/v1/orders/no-existe-{{$timestamp}}",
        events=test("pm.test('404', () => pm.response.to.have.status(404));")),
    req("Credenciales incorrectas → 401", "GET", "/v1/ping",
        auth={"type": "basic", "basic": [
            {"key": "username", "value": "{{client_id}}", "type": "string"},
            {"key": "password", "value": "secreto-incorrecto", "type": "string"},
        ]},
        events=test("pm.test('401', () => pm.response.to.have.status(401));")),
]

recargas = [
    req("Catálogo de recargas", "GET", "/v1/topups/catalog",
        description="Recargas directas habilitadas, con precio y qué datos de la cuenta pide cada una (account_fields). "
                    "Si topup_sku está vacía, guarda la primera disponible.",
        events=test(
            "pm.test('200 OK', () => pm.response.to.have.status(200));",
            "const items = (pm.response.json().products || []).filter(p => p.available);",
            "if (!pm.collectionVariables.get('topup_sku') && items.length) {",
            "  pm.collectionVariables.set('topup_sku', items[0].sku);",
            "  console.log('topup_sku =', items[0].sku, '-', items[0].name, 'pide', items[0].account_fields.join(', '));",
            "}",
        )),
    req("Servidores (solo juegos con servidor)", "GET", "/v1/topups/servers?product_sku={{topup_sku}}",
        query=[("product_sku", "{{topup_sku}}", False)],
        events=test("pm.test('200 OK', () => pm.response.to.have.status(200));")),
    req("Validar cuenta (no cobra)", "POST", "/v1/topups/validate",
        body={"product_sku": "{{topup_sku}}", "account": {"user_id": "{{topup_user_id}}", "zone_id": "{{topup_zone_id}}", "server": "{{topup_server}}"}},
        description="Devuelve el nombre del jugador para confirmarlo antes de pagar. El validation_id dura 5 minutos y sirve para una sola recarga. "
                    "Deja vacíos los datos que el juego no pide.",
        events=test(
            "pm.test('200 OK', () => pm.response.to.have.status(200));",
            "const v = pm.response.json();",
            "pm.test('Cuenta válida', () => pm.expect(v.valid).to.eql(true));",
            "if (v.validation_id) { pm.collectionVariables.set('validation_id', v.validation_id); console.log('Jugador:', v.user_name); }",
        )),
    req("Recargar", "POST", "/v1/topups",
        body={"request_id": "{{topup_request_id}}", "product_sku": "{{topup_sku}}", "validation_id": "{{validation_id}}"},
        description="⚠️ Recarga REAL: descuenta saldo y acredita a la cuenta validada. Usa la validación del paso anterior.",
        events=[
            prerequest("pm.collectionVariables.set('topup_request_id', 'postman-topup-' + pm.variables.replaceIn('{{$guid}}'));"),
            *test(
                "pm.test('200 OK', () => pm.response.to.have.status(200));",
                "const t = pm.response.json();",
                "pm.test('Recarga completada o en proceso', () => pm.expect(['completed', 'processing']).to.include(t.status));",
                "console.log('Estado:', t.status, '· saldo:', t.balance_after);",
            ),
        ]),
    req("Consultar recarga", "GET", "/v1/topups/{{topup_request_id}}",
        description="Si la recarga quedó en processing, consulta aquí hasta que pase a completed o failed.",
        events=test("pm.test('200 OK', () => pm.response.to.have.status(200));")),
    req("Historial de recargas", "GET", "/v1/topups",
        query=[("start_date", "2026-01-01", True), ("end_date", "2026-12-31", True), ("page", "1", True), ("page_size", "50", True)],
        events=test("pm.test('200 OK', () => pm.response.to.have.status(200));")),
]

for item in compra[:2] + errores[:1]:
    item["request"]["body"]["raw"] = ORDER_RAW.replace("{{quantity}}", "{{quantity_plus_one}}") if "409" in item["name"] else ORDER_RAW

collection = {
    "info": {
        "name": "Schedaup API — Cliente (/v1)",
        "description": (
            "Endpoints del cliente de la API de distribución.\n\n"
            "1. Pon client_id y client_secret en las variables de la colección (los da el panel al crear el cliente).\n"
            "2. Tu IP tiene que estar en las IPs autorizadas del cliente.\n"
            "3. product_sku: déjalo vacío y el request Catálogo pone el primero con stock, o escribe uno.\n\n"
            "⚠️ La carpeta 2 hace una compra REAL de {{quantity}} código(s): descuenta saldo y stock.\n"
            "⚠️ En la carpeta 4, Recargar hace una recarga REAL: pon antes topup_user_id (y topup_zone_id o topup_server si el juego lo pide)."
        ),
        "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    "auth": {"type": "basic", "basic": [
        {"key": "username", "value": "{{client_id}}", "type": "string"},
        {"key": "password", "value": "{{client_secret}}", "type": "string"},
    ]},
    "variable": [
        {"key": "base_url", "value": "https://schedaup-api-production.up.railway.app"},
        {"key": "client_id", "value": ""},
        {"key": "client_secret", "value": ""},
        {"key": "product_sku", "value": ""},
        {"key": "quantity", "value": "1"},
        {"key": "request_id", "value": ""},
        {"key": "quantity_plus_one", "value": "2"},
        {"key": "balance_before", "value": ""},
        {"key": "balance_after", "value": ""},
        {"key": "first_codes", "value": ""},
        {"key": "topup_sku", "value": ""},
        {"key": "topup_user_id", "value": ""},
        {"key": "topup_zone_id", "value": ""},
        {"key": "topup_server", "value": ""},
        {"key": "validation_id", "value": ""},
        {"key": "topup_request_id", "value": ""},
    ],
    "item": [
        {"name": "1. Consultas (no gastan saldo)", "item": consultas},
        {"name": "2. Compra (REAL)", "item": compra},
        {"name": "3. Errores esperados (no cobran)", "item": errores},
        {"name": "4. Recargas directas", "item": recargas},
    ],
}

OUT.write_text(json.dumps(collection, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"OK → {OUT}")


# ── Sandbox: mismas rutas, un caso por cada resultado posible ────────────────
SANDBOX_OUT = OUT.with_name("Schedaup_API_Cliente_Sandbox.postman_collection.json")


def sandbox_case(title, user_id, expect, after=None):
    """Validar + Recargar (+ Consultar a los 30 s) con un user_id que fuerza el resultado."""
    folder = title.split(" ")[0]
    validate = req(f"{folder}a. Validar {user_id}", "POST", "/v1/topups/validate",
                   body={"product_sku": "{{topup_sku}}", "account": {"user_id": user_id, "zone_id": "1", "server": "1"}},
                   events=test(
                       "pm.test('200 OK', () => pm.response.to.have.status(200));",
                       "const v = pm.response.json();",
                       "if (v.validation_id) pm.collectionVariables.set('validation_id', v.validation_id);",
                       "console.log('Jugador:', v.user_name);",
                   ))
    create = req(f"{folder}b. Recargar → {expect}", "POST", "/v1/topups",
                 body={"request_id": "{{topup_request_id}}", "product_sku": "{{topup_sku}}", "validation_id": "{{validation_id}}"},
                 events=[
                     prerequest("pm.collectionVariables.set('topup_request_id', 'sandbox-' + pm.variables.replaceIn('{{$guid}}'));"),
                     *test(
                         "pm.test('200 OK', () => pm.response.to.have.status(200));",
                         f"pm.test('status = {expect}', () => pm.expect(pm.response.json().status).to.eql('{expect}'));",
                     ),
                 ])
    items = [validate, create]
    if after:
        items.append(req(f"{folder}c. Consultar (espera 30 s) → {after}", "GET", "/v1/topups/{{topup_request_id}}",
                         events=test(f"pm.test('status = {after}', () => pm.expect(pm.response.json().status).to.eql('{after}'));")))
    return {"name": title, "item": items}


def sandbox_validate_only(title, user_id, code, check):
    return {"name": title, "item": [req(f"Validar {user_id}", "POST", "/v1/topups/validate",
                                        body={"product_sku": "{{topup_sku}}", "account": {"user_id": user_id, "zone_id": "1", "server": "1"}},
                                        events=test(f"pm.test('{code}', () => pm.response.to.have.status({code}));", check))]}


sandbox = {
    "info": {
        "name": "Schedaup API — Cliente SANDBOX (pruebas)",
        "description": (
            "Recargas de prueba: misma URL y mismas rutas que producción, pero con las credenciales del cliente "
            "de PRUEBA. Nada llega a un proveedor ni al juego.\n\n"
            "1. Pon client_id y client_secret de prueba en las variables de la colección.\n"
            "2. Corre '0. Ping' (debe decir sandbox: true) y '0. Catálogo' (guarda topup_sku).\n"
            "3. Cada carpeta fuerza un resultado según el final del user_id.\n\n"
            "El saldo es el que se cargó al cliente de prueba y se mueve igual que en producción."
        ),
        "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    "auth": collection["auth"],
    "variable": [
        {"key": "base_url", "value": "https://schedaup-api-production.up.railway.app"},
        {"key": "client_id", "value": ""},
        {"key": "client_secret", "value": ""},
        {"key": "topup_sku", "value": ""},
        {"key": "validation_id", "value": ""},
        {"key": "topup_request_id", "value": ""},
    ],
    "item": [
        req("0. Ping", "GET", "/v1/ping",
            events=test("pm.test('Credenciales de prueba', () => pm.expect(pm.response.json().sandbox).to.eql(true));")),
        {**recargas[0], "name": "0. Catálogo de recargas"},
        req("0. Saldo", "GET", "/v1/balance", events=test("pm.test('200 OK', () => pm.response.to.have.status(200));")),
        sandbox_case("1 Completada", "100001", "completed"),
        sandbox_case("2 Fallida (devuelve saldo)", "100002", "failed"),
        sandbox_case("3 En proceso → completada", "100003", "processing", "completed"),
        sandbox_case("4 En revisión", "100004", "under_review"),
        sandbox_case("5 En proceso → fallida", "100005", "processing", "failed"),
        sandbox_case("6 Proveedor no responde → completada", "100006", "processing", "completed"),
        sandbox_validate_only("7 Cuenta inexistente", "100009", 200,
                              "pm.test('valid = false', () => pm.expect(pm.response.json().valid).to.eql(false));"),
        sandbox_validate_only("8 Proveedor caído al validar", "100008", 503,
                              "pm.test('provider_unavailable', () => pm.expect(pm.response.json().error).to.eql('provider_unavailable'));"),
        {**recargas[-1], "name": "9. Historial de recargas"},
    ],
}

SANDBOX_OUT.write_text(json.dumps(sandbox, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"OK → {SANDBOX_OUT}")
