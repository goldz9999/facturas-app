from datetime import date

from fastapi import APIRouter, Depends, Query

from app.middleware.client_auth import require_client
from app.schemas.client_products import CatalogPage
from app.schemas.ledger import BalanceOut
from app.schemas.orders import OrderCreate, OrderOut, OrdersPage, to_order_out
from app.services.client_products_repo import ClientProductsRepo, get_client_products_repo
from app.services.clients_repo import ClientsRepo, get_clients_repo
from app.core.errors import ApiError
from app.services import alerts
from app.services.orders_repo import OrdersRepo, get_orders_repo

router = APIRouter(prefix="/v1", tags=["v1"])


@router.get("/ping")
def ping(client: dict = Depends(require_client)):
    """Para que el cliente verifique sus credenciales y la IP con la que llega."""
    return {"ok": True, "client": client["code"], "ip": client["ip"], "sandbox": bool(client.get("sandbox"))}


@router.get("/catalog", response_model=CatalogPage)
def catalog(
    name: str | None = Query(default=None, description="Filtra por nombre (contiene)"),
    sku: str | None = Query(default=None),
    brand: str | None = Query(default=None),
    in_stock: bool | None = Query(default=None, description="true = solo productos con stock"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    client: dict = Depends(require_client),
    repo: ClientProductsRepo = Depends(get_client_products_repo),
):
    """Solo los productos habilitados para este cliente, con su precio y stock."""
    items = repo.catalog(client["id"])
    if name:
        items = [i for i in items if name.lower() in i["name"].lower()]
    if sku:
        items = [i for i in items if i["sku"] == sku]
    if brand:
        items = [i for i in items if (i.get("brand") or "").lower() == brand.lower()]
    if in_stock is not None:
        items = [i for i in items if (i["stock"] > 0) == in_stock]

    start = (page - 1) * page_size
    return {
        "products": [{**i, "available": i["stock"] > 0} for i in items[start:start + page_size]],
        "page": page,
        "page_size": page_size,
        "total": len(items),
    }


@router.get("/balance", response_model=BalanceOut)
def balance(client: dict = Depends(require_client), clients: ClientsRepo = Depends(get_clients_repo)):
    current = clients.get(client["id"])
    return {"balance": current["balance"], "currency": current["balance_currency"]}


@router.post("/orders", response_model=OrderOut)
def place_order(
    body: OrderCreate,
    client: dict = Depends(require_client),
    orders: OrdersRepo = Depends(get_orders_repo),
):
    """Compra síncrona: si hay saldo y stock, los códigos vienen en la respuesta.

    Si se repite el mismo request_id se devuelve la misma orden sin cobrar de nuevo.
    Si falla (sin saldo, sin stock) no se guarda nada y se puede reintentar con el mismo request_id.
    """
    if client.get("sandbox"):
        # Las órdenes entregan códigos reales del inventario: no se simulan.
        raise ApiError(403, "sandbox_not_supported",
                       "Las credenciales de prueba solo sirven para recargas (/v1/topups)")
    try:
        row = orders.place(client["id"], body.request_id, body.product_sku, body.quantity)
    except ApiError as e:
        if e.error == "insufficient_stock":
            alerts.get_alerts().insufficient_stock(client, body.product_sku, body.quantity, e.details.get("available", 0))
        elif e.error == "insufficient_balance":
            alerts.get_alerts().insufficient_balance(client, body.product_sku, body.quantity)
        raise

    if not row.get("replayed"):
        alerts.get_alerts().order_completed(client, row)
        alerts.get_alerts().check_low_balance(client, row)
    return to_order_out(row)


@router.get("/orders", response_model=OrdersPage)
def list_orders(
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None, description="Inclusive"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    client: dict = Depends(require_client),
    orders: OrdersRepo = Depends(get_orders_repo),
):
    rows, total = orders.list(client["id"], start_date, end_date, (page - 1) * page_size, page_size)
    return {"orders": [to_order_out(r) for r in rows], "page": page, "page_size": page_size, "total": total}


@router.get("/orders/{request_id}", response_model=OrderOut)
def get_order(
    request_id: str,
    client: dict = Depends(require_client),
    orders: OrdersRepo = Depends(get_orders_repo),
):
    row = orders.get_by_request_id(client["id"], request_id)
    if not row:
        raise ApiError(404, "order_not_found", "No existe una orden con ese request_id")
    return to_order_out(row)
