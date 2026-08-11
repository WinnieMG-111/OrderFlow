"""
Reusable database access layer built on PyMySQL.

Provides:
- get_db_connection(): raw connection factory (DictCursor by default)
- get_db_cursor(): context manager that guarantees cursors/connections
  are always closed, and rolls back on error
- fetch_one / fetch_all / execute_query / execute_many: high-level
  helpers used by every route/service, so no other module needs to
  touch pymysql directly.

All queries throughout the app MUST use parameterized queries
(the `params` argument) rather than string formatting, to prevent
SQL injection.
"""

import logging
from contextlib import contextmanager

import pymysql
import pymysql.cursors

from config import Config

logger = logging.getLogger(__name__)


def get_db_connection():
    """
    Create and return a new PyMySQL connection configured to return
    rows as dictionaries (DictCursor), which lets route code access
    columns by name (row["item_name"]) instead of by index.

    Raises:
        pymysql.MySQLError: if the connection cannot be established.
    """
    try:
        connection = pymysql.connect(
            host=Config.MYSQL_HOST,
            port=Config.MYSQL_PORT,
            user=Config.MYSQL_USER,
            password=Config.MYSQL_PASSWORD,
            database=Config.MYSQL_DB,
            charset=Config.MYSQL_CHARSET,
            cursorclass=pymysql.cursors.DictCursor,
            autocommit=False,
        )
        return connection
    except pymysql.MySQLError as exc:
        logger.exception("Database connection failed: %s", exc)
        raise


@contextmanager
def get_db_cursor(commit=False):
    """
    Context manager that yields a ready-to-use DictCursor and takes
    care of committing, rolling back on error, and always closing
    both the cursor and the connection afterwards.

    Args:
        commit (bool): set True for INSERT/UPDATE/DELETE statements
            that need to be persisted. Left False for plain SELECTs.

    Usage:
        with get_db_cursor(commit=True) as cursor:
            cursor.execute("UPDATE orders SET order_status=%s WHERE order_id=%s",
                           (status, order_id))
    """
    connection = get_db_connection()
    cursor = connection.cursor()
    try:
        yield cursor
        if commit:
            connection.commit()
    except Exception as exc:
        connection.rollback()
        logger.exception("Database operation failed, transaction rolled back: %s", exc)
        raise
    finally:
        cursor.close()
        connection.close()


def fetch_one(query: str, params=None):
    """Run a SELECT and return a single row as a dict, or None if no match."""
    with get_db_cursor(commit=False) as cursor:
        cursor.execute(query, params or ())
        return cursor.fetchone()


def fetch_all(query: str, params=None):
    """Run a SELECT and return all matching rows as a list of dicts."""
    with get_db_cursor(commit=False) as cursor:
        cursor.execute(query, params or ())
        return cursor.fetchall()


def execute_query(query: str, params=None):
    """
    Run an INSERT, UPDATE, or DELETE statement.

    Returns:
        dict with:
            - "lastrowid": auto-increment id of the last inserted row
              (0 if the statement wasn't an INSERT)
            - "rowcount": number of rows affected
    """
    with get_db_cursor(commit=True) as cursor:
        cursor.execute(query, params or ())
        return {"lastrowid": cursor.lastrowid, "rowcount": cursor.rowcount, "success": True}


def execute_many(query: str, param_list):
    """
    Run the same INSERT/UPDATE statement for many rows in one round trip.
    Used for inserting all order_items belonging to a single order.

    Args:
        param_list: list of parameter tuples, one per row.

    Returns:
        dict with "rowcount": total number of rows affected, "success": True.
    """
    with get_db_cursor(commit=True) as cursor:
        cursor.executemany(query, param_list)
        return {"rowcount": cursor.rowcount, "success": True}

@contextmanager
def get_db_transaction():
    """
    Context manager that provides both a connection and cursor for
    multi-statement database transactions.
    """

    connection = get_db_connection()
    cursor = connection.cursor()

    try:
        yield connection, cursor
        connection.commit()

    except Exception:
        connection.rollback()
        logger.exception("Transaction rolled back.")
        raise

    finally:
        cursor.close()
        connection.close()    