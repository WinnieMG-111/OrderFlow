"""
routes/kitchen.py

Kitchen dashboard endpoints:
- GET   /kitchen/orders        - all active (not yet completed/cancelled) orders
- PATCH /kitchen/orders/<id>   - change an order's status, notifying the customer live

Design note - payment vs. order visibility
--------------------------------------------
routes/orders.py inserts the order (order_status='Pending', payment_status=
'Pending') and emits 'new_order' to the kitchen the moment checkout happens,
per the ORDERS section of the spec ("Emit Socket.IO event to kitchen" is
listed as part of POST /orders itself). This endpoint therefore returns
ALL active orders regardless of payment_status, but includes payment_status
in every response so the kitchen UI can visually flag unpaid orders as
"awaiting payment" rather than hiding them outright. If you'd instead
prefer the kitchen to only ever see orders once payment_status='Paid',
that's a one-line WHERE clause change here - just say the word.
"""

import logging

from flask import Blueprint, jsonify, render_template, request

from db import execute_query, fetch_all, fetch_one
from services.socket_events import notify_order_status_change

logger = logging.getLogger(__name__)

kitchen_bp = Blueprint("kitchen", __name__, url_prefix="/kitchen")

ALLOWED_STATUSES = {"Pending", "Preparing", "Ready", "Completed", "Cancelled"}
TERMINAL_STATUSES = {"Completed", "Cancelled"}


@kitchen_bp.route("/", methods=["GET"])
def dashboard():
    """
    Render the kitchen dashboard page. All data is loaded client-side via
    GET /kitchen/orders on load, then kept live via Socket.IO (new_order,
    order_status_updated) - no server-side rendering of order data here.
    """
    return render_template("kitchen/dashboard.html")


@kitchen_bp.route("/orders", methods=["GET"])
def get_active_orders():
    """
    Return every order that isn't finished yet (Completed/Cancelled),
    oldest first, each with its line items attached so the kitchen
    dashboard can render a full ticket without extra requests.
    """
    try:
        orders = fetch_all(
            """
            SELECT o.order_id, o.table_id, t.table_number, o.seat_id AS seat_number,
                   o.total_amount, o.order_status, o.payment_status, o.created_at
            FROM orders o
            JOIN restaurant_tables t ON t.table_id = o.table_id
            WHERE o.order_status NOT IN ('Completed', 'Cancelled')
            ORDER BY o.created_at ASC
            """
        )

        if orders:
            order_ids = [order["order_id"] for order in orders]
            placeholders = ",".join(["%s"] * len(order_ids))
            all_items = fetch_all(
                f"""
                SELECT oi.order_id, oi.item_id, mi.item_name, oi.quantity,
                       oi.unit_price, oi.subtotal
                FROM order_items oi
                JOIN menu_items mi ON mi.item_id = oi.item_id
                WHERE oi.order_id IN ({placeholders})
                """,
                tuple(order_ids),
            )
            items_by_order = {}
            for item in all_items:
                items_by_order.setdefault(item["order_id"], []).append(item)
            for order in orders:
                order["items"] = items_by_order.get(order["order_id"], [])

        return jsonify({"orders": orders}), 200
    except Exception as exc:
        logger.error("Failed to fetch active kitchen orders: %s", exc)
        return jsonify({"error": "Could not load active orders right now."}), 500


@kitchen_bp.route("/orders/<int:order_id>", methods=["PATCH"])
def update_order_status(order_id):
    """
    Change an order's status. Body: {"status": "Preparing"}
    Allowed values: Pending, Preparing, Ready, Completed, Cancelled.
    Notifies the customer's private room in real time via Socket.IO.
    """
    data = request.get_json(silent=True) or {}
    new_status = data.get("status")

    if new_status not in ALLOWED_STATUSES:
        return jsonify(
            {"error": f"status must be one of: {', '.join(sorted(ALLOWED_STATUSES))}"}
        ), 400

    try:
        order = fetch_one(
            "SELECT order_id, order_status FROM orders WHERE order_id = %s", (order_id,)
        )
        if not order:
            return jsonify({"error": "Order not found."}), 404

        if order["order_status"] in TERMINAL_STATUSES:
            return jsonify(
                {"error": f"Order is already {order['order_status']} and cannot be changed."}
            ), 400

        execute_query(
            "UPDATE orders SET order_status = %s WHERE order_id = %s",
            (new_status, order_id),
        )
    except Exception as exc:
        logger.error("Failed to update status for order_id=%s: %s", order_id, exc)
        return jsonify({"error": "Could not update order status."}), 500

    # Real-time push to the customer tracking their order, and an echo
    # to the kitchen room so every kitchen screen stays in sync.
    notify_order_status_change(order_id, new_status)

    logger.info("Order status updated: order_id=%s -> %s", order_id, new_status)
    return jsonify({"order_id": order_id, "order_status": new_status}), 200