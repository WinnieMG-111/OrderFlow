"""
routes/customer.py

Customer-facing blueprint: covers three concerns -

1. Tablet / table configuration (not in the original endpoint list, but
   required infrastructure - see note below).
2. Menu browsing endpoints (GET /menu, /categories, /menu/category/<id>,
   /menu/search, /menu/<id>).
3. The session-based shopping cart (GET/POST/PUT /cart, DELETE /cart/<item_id>).

Design note - how a tablet "knows" its table number
-----------------------------------------------------
One Flask backend serves every table, so the table number can't live in
a single global config value. Instead, restaurant staff visit
GET /table/<table_number> ONCE per physical tablet (e.g. bookmark that
URL as the browser's home page). That route stores table_id in the
tablet's Flask session with a long lifetime (see PERMANENT_SESSION_LIFETIME
in config.py) and the tablet is never asked for its table number again.
The customer only ever enters a seat number, and only when placing an
order (see routes/orders.py) - it isn't needed earlier, since the cart
itself is scoped to the tablet's session, not to a particular seat.
"""

import logging

from flask import Blueprint, jsonify, redirect, render_template, request, session, url_for

from db import fetch_all, fetch_one
from services.cart import (
    MAX_ITEM_QUANTITY,
    build_cart_response,
    get_cart_dict,
    save_cart_dict,
    validate_quantity,
)

logger = logging.getLogger(__name__)

customer_bp = Blueprint("customer", __name__)


# =================================================================
# TABLET / TABLE CONFIGURATION + PAGE ROUTES
# =================================================================

@customer_bp.route("/table/<int:table_number>")
def configure_table(table_number):
    """
    One-time setup route for a physical tablet. Looks up the table,
    stores its table_id permanently in this browser's session, and
    redirects to the main ordering page. Visiting this URL again
    (e.g. if the tablet's session ever expires) simply re-configures it.
    """
    try:
        table = fetch_one(
            "SELECT table_id, table_number FROM restaurant_tables WHERE table_number = %s",
            (table_number,),
        )
    except Exception as exc:
        logger.error("Failed to look up table_number=%s: %s", table_number, exc)
        return render_template(
            "customer/error.html",
            message="Could not connect to the restaurant's system. Please contact staff.",
        ), 500

    if not table:
        return render_template("customer/error.html", message=f"Table {table_number} is not registered."), 404

    session.permanent = True
    session["table_id"] = table["table_id"]
    session["table_number"] = table["table_number"]
    logger.info("Tablet configured for table_number=%s (table_id=%s)", table_number, table["table_id"])

    return redirect(url_for("customer.index"))


@customer_bp.route("/")
def index():
    """
    Main customer ordering page. Requires this tablet to have already
    been configured via /table/<table_number>; otherwise there is no
    way to know which table an order should be attributed to.
    """
    if "table_id" not in session:
        return render_template(
            "customer/error.html",
            message="This tablet has not been set up yet. Please contact staff.",
        ), 400

    return render_template(
        "customer/index.html",
        table_number=session.get("table_number"),
    )


# =================================================================
# MENU BROWSING
# =================================================================

@customer_bp.route("/menu", methods=["GET"])
def get_menu():
    """Return all menu items, with their category name attached."""
    try:
        items = fetch_all(
            """
            SELECT mi.item_id, mi.category_id, mi.item_name,
                   mi.price, mi.image, c.category_name
            FROM menu_items mi
            JOIN categories c ON c.category_id = mi.category_id
            ORDER BY c.category_name, mi.item_name
            """
        )
        return jsonify({"menu": items}), 200
    except Exception as exc:
        logger.error("Failed to fetch menu: %s", exc)
        return jsonify({"error": "Could not load the menu right now."}), 500


@customer_bp.route("/categories", methods=["GET"])
def get_categories():
    """Return all menu categories."""
    try:
        categories = fetch_all(
            "SELECT category_id, category_name FROM categories ORDER BY category_name"
        )
        return jsonify({"categories": categories}), 200
    except Exception as exc:
        logger.error("Failed to fetch categories: %s", exc)
        return jsonify({"error": "Could not load categories right now."}), 500


@customer_bp.route("/menu/category/<int:category_id>", methods=["GET"])
def get_menu_by_category(category_id):
    """Return menu items belonging to a single category."""
    try:
        category = fetch_one(
            "SELECT category_id FROM categories WHERE category_id = %s", (category_id,)
        )
        if not category:
            return jsonify({"error": "Category not found."}), 404

        items = fetch_all(
            """
            SELECT item_id, category_id, item_name, price, image
            FROM menu_items
            WHERE category_id = %s
            ORDER BY item_name
            """,
            (category_id,),
        )
        return jsonify({"menu": items}), 200
    except Exception as exc:
        logger.error("Failed to fetch menu for category_id=%s: %s", category_id, exc)
        return jsonify({"error": "Could not load this category right now."}), 500


