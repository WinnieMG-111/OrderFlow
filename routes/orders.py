"""
routes/orders.py

Order lifecycle endpoints:
- POST /orders                  - place a new order from the current cart
- GET  /orders/<id>              - full order details (order + line items)
- GET  /orders/status/<id>       - lightweight status-only lookup

Design note - where "cart items" come from
--------------------------------------------
The spec says POST /orders receives "seat_number" and "cart items".
Rather than trusting a second, independently-submitted cart payload
from the client (which would let a customer resubmit stale or tampered
prices), this endpoint uses the SAME session cart built up through
GET/POST/PUT/DELETE /cart in routes/customer.py, re-priced live from
the database via services/cart.py. That is the "cart items" being
received - it just arrives via the session rather than the request
body. The request body only needs to supply seat_number.
"""

import logging
from datetime import datetime

from flask import Blueprint, jsonify, request, session

from db import execute_many, execute_query, fetch_all, fetch_one
from services.cart import build_cart_response, clear_cart
from services.socket_events import notify_kitchen_new_order

logger = logging.getLogger(__name__)

orders_bp = Blueprint("orders", __name__)

MIN_SEAT_NUMBER = 1
MAX_SEAT_NUMBER = 50


def _validate_seat_number(raw_seat_number):
    """
    Validate the seat number submitted at checkout.

    Returns:
        (int|None, str|None): (seat_number, None) if valid, else (None, error_message).
    """
    try:
        seat_number = int(raw_seat_number)
    except (TypeError, ValueError):
        return None, "Seat number must be a whole number."
    if seat_number < MIN_SEAT_NUMBER or seat_number > MAX_SEAT_NUMBER:
        return None, f"Seat number must be between {MIN_SEAT_NUMBER} and {MAX_SEAT_NUMBER}."
    return seat_number, None


@orders_bp.route("/orders", methods=["POST"])
def create_order():
    """
    Place a new order.

    Body: {"seat_number": int}

    table_id comes from this tablet's session (see routes/customer.py's
    /table/<table_number> setup route) - the customer never supplies it.
    Cart items come from the session cart, priced live from the database.
    """
    if "table_id" not in session:
        return jsonify({"error": "This tablet has not been configured with a table. Please contact staff."}), 400

    data = request.get_json(silent=True) or {}
    seat_number, error = _validate_seat_number(data.get("seat_number"))
    if error:
        return jsonify({"error": error}), 400

    cart = build_cart_response()
    if not cart["items"]:
        return jsonify({"error": "Your cart is empty."}), 400

    table_id = session["table_id"]

    try:
        # 1. Insert the order header first so we get an order_id to
        #    attach the line items to.
        order_result = execute_query(
            """
            INSERT INTO orders (table_id, seat_id, total_amount, order_status, payment_status, created_at)
            VALUES (%s, %s, %s, 'Pending', 'Pending', NOW())
            """,
            (table_id, seat_number, cart["total_amount"]),
        )
        order_id = order_result["lastrowid"]

        # 2. Bulk-insert every cart line as an order_item row.
        order_item_rows = [
            (order_id, item["item_id"], item["quantity"], item["unit_price"], item["subtotal"])
            for item in cart["items"]
        ]
        execute_many(
            """
            INSERT INTO order_items (order_id, item_id, quantity, unit_price, subtotal)
            VALUES (%s, %s, %s, %s, %s)
            """,
            order_item_rows,
        )

        # 3. Cart has been "checked out" - empty it for this tablet.
        clear_cart()

    except Exception as exc:
        logger.error("Failed to create order for table_id=%s: %s", table_id, exc)
        return jsonify({"error": "Could not place your order. Please try again."}), 500

    # 4. Notify the kitchen dashboard in real time.
    table = fetch_one("SELECT table_number FROM restaurant_tables WHERE table_id = %s", (table_id,))
    kitchen_payload = {
        "order_id": order_id,
        "table_number": table["table_number"] if table else None,
        "seat_number": seat_number,
        "items": cart["items"],
        "total_amount": cart["total_amount"],
        "order_status": "Pending",
        "payment_status": "Pending",
        "created_at": datetime.now().isoformat(),
    }
    notify_kitchen_new_order(kitchen_payload)

    logger.info("Order created: order_id=%s table_id=%s seat_number=%s total=%s",
                order_id, table_id, seat_number, cart["total_amount"])

    return jsonify({"order_id": order_id, "total_amount": cart["total_amount"]}), 201


@orders_bp.route("/orders/<int:order_id>", methods=["GET"])
def get_order(order_id):
    """Return an order's full details, including its line items."""
    try:
        order = fetch_one(
            """
            SELECT o.order_id, o.table_id, t.table_number, o.seat_id AS seat_number,
                   o.total_amount, o.order_status, o.payment_status, o.created_at
            FROM orders o
            JOIN restaurant_tables t ON t.table_id = o.table_id
            WHERE o.order_id = %s
            """,
            (order_id,),
        )
        if not order:
            return jsonify({"error": "Order not found."}), 404

        items = fetch_all(
            """
            SELECT oi.order_item_id, oi.item_id, mi.item_name, oi.quantity,
                   oi.unit_price, oi.subtotal
            FROM order_items oi
            JOIN menu_items mi ON mi.item_id = oi.item_id
            WHERE oi.order_id = %s
            """,
            (order_id,),
        )
        order["items"] = items
        return jsonify({"order": order}), 200
    except Exception as exc:
        logger.error("Failed to fetch order_id=%s: %s", order_id, exc)
        return jsonify({"error": "Could not load this order right now."}), 500


@orders_bp.route("/orders/status/<int:order_id>", methods=["GET"])
def get_order_status(order_id):
    """
    Lightweight status-only lookup, used by the customer's live progress
    tracker as a fallback/initial value alongside the Socket.IO stream.
    """
    try:
        order = fetch_one(
            "SELECT order_id, order_status, payment_status FROM orders WHERE order_id = %s",
            (order_id,),
        )
        if not order:
            return jsonify({"error": "Order not found."}), 404
        return jsonify(order), 200
    except Exception as exc:
        logger.error("Failed to fetch status for order_id=%s: %s", order_id, exc)
        return jsonify({"error": "Could not load order status right now."}), 500