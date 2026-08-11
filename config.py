"""
Central configuration for the Restaurant Automated Ordering System.
 
All sensitive credentials (DB password, M-Pesa keys) are read from
environment variables via python-dotenv, with fallback defaults for
local development only. In production, set real values in a `.env`
file (which should NEVER be committed to version control) or in the
hosting environment directly.
"""
 
import os
from datetime import timedelta
from dotenv import load_dotenv
 
# Load variables from a .env file in the project root, if present.
load_dotenv()
 
 
class Config:
    """Base configuration shared by the whole application."""
 
    # FLASK CORE SETTINGS
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-key-change-me")
 
    # Flask session cookie settings.
    SESSION_COOKIE_NAME = "restaurant_session"
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    PERMANENT_SESSION_LIFETIME = timedelta(hours=6)  # 6 hours, in seconds
 
    # DATABASE SETTINGS (MySQL via PyMySQL)
    MYSQL_HOST = os.environ.get("MYSQL_HOST", "localhost")
    MYSQL_PORT = int(os.environ.get("MYSQL_PORT", 3306))
    MYSQL_USER = os.environ.get("MYSQL_USER", "root")
    MYSQL_PASSWORD = os.environ.get("MYSQL_PASSWORD", "")
    MYSQL_DB = os.environ.get("MYSQL_DB", "restaurant_ordering_system")
    MYSQL_CHARSET = "utf8mb4"
 
    # FILE UPLOAD SETTINGS (menu item images)
    BASE_DIR = os.path.abspath(os.path.dirname(__file__))

    UPLOAD_FOLDER = os.path.join(
        BASE_DIR,
        "static",
        "uploads"
    )
    ALLOWED_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "webp"}
    MAX_CONTENT_LENGTH = 5 * 1024 * 1024  # 5 MB max upload size

    # ORDER STATUS CONSTANTS
    ORDER_PENDING = "Pending"
    ORDER_PREPARING = "Preparing"
    ORDER_READY = "Ready"
    ORDER_COMPLETED = "Completed"
    ORDER_CANCELLED = "Cancelled"

    VALID_ORDER_STATUSES = [
        ORDER_PENDING,
        ORDER_PREPARING,
        ORDER_READY,
        ORDER_COMPLETED,
        ORDER_CANCELLED,
    ]

    # M-PESA DARAJA API SETTINGS
    MPESA_ENV = os.environ.get("MPESA_ENV", "sandbox")
 
    MPESA_CONSUMER_KEY = os.environ.get("MPESA_CONSUMER_KEY", "")
    MPESA_CONSUMER_SECRET = os.environ.get("MPESA_CONSUMER_SECRET", "")
 
    # Till/Paybill shortcode used for STK Push.
    MPESA_SHORTCODE = os.environ.get("MPESA_SHORTCODE", "174379")
 
    # Lipa Na M-Pesa Online passkey (from the Daraja developer portal).
    MPESA_PASSKEY = os.environ.get("MPESA_PASSKEY", "")
 
    # Public HTTPS URL Safaricom will POST the payment result to.
    # Must be reachable from the internet (e.g. via ngrok in dev).
    MPESA_CALLBACK_URL = os.environ.get(
        "MPESA_CALLBACK_URL", "https://example.com/payments/callback"
    )
 
    # Base URLs differ between sandbox and production.
    MPESA_BASE_URL = (
        "https://sandbox.safaricom.co.ke"
        if MPESA_ENV == "sandbox"
        else "https://api.safaricom.co.ke"
    )
 
    # Transaction type for STK Push. CustomerPayBillOnline for paybill,
    # CustomerBuyGoodsOnline for till numbers.
    MPESA_TRANSACTION_TYPE = os.environ.get(
        "MPESA_TRANSACTION_TYPE", "CustomerPayBillOnline"
    )
     # SOCKET.IO SETTINGS
    # "eventlet" async worker, matches the package in requirements.txt.
    SOCKETIO_ASYNC_MODE = "eventlet"
    # Restrict in production to your real frontend origin(s).
    SOCKETIO_CORS_ALLOWED_ORIGINS = os.environ.get(
        "SOCKETIO_CORS_ALLOWED_ORIGINS", "*"
    )
 
 
class DevelopmentConfig(Config):
    DEBUG = True
 
 
class ProductionConfig(Config):
    DEBUG = False
    SESSION_COOKIE_SECURE = True  # HTTPS only cookies in production
 
 
# Map of config name -> config class, selected in app.py via FLASK_ENV.
config_by_name = {
    "development": DevelopmentConfig,
    "production": ProductionConfig,
}
 
