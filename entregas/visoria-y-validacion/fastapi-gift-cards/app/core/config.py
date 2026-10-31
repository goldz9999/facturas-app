# UBICACIÓN EN TU REPO: fastapi-gift-cards/app/core/config.py
# (repositorio: fastapi-gift-cards · ruta: app/core/config.py)
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # App
    APP_NAME: str = "Gift Cards Automation"
    ENVIRONMENT: str = "development"
    DEBUG: bool = True
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    
    # Supabase
    SUPABASE_URL: str
    SUPABASE_SERVICE_KEY: str
    
    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"

    # ── Reposición de inventario (ver docs/REPOSICION.md) ─────────────────
    # Lock distribuido por producto (Redis). Debe ser MAYOR que el time_limit
    # de las tareas Celery (720 s) para que no expire mientras se compra.
    REPLENISH_LOCK_TTL_SECONDS: int = 1200
    # Modo B (reposición por umbral). Apagado = cero cambios de comportamiento:
    # no se registran tareas en beat ni se encolan trabajos.
    REPLENISH_MODE_B_ENABLED: bool = False
    REPLENISH_DISPATCH_INTERVAL_MIN: int = 5
    REPLENISH_SWEEP_INTERVAL_MIN: int = 10
    REPLENISH_MAX_JOBS_PER_DISPATCH: int = 10
    REPLENISH_GLOBAL_CONCURRENCY: int = 3      # compras simultáneas totales (Modo B)
    REPLENISH_PROVIDER_CONCURRENCY: int = 1    # compras simultáneas por proveedor (Modo B)
    REPLENISH_MAX_ATTEMPTS: int = 5            # reintentos de un trabajo antes de "failed"
    REPLENISH_JOB_LEASE_SECONDS: int = 900
    REPLENISH_DISPATCH_TIME_BUDGET_SECONDS: int = 480
    # Un precio consultado hace menos de esto se considera vigente (Modo B).
    PRICE_FRESHNESS_SECONDS: int = 900
    # Pausa por defecto de un proveedor que respondió 429 sin Retry-After.
    PROVIDER_COOLDOWN_DEFAULT_SECONDS: int = 120
    PROVIDER_COOLDOWN_MAX_SECONDS: int = 1800
    # Clave compartida para que otros servicios (backend-yape) avisen ventas
    # al instante. Vacía = el aviso está desactivado (responde 404).
    REPLENISH_NOTIFY_KEY: str = ""
    
    # Eneba REST API (legacy)
    ENEBA_API_KEY: str = ""
    ENEBA_WEBHOOK_SECRET: str = ""
    ENEBA_BASE_URL: str = "https://api-sandbox.eneba.com/v1"
    
    # Eneba GraphQL API
    ENEBA_AUTH_ID: str = ""
    ENEBA_AUTH_SECRET: str = ""
    ENEBA_ENV: str = "sandbox"  # "sandbox" o "production"

    # Eneba URLs por entorno (sobreescribibles desde .env)
    ENEBA_SANDBOX_GQL: str        = "https://api-sandbox.eneba.com/graphql/"
    ENEBA_PROD_GQL: str           = "https://api.eneba.com/graphql/"
    ENEBA_SANDBOX_TOKEN_URL: str  = "https://api-sandbox.eneba.com/oauth/token"
    ENEBA_PROD_TOKEN_URL: str     = "https://user.eneba.com/oauth/token"   # ✅ correcto según docs

    # Eneba client_id por entorno (sobreescribibles desde .env)
    ENEBA_SANDBOX_CLIENT_ID: str  = "917611c2-70a5-11e9-00c4-ee691bb8bfaa"
    ENEBA_PROD_CLIENT_ID: str     = "917611c2-70a5-11e9-97c4-46691b78bfa2"  # ✅ correcto según docs

    ENEBA_CALLBACK_URL: str = ""
    ENEBA_CALLBACK_AUTH: str = ""

    ENEBA_ACCOUNT_EMAIL: str = ""   # Email de la cuenta → contraseña del ZIP de claves
    
    # Bamboo
    BAMBOO_CLIENT_ID: str = ""
    BAMBOO_CLIENT_SECRET: str = ""
    BAMBOO_ENV: str = "production"
    BAMBOO_BASE_URL: str = "https://api.bamboocardportal.com"
    
        # Manastore
    MANASTORE_BASE_URL: str = "https://api.manastore.com/api/v1"
    MANASTORE_API_KEY: str = ""

    # Visoria (códigos). Una key vsk_test_ usa el sandbox de Visoria.
    VISORIA_API_KEY: str = ""
    VISORIA_BASE_URL: str = "https://api.visoria.digital"

    # Coda xShop (vouchers) — misma cuenta de distribuidor que yape-gaming usa para direct-topup
    CODA_BASE_URL: str = "https://xshop.codashop.com/v2"
    CODA_API_KEY: str = ""
    CODA_CLIENT_ID: str = ""
    CODA_SECRET: str = ""

    # EZ API
    EZAPI_API_KEY: str = ""
    EZAPI_ACCESS_TOKEN: str = ""
    EZAPI_ENV: str = "sandbox"
    EZAPI_BASE_URL: str = "https://sandboxapi.ezcards.io"
    
    # CardOne
    CARDONE_APP_ID: str = ""
    CARDONE_APP_KEY: str = ""
    CARDONE_ENV: str = "sandbox"
    CARDONE_BASE_URL: str = "http://api-sandbox.99cardsint.com/v1"
    CARDONE_DELIVERY_EMAIL: str = "hola@schedaup.com"
    
    # WgCards
    # WgCards API v4
    WGCARDS_HOST: str = "https://new-api.wgcards.com/wgcards-api"
    WGCARDS_APP_ID: str = ""
    WGCARDS_SECRET: str = ""
    WGCARDS_BODY_KEY_MATERIAL: str = ""
    WGCARDS_FIXED_BODY_KEY: str = ""     # opcional: clave fija de 16 caracteres
    WGCARDS_ACCOUNT_ID: str = ""         # obsoleto (solo v3)
    WGCARDS_APP_KEY: str = ""            # obsoleto: se usa como secret si WGCARDS_SECRET está vacío

    # iCodes
    ICODES_BASE_URL: str = "https://api.icodeswholesale.com"
    ICODES_CLIENT_ID: str = ""
    ICODES_CLIENT_SECRET: str = ""
    ICODES_PAYMENT_TYPE: int = 2

    # Hankgames (Gamersgold reseller) — códigos/pines y recarga directa
    HANKGAMES_BASE_URL: str = "https://api.hankgames.com"
    HANKGAMES_CLIENT_ID: str = ""
    HANKGAMES_CLIENT_SECRET: str = ""

    # Wupex
    WUPEX_BASE_URL: str = "https://sandbox-service.wupex.com"
    WUPEX_API_KEY: str = ""
    WUPEX_MERCHANT_CODE: str = ""
    WUPEX_LANGUAGE: str = "en"

        # TISI (API HUB Productos Digitales / PIN)
    TISI_BASE_URL: str = "https://api-hub-qa-in.tisi.com.pe"
    TISI_USERNAME: str = ""
    TISI_PASSWORD: str = ""
    TISI_CODIGO_DISTRIBUIDOR: str = ""
    TISI_CODIGO_COMERCIO: str = ""
    TISI_NOMBRE_COMERCIO: str = ""
    TISI_ENV: str = "qa"  # "qa" o "production"
    TISI_CONTACT_EMAIL: str = ""
    TISI_CONTACT_PHONE: str = ""
    TISI_SFTP_HOST: str = ""
    TISI_SFTP_USER: str = ""
    TISI_SFTP_PASSWORD: str = ""
    TISI_SFTP_PORT: int = 22
    TISI_SFTP_INPUT_PATH: str = "/Input"

    # G2A — Merchant API (somos el servidor, G2A nos llama)
    # Estas son LAS CREDENCIALES QUE NOSOTROS GENERAMOS y le damos a G2A
    # para que las ingrese en su Dashboard → API Integration → "Your import
    # API credentials". NO son credenciales que G2A nos da a nosotros.
    G2A_MERCHANT_CLIENT_ID: str = ""
    G2A_MERCHANT_CLIENT_SECRET: str = ""
    G2A_TOKEN_TTL_SECONDS: int = 3600          # G2A guide: access_token válido 1h
    G2A_RESERVATION_TTL_SECONDS: int = 3600    # no especificado en la guía/contrato, default razonable
    G2A_ENV: str = "production"                # el contrato aclara que dropshipping NO es testeable en sandbox


    # G2A — Integration API (NOSOTROS llamamos a G2A para crear/gestionar offers)
    # Credenciales que G2A te da en Dashboard → API Integration → "Your API credentials"
    G2A_API_CLIENT_ID: str = ""
    G2A_API_CLIENT_SECRET: str = ""
    G2A_API_BASE_URL: str = "https://api.g2a.com"   # sandbox: https://sandboxapi.g2a.com
    G2A_JOB_POLL_TIMEOUT: int = 30

    # Firebase Cloud Messaging (push notifications al APK)
    FIREBASE_SERVICE_ACCOUNT_JSON: str = ""

    # Actualizaciones del APK vía GitHub Releases (repo privado)
    GITHUB_TOKEN: str = ""
    GITHUB_REPO: str = ""

    # Recarga directa (Coda xShop) — catálogo vive en backend-yape.
    YAPE_GATEWAY_BASE_URL: str = ""
    YAPE_GATEWAY_ADMIN_KEY: str = ""

    class Config:
        env_file = ".env"
        case_sensitive = True
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()