@customer_bp.route("/menu/search", methods=["GET"])
def search_menu():
    """
    Search menu items by name.
    Query string: /menu/search?q=chicken
    """
    search_term = (request.args.get("q") or "").strip()
    if not search_term:
        return jsonify({"error": "Query parameter 'q' is required."}), 400
    if len(search_term) > 100:
        return jsonify({"error": "Search term is too long."}), 400

    try:
        items = fetch_all(
            """
            SELECT item_id, category_id, item_name, price, image
            FROM menu_items
            WHERE item_name LIKE %s
            ORDER BY item_name
            """,
            (f"%{search_term}%",),
        )
        return jsonify({"menu": items}), 200
    except Exception as exc:
        logger.error("Menu search failed for term='%s': %s", search_term, exc)
        return jsonify({"error": "Search failed. Please try again."}), 500


@customer_bp.route("/menu/<int:item_id>", methods=["GET"])
def get_menu_item(item_id):
    """Return a single menu item's full details."""
    try:
        item = fetch_one(
            """
            SELECT mi.item_id, mi.category_id, mi.item_name,
                   mi.price, mi.image, c.category_name
            FROM menu_items mi
            JOIN categories c ON c.category_id = mi.category_id
            WHERE mi.item_id = %s
            """,
            (item_id,),
        )
        if not item:
            return jsonify({"error": "Menu item not found."}), 404
        return jsonify({"item": item}), 200
    except Exception as exc:
        logger.error("Failed to fetch menu item_id=%s: %s", item_id, exc)
        return jsonify({"error": "Could not load this item right now."}), 500


# =================================================================
# CART (stored in Flask session as {item_id_str: quantity})
# =================================================================

@customer_bp.route("/cart", methods=["GET"])
def get_cart():
    """Return the current cart with live prices and a computed total."""
    try:
        return jsonify(build_cart_response()), 200
    except Exception as exc:
        logger.error("Failed to build cart response: %s", exc)
        return jsonify({"error": "Could not load your cart right now."}), 500


@customer_bp.route("/cart", methods=["POST"])
def add_to_cart():
    """
    Add an item to the cart, or increase its quantity if already present.
    Body: {"item_id": int, "quantity": int}
    """
    data = request.get_json(silent=True) or {}
    item_id = data.get("item_id")
    quantity, error = validate_quantity(data.get("quantity", 1))

    if item_id is None:
        return jsonify({"error": "item_id is required."}), 400
    if error:
        return jsonify({"error": error}), 400

    try:
        item = fetch_one(
            "SELECT item_id FROM menu_items WHERE item_id = %s", (item_id,)
        )
        if not item:
            return jsonify({"error": "Menu item not found."}), 404

        cart = get_cart_dict()
        item_key = str(item_id)
        cart[item_key] = cart.get(item_key, 0) + quantity
        if cart[item_key] > MAX_ITEM_QUANTITY:
            return jsonify({"error": f"Quantity cannot exceed {MAX_ITEM_QUANTITY}."}), 400
        save_cart_dict(cart)

        return jsonify(build_cart_response()), 201
    except Exception as exc:
        logger.error("Failed to add item_id=%s to cart: %s", item_id, exc)
        return jsonify({"error": "Could not add item to cart."}), 500


@customer_bp.route("/cart", methods=["PUT"])
def update_cart_item():
    """
    Set an existing cart item's quantity to an exact value.
    Body: {"item_id": int, "quantity": int}
    """
    data = request.get_json(silent=True) or {}
    item_id = data.get("item_id")
    quantity, error = validate_quantity(data.get("quantity"))

    if item_id is None:
        return jsonify({"error": "item_id is required."}), 400
    if error:
        return jsonify({"error": error}), 400

    cart = get_cart_dict()
    item_key = str(item_id)
    if item_key not in cart:
        return jsonify({"error": "Item is not in the cart."}), 404

    cart[item_key] = quantity
    save_cart_dict(cart)

    try:
        return jsonify(build_cart_response()), 200
    except Exception as exc:
        logger.error("Failed to update item_id=%s in cart: %s", item_id, exc)
        return jsonify({"error": "Could not update your cart."}), 500


@customer_bp.route("/cart/<int:item_id>", methods=["DELETE"])
def remove_from_cart(item_id):
    """Remove a single item from the cart entirely."""
    cart = get_cart_dict()
    item_key = str(item_id)
    if item_key not in cart:
        return jsonify({"error": "Item is not in the cart."}), 404

    del cart[item_key]
    save_cart_dict(cart)

    try:
        return jsonify(build_cart_response()), 200
    except Exception as exc:
        logger.error("Failed to remove item_id=%s from cart: %s", item_id, exc)
        return jsonify({"error": "Could not update your cart."}), 500