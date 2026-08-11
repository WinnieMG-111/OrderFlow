"""
routes/payments.py

Payment endpoints:
- POST /payments/mpesa           - initiate an STK Push for an order
- POST /payments/callback        - Safaricom's async result webhook
- GET  /payments/status/<order_id> - poll-friendly payment status lookup

All Daraja request/response handling is delegated to services/mpesa.py -
this module only ever deals with our own database rows and Socket.IO
notifications.

Security notes
---------------
- The payment amount is ALWAYS read from orders.total_amount in the
  database, never accepted from the client, so a customer can't pay a
  manipulated amount.
- /payments/callback is called directly by Safaricom's servers (no
  browser session), so it must not depend on Flask session state, and
  must always return a 200 JSON acknowledgement so Safaricom doesn't
  endlessly retry the webhook.
"""

import logging

from flask import Blueprint, jsonify, request, session

from db import execute_query, fetch_one
from services.mpesa import MpesaError, initiate_stk_push, parse_stk_callback, query_stk_status
from services.socket_events import notify_payment_failed, notify_payment_success

logger = logging.getLogger(__name__)

payments_bp = Blueprint("payments", __name__, url_prefix="/payments")


# =================================================================
# INTERNAL HELPERS
# =================================================================

def _finalize_payment_success(order_id, payment, result):
    """Mark a payment (and its order) as paid, and notify everyone."""
    execute_query(
        """
        UPDATE payments
        SET payment_status = 'Paid',
            transaction_code = %s,
            amount = %s,
            paid_at = NOW()
        WHERE payment_id = %s
        """,
        (
            result.get("mpesa_receipt_number"),
            result.get("amount") or payment["amount"],
            payment["payment_id"],
        ),
    )
    execute_query(
        "UPDATE orders SET payment_status = 'Paid' WHERE order_id = %s",
        (order_id,),
    )

    notify_payment_success(
        order_id,
        {
            "transaction_code": result.get("mpesa_receipt_number"),
            "amount": result.get("amount") or float(payment["amount"]),
        },
    )
    logger.info("Payment completed for order_id=%s (receipt=%s)", order_id, result.get("mpesa_receipt_number"))


def _finalize_payment_failure(order_id, payment, reason):
    """Mark a payment as failed and notify the customer."""
    execute_query(
        "UPDATE payments SET payment_status = 'Failed' WHERE payment_id = %s",
        (payment["payment_id"],),
    )
    notify_payment_failed(order_id, {"reason": reason})
    logger.info("Payment failed for order_id=%s: %s", order_id, reason)


# =================================================================
# ROUTES
# =================================================================

@payments_bp.route("/mpesa", methods=["POST"])
def initiate_payment():
    """
    Kick off an M-Pesa STK Push for an order.
    Body: {"order_id": int, "phone_number": str}
    """
    data = request.get_json(silent=True) or {}
    order_id = data.get("order_id")
    phone_number = data.get("phone_number")

    if not order_id or not phone_number:
        return jsonify({"error": "order_id and phone_number are required."}), 400

    order = fetch_one(
        "SELECT order_id, table_id, total_amount, payment_status, order_status FROM orders WHERE order_id = %s",
        (order_id,),
    )
    if not order:
        return jsonify({"error": "Order not found."}), 404

    # A tablet may only pay for its own table's order.
    if "table_id" in session and order["table_id"] != session["table_id"]:
        return jsonify({"error": "This order does not belong to this table."}), 403

    if order["order_status"] == "Cancelled":
        return jsonify({"error": "This order has been cancelled and cannot be paid for."}), 400
    if order["payment_status"] == "Paid":
        return jsonify({"error": "This order has already been paid for."}), 400

    # Amount always comes from the order itself - never from the client.
    amount = order["total_amount"]

    try:
        stk_response = initiate_stk_push(phone_number, amount, order_id)
    except MpesaError as exc:
        logger.error("STK push failed for order_id=%s: %s", order_id, exc)
        return jsonify({"error": str(exc)}), 502

    merchant_request_id = stk_response.get("MerchantRequestID")
    checkout_request_id = stk_response.get("CheckoutRequestID")

    try:
        execute_query(
            """
            INSERT INTO payments (order_id, amount, payment_method, payment_status,
                                   merchant_request_id, checkout_request_id)
            VALUES (%s, %s, 'M-Pesa', 'Pending', %s, %s)
            """,
            (order_id, amount, merchant_request_id, checkout_request_id),
        )
    except Exception as exc:
        logger.error("Failed to save pending payment for order_id=%s: %s", order_id, exc)
        return jsonify({"error": "Payment was initiated but could not be recorded. Contact staff."}), 500

    return jsonify(
        {
            "message": "STK Push sent. Please enter your M-Pesa PIN on your phone.",
            "merchant_request_id": merchant_request_id,
            "checkout_request_id": checkout_request_id,
        }
    ), 200


