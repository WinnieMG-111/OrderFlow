"""
All Safaricom Daraja API (M-Pesa) logic lives in this module and
nowhere else. Routes (routes/payments.py) call these functions and
handle the HTTP layer + database updates + Socket.IO emits; this
module only knows how to talk to Daraja.

Implements:
- OAuth access token retrieval (cached until expiry)
- Timestamp generation
- Password generation
- STK Push (Lipa Na M-Pesa Online)
- STK Push callback parsing
- STK Push status query (in case the callback is delayed/lost)

No Flask request/response objects are used here — this module is
transport-agnostic so it can be unit tested in isolation.
"""

import base64
import logging
import re
from datetime import datetime, timedelta

import requests

from config import Config

logger = logging.getLogger(__name__)

# Simple in-process cache for the OAuth token so we don't request a
# fresh one on every single STK push (Daraja tokens are valid ~1hr).
_token_cache = {"access_token": None, "expires_at": None}

REQUEST_TIMEOUT = 30

# Daraja result codes
RESULT_SUCCESS = 0
RESULT_USER_CANCELLED = 1032
RESULT_INSUFFICIENT_FUNDS = 1

class MpesaError(Exception):
    """Raised for any Daraja API failure (auth, STK push, or query)."""
    pass


def get_access_token():
    """Fetch (or reuse a cached) OAuth access token from Daraja."""
    now = datetime.now()

    if _token_cache["access_token"] and _token_cache["expires_at"] and now < _token_cache["expires_at"]:
        return _token_cache["access_token"]

    if not Config.MPESA_CONSUMER_KEY or not Config.MPESA_CONSUMER_SECRET:
        raise MpesaError("M-Pesa consumer key/secret are not configured.")

    url = f"{Config.MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials"

    try:
        response = requests.get(
            url,
            auth=(Config.MPESA_CONSUMER_KEY, Config.MPESA_CONSUMER_SECRET),
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
    except requests.RequestException as exc:
        logger.exception("Failed to obtain M-Pesa access token: %s", exc)
        raise MpesaError("Could not reach M-Pesa authorization endpoint.") from exc
    except ValueError as exc:
        logger.exception("M-Pesa auth response was not valid JSON: %s", exc)
        raise MpesaError("Invalid response from M-Pesa authorization endpoint.") from exc

    access_token = data.get("access_token")
    expires_in = int(data.get("expires_in", 3599))

    if not access_token:
        logger.error("M-Pesa auth response missing access_token: %s", data)
        raise MpesaError("M-Pesa authorization response did not include a token.")

    _token_cache["access_token"] = access_token
    _token_cache["expires_at"] = now + timedelta(seconds=expires_in - 60)

    return access_token


def generate_timestamp():
    """Generate the Daraja-required timestamp string: YYYYMMDDHHMMSS."""
    return datetime.now().strftime("%Y%m%d%H%M%S")


def generate_password(timestamp: str):
    """Generate the Lipa Na M-Pesa Online password: base64(Shortcode+Passkey+Timestamp)."""
    if not Config.MPESA_PASSKEY:
        raise MpesaError("M-Pesa passkey is not configured.")

    raw = f"{Config.MPESA_SHORTCODE}{Config.MPESA_PASSKEY}{timestamp}"
    return base64.b64encode(raw.encode("utf-8")).decode("utf-8")


def normalize_phone_number(phone_number: str):
    """Normalize a Kenyan phone number to the 2547XXXXXXXX Daraja format."""
    if not phone_number:
        raise MpesaError("Phone number is required.")

    digits = re.sub(r"\D", "", phone_number.strip())

    if digits.startswith("0") and len(digits) == 10:
        digits = "254" + digits[1:]
    elif digits.startswith("7") or digits.startswith("1"):
        if len(digits) == 9:
            digits = "254" + digits
    elif digits.startswith("254"):
        pass

    if not re.fullmatch(r"254(7|1)\d{8}", digits):
        raise MpesaError(f"Invalid phone number format: {phone_number}")

    return digits


def initiate_stk_push(phone_number: str, amount, order_id: int, account_reference=None):
    """Trigger a Lipa Na M-Pesa Online (STK Push) prompt on the customer's phone."""
    try:
        amount_int = int(round(float(amount)))
    except (TypeError, ValueError) as exc:
        raise MpesaError(f"Invalid payment amount: {amount}") from exc

    if amount_int < 1:
        raise MpesaError("Payment amount must be at least 1.")

    normalized_phone = normalize_phone_number(phone_number)
    timestamp = generate_timestamp()
    password = generate_password(timestamp)
    access_token = get_access_token()

    payload = {
        "BusinessShortCode": Config.MPESA_SHORTCODE,
        "Password": password,
        "Timestamp": timestamp,
        "TransactionType": Config.MPESA_TRANSACTION_TYPE,
        "Amount": amount_int,
        "PartyA": normalized_phone,
        "PartyB": Config.MPESA_SHORTCODE,
        "PhoneNumber": normalized_phone,
        "CallBackURL": Config.MPESA_CALLBACK_URL,
        "AccountReference": account_reference or f"ORDER-{order_id}",
        "TransactionDesc": f"Payment for order {order_id}",
    }

    url = f"{Config.MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest"
    headers = {"Authorization": f"Bearer {access_token}"}

    try:
        response = requests.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT)
        data = response.json()
    except requests.RequestException as exc:
        logger.exception("STK push request failed for order %s: %s", order_id, exc)
        raise MpesaError("Could not reach M-Pesa STK push endpoint.") from exc
    except ValueError as exc:
        logger.exception("STK push response was not valid JSON for order %s: %s", order_id, exc)
        raise MpesaError("Invalid response from M-Pesa STK push endpoint.") from exc

    if response.status_code != 200 or data.get("ResponseCode") not in (None, "0"):
        error_message = data.get("errorMessage") or data.get("ResponseDescription") or "STK push was rejected."
        logger.error("STK push rejected for order %s: %s", order_id, data)
        raise MpesaError(error_message)

    logger.info(
        "STK push initiated for order %s (CheckoutRequestID=%s)",
        order_id, data.get("CheckoutRequestID"),
    )
    return data


