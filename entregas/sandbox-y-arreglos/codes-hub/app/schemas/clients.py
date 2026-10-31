import ipaddress
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

ClientStatus = Literal["active", "suspended", "inactive"]


def normalize_ip(value: str) -> str:
    """Acepta una IP (1.2.3.4) o un rango CIDR (1.2.3.0/24) y lo devuelve normalizado."""
    value = value.strip()
    try:
        if "/" in value:
            return str(ipaddress.ip_network(value, strict=False))
        return str(ipaddress.ip_address(value))
    except ValueError:
        raise ValueError(f"IP inválida: {value}")


class ClientCreate(BaseModel):
    code: str = Field(pattern=r"^[a-z0-9_]{2,32}$", description="Código corto, ej: tisi")
    name: str = Field(min_length=1, max_length=200)
    balance_currency: Literal["USD", "PEN"] = "USD"
    ip_whitelist: list[str] = Field(default_factory=list)
    rate_limit_rpm: int = Field(default=60, gt=0, le=10_000)
    low_balance_threshold: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    webhook_url: str | None = None
    contact_email: EmailStr | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    sandbox: bool = Field(default=False, description="Cliente de prueba: sus recargas no llegan a ningún proveedor")

    @field_validator("ip_whitelist")
    @classmethod
    def validate_ips(cls, ips: list[str]) -> list[str]:
        return sorted({normalize_ip(ip) for ip in ips})


class ClientUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    rate_limit_rpm: int | None = Field(default=None, gt=0, le=10_000)
    low_balance_threshold: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    webhook_url: str | None = None
    contact_email: EmailStr | None = None
    metadata: dict[str, Any] | None = None


class ClientStatusUpdate(BaseModel):
    status: ClientStatus


class IpAdd(BaseModel):
    ip: str

    @field_validator("ip")
    @classmethod
    def validate_ip(cls, ip: str) -> str:
        return normalize_ip(ip)


class ClientOut(BaseModel):
    id: int
    code: str
    name: str
    status: ClientStatus
    api_client_id: str
    balance: Decimal
    balance_currency: str
    ip_whitelist: list[str]
    rate_limit_rpm: int
    low_balance_threshold: Decimal | None = None
    webhook_url: str | None = None
    contact_email: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    credentials_rotated_at: datetime | None = None
    sandbox: bool = False
    created_at: datetime
    updated_at: datetime


class ClientCredentials(BaseModel):
    """Se devuelve SOLO al crear o rotar. El secret no se puede recuperar después."""

    client_id: str
    client_secret: str


class ClientCreated(BaseModel):
    client: ClientOut
    credentials: ClientCredentials
