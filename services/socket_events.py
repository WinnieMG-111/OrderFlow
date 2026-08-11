"""
All Flask-SocketIO event handling lives in this single module:

1. Handlers for events the CLIENT sends to the server
   (connect, disconnect, join_order_room, join_kitchen_room, customer_connected)

2. Helper functions the REST routes (orders.py, kitchen.py, payments.py)
   call to push events OUT to connected clients (new_order,
   order_received, order_preparing, order_ready, order_completed,
   order_cancelled, payment_success, payment_failed).

Room strategy
- Every customer's browser joins a room named f"order_{order_id}" right
  after placing an order, so status/payment updates are only ever sent
  to that one customer - never broadcast to every tablet in the
  restaurant.
- Every kitchen dashboard joins a single shared "kitchen" room, so all
  kitchen staff screens update together the instant a new order comes in.
"""

import logging

from flask import request
from flask_socketio import join_room, leave_room

from extensions import socketio

logger = logging.getLogger(__name__)

KITCHEN_ROOM = "kitchen"

# Maps an order_status value (as stored in the `orders` table) to the
# Socket.IO event name broadcast to that order's customer room.
ORDER_STATUS_EVENT_MAP = {
    "Pending": "order_received",
    "Preparing": "order_preparing",
    "Ready": "order_ready",
    "Completed": "order_completed",
    "Cancelled": "order_cancelled",
}


# INBOUND EVENTS (client -> server)

@socketio.on("connect")
def handle_connect():
    """Fired automatically whenever any client (customer or kitchen) connects."""
    logger.info("Socket client connected: sid=%s", request.sid)


@socketio.on("disconnect")
def handle_disconnect():
    """Fired automatically whenever any client disconnects."""
    logger.info("Socket client disconnected: sid=%s", request.sid)


@socketio.on("customer_connected")
def handle_customer_connected(data):
    """
    Sent by a customer tablet as soon as the ordering page loads
    (before an order exists yet). Currently used only for presence
    logging; kept as its own event so the frontend has a clear
    "I'm alive" signal to send on page load.

    Expected payload: {"table_id": int, "seat_number": int}
    """
    table_id = (data or {}).get("table_id")
    seat_number = (data or {}).get("seat_number")
    logger.info(
        "Customer connected: sid=%s table_id=%s seat_number=%s",
        request.sid, table_id, seat_number,
    )


@socketio.on("join_order_room")
def handle_join_order_room(data):
    """
    Sent by a customer's browser right after an order is created
    (i.e. right after POST /orders succeeds). Joins a private room
    so this browser - and only this browser - receives status and
    payment events for that specific order.

    Expected payload: {"order_id": int}
    """
    order_id = (data or {}).get("order_id")
    if order_id is None:
        logger.warning("join_order_room called without an order_id: sid=%s", request.sid)
        return

    room_name = f"order_{order_id}"
    join_room(room_name)
    logger.info("sid=%s joined room %s", request.sid, room_name)


@socketio.on("join_kitchen_room")
def handle_join_kitchen_room():
    """
    Sent by the kitchen dashboard on page load. Joins the shared
    kitchen room so every kitchen screen receives new_order events
    and status-change echoes together.
    """
    join_room(KITCHEN_ROOM)
    logger.info("sid=%s joined kitchen room", request.sid)


@socketio.on("leave_order_room")
def handle_leave_order_room(data):
    """Optional cleanup: called when a customer's order flow ends/resets."""
    order_id = (data or {}).get("order_id")
    if order_id is not None:
        leave_room(f"order_{order_id}")
        logger.info("sid=%s left room order_%s", request.sid, order_id)


# OUTBOUND EVENT HELPERS (server -> client)
# Called from routes/*.py after a successful DB write.

def notify_kitchen_new_order(order_payload):
    """
    Emit 'new_order' to every kitchen dashboard.

    Args:
        order_payload (dict): full order details (order_id, table_number,
            seat_number, items, total_amount, created_at, etc.)
    """
    socketio.emit("new_order", order_payload, room=KITCHEN_ROOM)
    logger.info("Emitted new_order to kitchen room: order_id=%s", order_payload.get("order_id"))


def notify_order_status_change(order_id, new_status, order_payload=None):
    """
    Emit the appropriate status event (order_received / order_preparing /
    order_ready / order_completed / order_cancelled) to a specific
    customer's private room, AND echo it to the kitchen room so every
    kitchen screen stays in sync.

    Args:
        order_id (int): the order whose status changed.
        new_status (str): one of Pending, Preparing, Ready, Completed, Cancelled.
        order_payload (dict, optional): extra data to send with the event.
    """
    event_name = ORDER_STATUS_EVENT_MAP.get(new_status)
    if event_name is None:
        logger.warning("Unknown order_status '%s' for order_id=%s - no event emitted", new_status, order_id)
        return

    payload = order_payload or {}
    payload["order_id"] = order_id
    payload["order_status"] = new_status

    room_name = f"order_{order_id}"
    socketio.emit(event_name, payload, room=room_name)
    socketio.emit("order_status_updated", payload, room=KITCHEN_ROOM)
    logger.info("Emitted %s to %s (and echoed to kitchen)", event_name, room_name)


def notify_payment_success(order_id, payment_payload):
    """
    Emit 'payment_success' to the customer's private order room, and
    let the kitchen know the order is now paid and ready to prepare.
    """
    payload = payment_payload or {}
    payload["order_id"] = order_id

    socketio.emit("payment_success", payload, room=f"order_{order_id}")
    socketio.emit("payment_success", payload, room=KITCHEN_ROOM)
    logger.info("Emitted payment_success for order_id=%s", order_id)


def notify_payment_failed(order_id, payment_payload):
    """Emit 'payment_failed' to the customer's private order room only."""
    payload = payment_payload or {}
    payload["order_id"] = order_id

    socketio.emit("payment_failed", payload, room=f"order_{order_id}")
    logger.info("Emitted payment_failed for order_id=%s", order_id)