def parse_stk_callback(callback_body: dict):
    """Parse the JSON body Daraja POSTs to /payments/callback into a flat dict."""
    try:
        stk_callback = callback_body["Body"]["stkCallback"]
    except (KeyError, TypeError) as exc:
        logger.error("Malformed M-Pesa callback body: %s", callback_body)
        raise MpesaError("Callback body missing Body.stkCallback.") from exc

    result_code = stk_callback.get("ResultCode")
    result = {
        "merchant_request_id": stk_callback.get("MerchantRequestID"),
        "checkout_request_id": stk_callback.get("CheckoutRequestID"),
        "result_code": result_code,
        "result_desc": stk_callback.get("ResultDesc"),
        "success": result_code == RESULT_SUCCESS,
        "amount": None,
        "transaction_code": None,
        "transaction_date": None,
        "phone_number": None,
    }

    metadata_items = stk_callback.get("CallbackMetadata", {}).get("Item", [])
    metadata = {item.get("Name"): item.get("Value") for item in metadata_items if "Name" in item}

    if "Amount" in metadata:
        result["amount"] = metadata["Amount"]
    if "MpesaReceiptNumber" in metadata:
        result["transaction_code"] = metadata["MpesaReceiptNumber"]
    if "TransactionDate" in metadata:
        result["transaction_date"] = str(metadata["TransactionDate"])
    if "PhoneNumber" in metadata:
        result["phone_number"] = str(metadata["PhoneNumber"])

    return result


def query_stk_status(checkout_request_id: str):
    """Actively query Daraja for the status of a previously-initiated STK push."""
    if not checkout_request_id:
        raise MpesaError("checkout_request_id is required.")

    timestamp = generate_timestamp()
    password = generate_password(timestamp)
    access_token = get_access_token()

    payload = {
        "BusinessShortCode": Config.MPESA_SHORTCODE,
        "Password": password,
        "Timestamp": timestamp,
        "CheckoutRequestID": checkout_request_id,
    }

    url = f"{Config.MPESA_BASE_URL}/mpesa/stkpushquery/v1/query"
    headers = {"Authorization": f"Bearer {access_token}"}

    try:
        response = requests.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT)
        data = response.json()
    except requests.RequestException as exc:
        logger.exception("STK status query failed for %s: %s", checkout_request_id, exc)
        raise MpesaError("Could not reach M-Pesa STK query endpoint.") from exc
    except ValueError as exc:
        logger.exception("STK status query response was not valid JSON for %s: %s", checkout_request_id, exc)
        raise MpesaError("Invalid response from M-Pesa STK query endpoint.") from exc

    if response.status_code != 200 and "errorMessage" in data:
        logger.error("STK status query rejected for %s: %s", checkout_request_id, data)
        raise MpesaError(data.get("errorMessage", "STK query was rejected."))

    return data