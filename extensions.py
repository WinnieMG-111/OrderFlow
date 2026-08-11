"""
Holds shared Flask extension instances, instantiated here (without an app)
and initialized later in app.py via `init_app()`. This pattern avoids
circular imports between app.py, routes/*.py, and services/*.py, since
every module can safely `from extensions import socketio` without
needing the actual Flask app object.
"""

from flask_socketio import SocketIO

# Single shared SocketIO instance used across the whole application.
# async_mode is set explicitly to match the eventlet worker installed
# in requirements.txt.
socketio = SocketIO(async_mode="eventlet", cors_allowed_origins="*")