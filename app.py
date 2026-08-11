"""
Application entry point for the Restaurant Automated Ordering System.

Uses the application factory pattern (create_app) so the app can be
imported cleanly by test suites or WSGI servers, while still being
runnable directly with `python app.py` for local development.
"""

import logging
import os

from flask import Flask

from config import config_by_name
from extensions import socketio

# Blueprints - each module registers its own url_prefix internally.
from routes.customer import customer_bp
from routes.orders import orders_bp
from routes.payments import payments_bp
from routes.kitchen import kitchen_bp

# Importing this module registers all @socketio.on(...) event handlers
# (join_order_room, customer_connected, etc.) as a side effect of import.
# The noqa comment tells linters this "unused" import is intentional.
from services import socket_events  # noqa: F401


def create_app(config_name=None):
    """
    Application factory: builds and configures a Flask app instance.

    Args:
        config_name (str): "development" or "production". Defaults to
            the FLASK_ENV environment variable, or "development".
    """
    app = Flask(__name__)

    config_name = config_name or os.environ.get("FLASK_ENV", "development")
    app.config.from_object(config_by_name[config_name])

    _configure_logging(app)

    # Bind the shared SocketIO instance (created in extensions.py) to
    # this specific app instance.
    socketio.init_app(
        app,
        async_mode=app.config["SOCKETIO_ASYNC_MODE"],
        cors_allowed_origins=app.config["SOCKETIO_CORS_ALLOWED_ORIGINS"],
    )

    _register_blueprints(app)
    _register_error_handlers(app)

    return app


def _configure_logging(app):
    """Basic logging setup; more verbose in debug mode."""
    log_level = logging.DEBUG if app.debug else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )


def _register_blueprints(app):
    """Register every route blueprint on the app."""
    app.register_blueprint(customer_bp)
    app.register_blueprint(orders_bp)
    app.register_blueprint(payments_bp)
    app.register_blueprint(kitchen_bp)


def _register_error_handlers(app):
    """Centralized JSON error responses instead of default HTML pages."""

    @app.errorhandler(404)
    def not_found(error):
        return {"error": "Resource not found"}, 404

    @app.errorhandler(400)
    def bad_request(error):
        return {"error": str(error.description) if hasattr(error, "description") else "Bad request"}, 400

    @app.errorhandler(500)
    def server_error(error):
        app.logger.error("Internal server error: %s", error)
        return {"error": "Internal server error"}, 500


# Module-level app instance so `flask run` and WSGI servers can find it,
# and so socketio.run() below has something to serve.
app = create_app()


if __name__ == "__main__":
    # socketio.run wraps Flask's dev server with WebSocket support.
    # In production, run behind a proper eventlet/gunicorn setup instead.
    socketio.run(
        app,
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 5000)),
        debug=app.config["DEBUG"],
    )