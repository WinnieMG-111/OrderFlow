/**
 * kitchen.js
 *
 * Drives the kitchen display system (KDS): loads active orders, renders
 * them into New / Preparing / Ready columns, keeps everything live via
 * Socket.IO, and lets staff advance or cancel orders with one tap.
 */

(() => {
  "use strict";

  // ===================================================================
  // STATE
  // ===================================================================
  // orderId (number) -> order object { order_id, table_number, seat_number,
  //   items, total_amount, order_status, payment_status, created_at }
  const orders = new Map();
  let socket = null;

  const COLUMN_BY_STATUS = {
    Pending: "col-pending",
    Preparing: "col-preparing",
    Ready: "col-ready",
  };

  // Ticket age thresholds, in minutes, for urgency coloring.
  const URGENCY_AGING_MINUTES = 5;
  const URGENCY_LATE_MINUTES = 10;

  // ===================================================================
  // DOM SHORTCUTS
  // ===================================================================
  const el = (id) => document.getElementById(id);
  const ticketTemplate = el("ticket-template");
  const connectionBadge = el("connection-badge");
  const clockEl = el("clock");

  // ===================================================================
  // GENERIC HELPERS
  // ===================================================================
  async function apiRequest(url, options = {}) {
    const response = await fetch(url, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    let data = {};
    try {
      data = await response.json();
    } catch (_err) {
      /* no body */
    }
    if (!response.ok) {
      throw new Error(data.error || `Request failed (${response.status}).`);
    }
    return data;
  }

  function formatCurrency(amount) {
    const value = Number(amount) || 0;
    return `KSh ${value.toLocaleString("en-KE", { maximumFractionDigits: 0 })}`;
  }

  function formatElapsed(createdAtIso) {
    const createdMs = new Date(createdAtIso).getTime();
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - createdMs) / 1000));
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function urgencyClassFor(createdAtIso) {
    const createdMs = new Date(createdAtIso).getTime();
    const elapsedMinutes = (Date.now() - createdMs) / 60000;
    if (elapsedMinutes >= URGENCY_LATE_MINUTES) return "kds-ticket--late";
    if (elapsedMinutes >= URGENCY_AGING_MINUTES) return "kds-ticket--aging";
    return "kds-ticket--fresh";
  }

  // ===================================================================
  // LOADING ORDERS
  // ===================================================================
  async function loadActiveOrders() {
    try {
      const data = await apiRequest("/kitchen/orders");
      orders.clear();
      (data.orders || []).forEach((order) => orders.set(order.order_id, order));
      renderBoard();
    } catch (err) {
      console.error("Failed to load active orders:", err);
    }
  }

  // ===================================================================
  // RENDERING
  // ===================================================================
  function renderBoard() {
    const columns = {
      "col-pending": el("col-pending"),
      "col-preparing": el("col-preparing"),
      "col-ready": el("col-ready"),
    };
    Object.values(columns).forEach((col) => (col.innerHTML = ""));

    const sortedOrders = Array.from(orders.values()).sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    );

    const counts = { "col-pending": 0, "col-preparing": 0, "col-ready": 0 };

    sortedOrders.forEach((order) => {
      const columnId = COLUMN_BY_STATUS[order.order_status];
      if (!columnId) return; // Completed/Cancelled orders simply aren't rendered.
      columns[columnId].appendChild(buildTicketElement(order));
      counts[columnId] += 1;
    });

    el("count-pending").textContent = counts["col-pending"];
    el("count-preparing").textContent = counts["col-preparing"];
    el("count-ready").textContent = counts["col-ready"];

    Object.entries(columns).forEach(([id, colEl]) => {
      const emptyMsg = document.querySelector(`[data-empty-for="${id}"]`);
      emptyMsg.hidden = colEl.children.length > 0;
    });
  }

  function buildTicketElement(order) {
    const node = ticketTemplate.content.cloneNode(true);
    const ticket = node.querySelector(".kds-ticket");

    ticket.classList.add(urgencyClassFor(order.created_at));
    ticket.dataset.orderId = order.order_id;
    ticket.dataset.createdAt = order.created_at;

    node.querySelector('[data-field="order-id"]').textContent = order.order_id;
    node.querySelector('[data-field="timer"]').textContent = formatElapsed(order.created_at);
    node.querySelector('[data-field="table"]').textContent = `Table ${order.table_number}`;
    node.querySelector('[data-field="seat"]').textContent = order.seat_number;

    const paymentBadge = node.querySelector('[data-field="payment-badge"]');
    const isPaid = order.payment_status === "Paid";
    paymentBadge.textContent = isPaid ? "Paid" : "Awaiting payment";
    paymentBadge.classList.add(isPaid ? "payment-badge--paid" : "payment-badge--unpaid");

    const itemsList = node.querySelector('[data-field="items"]');
    (order.items || []).forEach((item) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="item-qty"></span><span></span>`;
      li.children[0].textContent = `${item.quantity}\u00d7`;
      li.children[1].textContent = item.item_name;
      itemsList.appendChild(li);
    });

    node.querySelector('[data-field="actions"]').appendChild(buildActions(order));

    return node.firstElementChild;
  }

  function buildActions(order) {
    const wrap = document.createElement("div");
    wrap.className = "kds-ticket__actions";

    if (order.order_status === "Pending") {
      wrap.appendChild(makeActionButton("Start Preparing", "btn--primary", () =>
        updateStatus(order.order_id, "Preparing")
      ));
      wrap.appendChild(makeActionButton("Cancel", "btn--danger-text", () => {
        if (confirm(`Cancel order #${order.order_id}?`)) {
          updateStatus(order.order_id, "Cancelled");
        }
      }));
    } else if (order.order_status === "Preparing") {
      wrap.appendChild(makeActionButton("Mark Ready", "btn--primary", () =>
        updateStatus(order.order_id, "Ready")
      ));
      wrap.appendChild(makeActionButton("Cancel", "btn--danger-text", () => {
        if (confirm(`Cancel order #${order.order_id}?`)) {
          updateStatus(order.order_id, "Cancelled");
        }
      }));
    } else if (order.order_status === "Ready") {
      wrap.appendChild(makeActionButton("Complete", "btn--primary", () =>
        updateStatus(order.order_id, "Completed")
      ));
    }

    return wrap;
  }

  function makeActionButton(label, extraClass, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `btn ${extraClass}`;
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  // ===================================================================
  // STATUS UPDATES
  // ===================================================================
  async function updateStatus(orderId, newStatus) {
    try {
      await apiRequest(`/kitchen/orders/${orderId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });
      // Optimistically update local state; the Socket.IO echo that
      // follows will reconcile to the same result, so this is safe.
      applyStatusChange(orderId, newStatus);
    } catch (err) {
      alert(err.message);
    }
  }

  function applyStatusChange(orderId, newStatus) {
    if (newStatus === "Completed" || newStatus === "Cancelled") {
      orders.delete(orderId);
    } else if (orders.has(orderId)) {
      orders.get(orderId).order_status = newStatus;
    }
    renderBoard();
  }

  // ===================================================================
  // LIVE TIMERS (re-render timer text + urgency class every second)
  // ===================================================================
  function tickTimers() {
    document.querySelectorAll(".kds-ticket").forEach((ticket) => {
      const createdAt = ticket.dataset.createdAt;
      const timerEl = ticket.querySelector('[data-field="timer"]');
      if (timerEl) timerEl.textContent = formatElapsed(createdAt);

      ticket.classList.remove("kds-ticket--fresh", "kds-ticket--aging", "kds-ticket--late");
      ticket.classList.add(urgencyClassFor(createdAt));
    });
  }

  function tickClock() {
    clockEl.textContent = new Date().toLocaleTimeString("en-KE", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  // ===================================================================
  // SOCKET.IO
  // ===================================================================
  function initSocket() {
    socket = io();

    socket.on("connect", () => {
      socket.emit("join_kitchen_room");
      connectionBadge.textContent = "Live";
      connectionBadge.classList.remove("connection-badge--offline");
      connectionBadge.classList.add("connection-badge--online");
    });

    socket.on("disconnect", () => {
      connectionBadge.textContent = "Reconnecting\u2026";
      connectionBadge.classList.remove("connection-badge--online");
      connectionBadge.classList.add("connection-badge--offline");
    });

    socket.on("new_order", (order) => {
      orders.set(order.order_id, order);
      renderBoard();
    });

    socket.on("order_status_updated", (payload) => {
      applyStatusChange(payload.order_id, payload.order_status);
    });

    socket.on("payment_success", (payload) => {
      const order = orders.get(payload.order_id);
      if (order) {
        order.payment_status = "Paid";
        renderBoard();
      }
    });
  }

  // ===================================================================
  // BOOTSTRAP
  // ===================================================================
  document.addEventListener("DOMContentLoaded", () => {
    tickClock();
    setInterval(tickClock, 1000);
    setInterval(tickTimers, 1000);

    initSocket();
    loadActiveOrders();
  });
})();