@payments_bp.route("/callback", methods=["POST"])
def mpesa_callback():
    """
    Safaricom Daraja posts the final STK Push result here. This endpoint
    has no Flask session (it's called server-to-server) and must always
    return a 200 JSON acknowledgement, regardless of what happened
    internally, or Safaricom will keep retrying the callback.
    """
    raw_payload = request.get_json(silent=True) or {}
    ack = {"ResultCode": 0, "ResultDesc": "Callback received successfully"}

    try:
        result = parse_stk_callback(raw_payload)
    except MpesaError as exc:
        logger.error("Could not parse M-Pesa callback payload: %s", exc)
        return jsonify(ack), 200

    payment = fetch_one(
        "SELECT payment_id, order_id, amount FROM payments WHERE checkout_request_id = %s",
        (result["checkout_request_id"],),
    )
    if not payment:
        logger.error(
            "Received M-Pesa callback for unknown checkout_request_id=%s",
            result["checkout_request_id"],
        )
        return jsonify(ack), 200

    try:
        if result["success"]:
            _finalize_payment_success(payment["order_id"], payment, result)
        else:
            _finalize_payment_failure(payment["order_id"], payment, result["result_desc"])
    except Exception as exc:
        logger.error("Failed to process M-Pesa callback for order_id=%s: %s", payment["order_id"], exc)

    return jsonify(ack), 200


@payments_bp.route("/status/<int:order_id>", methods=["GET"])
def payment_status(order_id):
    """
    Return the current payment status for an order. If it's still
    'Pending' and Daraja hasn't sent a callback yet, proactively query
    Daraja directly as a fallback (e.g. in case the callback was lost).
    """
    payment = fetch_one(
        """
        SELECT payment_id, order_id, amount, payment_method, payment_status,
               checkout_request_id, transaction_code, paid_at
        FROM payments
        WHERE order_id = %s
        ORDER BY payment_id DESC
        LIMIT 1
        """,
        (order_id,),
    )
    if not payment:
        return jsonify({"error": "No payment found for this order."}), 404

    if payment["payment_status"] == "Pending" and payment["checkout_request_id"]:
        try:
            query_result = query_stk_status(payment["checkout_request_id"])
            result_code = query_result.get("ResultCode")
            if result_code is not None and str(result_code) == "0":
                _finalize_payment_success(order_id, payment, {"mpesa_receipt_number": None, "amount": None})
                payment["payment_status"] = "Paid"
            elif result_code is not None and str(result_code) != "1032":
                # 1032 = "request cancelled by user" is still in-flight/ambiguous
                # in some Daraja sandbox responses; anything else definitive
                # that isn't a success is treated as a failure.
                _finalize_payment_failure(order_id, payment, query_result.get("ResultDesc", "Payment failed."))
                payment["payment_status"] = "Failed"
        except MpesaError as exc:
            # Non-fatal: just report the last known DB status if the
            # live query fails.
            logger.warning("Could not refresh payment status for order_id=%s: %s", order_id, exc)

    return jsonify(payment), 200