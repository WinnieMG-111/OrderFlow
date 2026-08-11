"""
services/cart.py

Shared session-based shopping cart logic.

The cart lives in the Flask session as a simple {item_id_str: quantity}
dict. This module is the single place that reads/writes it and prices
it against the database - both routes/customer.py (browsing/editing
the cart) and routes/orders.py (checkout) import from here, so the
two can never drift out of sync with each other.
"""

import logging

from flask import session

from db import fetch_all

logger = logging.getLogger(__name__)

MAX_ITEM_QUANTITY = 50


def get_cart_dict():
    """Read the raw cart {item_id_str: quantity} out of the session."""
    return session.get("cart", {})


def save_cart_dict(cart):
    """Persist the raw cart dict back into the session."""
    session["cart"] = cart
    session.modified = True


def clear_cart():
    """Empty the cart, called after an order is successfully placed."""
    session["cart"] = {}
    session.modified = True


def validate_quantity(raw_quantity):
    """
    Validate a quantity value from client input.

    Returns:
        (int|None, str|None): (quantity, None) if valid, else (None, error_message).
    """
    try:
        quantity = int(raw_quantity)
    except (TypeError, ValueError):
        return None, "Quantity must be a whole number."
    if quantity < 1:
        return None, "Quantity must be at least 1."
    if quantity > MAX_ITEM_QUANTITY:
        return None, f"Quantity cannot exceed {MAX_ITEM_QUANTITY}."
    return quantity, None


def build_cart_response():
    """
    Turn the raw session cart into a full response: current item
    details/price pulled live from the database (never trust a price
    cached client-side), plus a computed total.

    Returns:
        dict: {"items": [...], "total_amount": float}
    """
    cart = get_cart_dict()
    if not cart:
        return {"items": [], "total_amount": 0}

    item_ids = [int(item_id) for item_id in cart.keys()]
    placeholders = ",".join(["%s"] * len(item_ids))
    rows = fetch_all(
        f"""
        SELECT item_id, item_name, price, image
        FROM menu_items
        WHERE item_id IN ({placeholders})
        """,
        tuple(item_ids),
    )
    items_by_id = {row["item_id"]: row for row in rows}

    cart_items = []
    total_amount = 0
    for item_id_str, quantity in cart.items():
        item_id = int(item_id_str)
        item = items_by_id.get(item_id)
        if not item:
            # Item was deleted from the menu since it was added to the
            # cart - skip it rather than crash the whole cart response.
            continue
        subtotal = float(item["price"]) * quantity
        total_amount += subtotal
        cart_items.append(
            {
                "item_id": item_id,
                "item_name": item["item_name"],
                "unit_price": float(item["price"]),
                "image": item["image"],
                "quantity": quantity,
                "subtotal": round(subtotal, 2),
            }
        )

    return {"items": cart_items, "total_amount": round(total_amount, 2)}