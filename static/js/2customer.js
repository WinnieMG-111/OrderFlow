/**
 * customer.js
 *
 * Drives the customer-facing tablet app: menu browsing/search, the
 * session-based cart drawer, checkout (seat selection -> M-Pesa STK
 * push), and live order tracking via Socket.IO.
 *
 * Talks to routes/customer.py (menu, categories, cart), routes/orders.py
 * (checkout), and routes/payments.py (M-Pesa). Table identity lives in
 * the Flask session already (see /table/<table_number>), so this file
 * never needs to know or send a table_id itself.
 *
 * -------------------------------------------------------------------
 * Expected HTML hooks (ids / classes), matching customer.css:
 *
 *   Header:
 *     #cart-button                 .cart-button
 *     #cart-count                  .cart-button__count
 *
 *   Menu view (#menu-view):
 *     #menu-search-input           .search-field input
 *     #category-rail               .category-rail  (buttons get .category-tab,
 *                                   "All" tab has data-category-id="all")
 *     #menu-grid                   .menu-grid
 *     #menu-empty                  .menu-empty
 *     #menu-card-template           <template> wrapping one .menu-card with
 *                                   data-field="image|name|desc|price|add"
 *
 *   Cart drawer:
 *     #cart-scrim                  .cart-scrim
 *     #cart-drawer                 .cart-drawer
 *     #cart-close                  close icon button inside drawer header
 *     #cart-items                  .cart-items
 *     #cart-empty                  .cart-empty
 *     #cart-total                  amount span inside .cart-total-row
 *     #cart-checkout-btn           .btn--primary.btn--block in drawer footer
 *     #cart-item-template           <template> wrapping one .cart-item with
 *                                   data-field="name|unit|subtotal|qty|minus|plus|remove"
 *
 *   Checkout modal (#checkout-overlay, .modal-overlay):
 *     #checkout-step-seat          .seat-modal step: seat number entry
 *       #checkout-seat-grid        .seat-grid (buttons built for seats 1..N)
 *       #checkout-seat-confirm     .btn--primary, confirms seat + advances
 *       #checkout-seat-cancel      .btn--ghost, closes the modal
 *     #checkout-step-payment       phone number + order summary + pay button
 *       #checkout-summary          .checkout-summary
 *       #checkout-total            amount span inside .checkout-total-row
 *       #checkout-phone-input      .text-input, M-Pesa phone number
 *       #checkout-phone-error      .field-error
 *       #checkout-pay-btn          .btn--primary, triggers STK push
 *       #checkout-payment-cancel   .btn--ghost / .checkout-cancel
 *     #checkout-step-waiting       spinner + "check your phone" copy
 *       #checkout-waiting-order-id
 *     #checkout-step-failed        failure message + retry/cancel
 *       #checkout-failed-message
 *       #checkout-retry-btn
 *       #checkout-failed-close
 *
 *   Tracking view (#tracking-view, shown after a successful order):
 *     #tracking-order-id
 *     #tracking-payment-badge
 *     #progress-track              .progress-track (sets --progress inline)
 *     #progress-step-template       <template> wrapping one .progress-track__step
 *                                   with data-field="dot|label"
 *     #tracking-new-order-btn      starts a fresh order after Completed/Cancelled
 *
 *   Toasts:
 *     #toast-container             .toast-container
 * -------------------------------------------------------------------
 */

(() => {
  "use strict";

  // ===================================================================
  // CONSTANTS
  // ===================================================================
  const MIN_SEAT_NUMBER = 1;
  const MAX_SEAT_NUMBER = 50;
  const MAX_ITEM_QUANTITY = 50;

  // Order of tracking stages shown on the progress bar. Cancelled is
  // handled as a special terminal state, not a step on the track.
  const TRACK_STEPS = [
    { status: "Pending", label: "Received" },
    { status: "Preparing", label: "Preparing" },
    { status: "Ready", label: "Ready" },
    { status: "Completed", label: "Completed" },
  ];

  const STORAGE_KEY_ORDER_ID = "restaurant_tracking_order_id";

  // ===================================================================
  // STATE
  // ===================================================================
  const state = {
    categories: [],
    activeCategoryId: "all",
    searchTerm: "",
    menuItems: [],
    cart: { items: [], total_amount: 0 },
    selectedSeat: null,
    pendingOrder: null, // { order_id, total_amount }
    trackedOrderId: null,
    socket: null,
  };

  // ===================================================================
  // DOM SHORTCUTS
  // ===================================================================
  const el = (id) => document.getElementById(id);

  const dom = {};

  function cacheDom() {
    Object.assign(dom, {
      cartButton: el("cart-button"),
      cartCount: el("cart-count"),

      searchInput: el("menu-search-input"),
      categoryRail: el("category-rail"),
      menuGrid: el("menu-grid"),
      menuEmpty: el("menu-empty"),
      menuCardTemplate: el("menu-card-template"),

      cartScrim: el("cart-scrim"),
      cartDrawer: el("cart-drawer"),
      cartClose: el("cart-close"),
      cartItems: el("cart-items"),
      cartEmpty: el("cart-empty"),
      cartTotal: el("cart-total"),
      cartCheckoutBtn: el("cart-checkout-btn"),
      cartItemTemplate: el("cart-item-template"),

      checkoutOverlay: el("checkout-overlay"),
      stepSeat: el("checkout-step-seat"),
      seatGrid: el("checkout-seat-grid"),
      seatConfirm: el("checkout-seat-confirm"),
      seatCancel: el("checkout-seat-cancel"),

      stepPayment: el("checkout-step-payment"),
      checkoutSummary: el("checkout-summary"),
      checkoutTotal: el("checkout-total"),
      phoneInput: el("checkout-phone-input"),
      phoneError: el("checkout-phone-error"),
      payBtn: el("checkout-pay-btn"),
      paymentCancel: el("checkout-payment-cancel"),

      stepWaiting: el("checkout-step-waiting"),
      waitingOrderId: el("checkout-waiting-order-id"),

      stepFailed: el("checkout-step-failed"),
      failedMessage: el("checkout-failed-message"),
      retryBtn: el("checkout-retry-btn"),
      failedClose: el("checkout-failed-close"),

      trackingView: el("tracking-view"),
      trackingOrderId: el("tracking-order-id"),
      trackingPaymentBadge: el("tracking-payment-badge"),
      progressTrack: el("progress-track"),
      progressStepTemplate: el("progress-step-template"),
      trackingNewOrderBtn: el("tracking-new-order-btn"),

      menuView: el("menu-view"),
      toastContainer: el("toast-container"),
    });
  }

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

  function debounce(fn, delayMs) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delayMs);
    };
  }

  function showToast(message, variant = "info") {
    if (!dom.toastContainer) return;
    const toast = document.createElement("div");
    toast.className = `toast toast--${variant}`;
    toast.textContent = message;
    dom.toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // ===================================================================
  // MENU LOADING + RENDERING
  // ===================================================================
  async function loadCategories() {
    try {
      const data = await apiRequest("/categories");
      state.categories = data.categories || [];
      renderCategoryRail();
    } catch (err) {
      console.error("Failed to load categories:", err);
    }
  }

  function renderCategoryRail() {
    if (!dom.categoryRail) return;
    dom.categoryRail.innerHTML = "";

    const allTab = makeCategoryTab("all", "All");
    dom.categoryRail.appendChild(allTab);

    state.categories.forEach((category) => {
      dom.categoryRail.appendChild(makeCategoryTab(category.category_id, category.category_name));
    });
  }

  function makeCategoryTab(categoryId, label) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "category-tab";
    btn.textContent = label;
    btn.dataset.categoryId = categoryId;
    if (String(categoryId) === String(state.activeCategoryId)) {
      btn.classList.add("is-active");
    }
    btn.addEventListener("click", () => selectCategory(categoryId));
    return btn;
  }

  async function selectCategory(categoryId) {
    state.activeCategoryId = categoryId;
    state.searchTerm = "";
    if (dom.searchInput) dom.searchInput.value = "";

    dom.categoryRail.querySelectorAll(".category-tab").forEach((tab) => {
      tab.classList.toggle("is-active", String(tab.dataset.categoryId) === String(categoryId));
    });

    await loadMenuForCurrentFilter();
  }

  async function loadMenuForCurrentFilter() {
    try {
      let data;
      if (state.activeCategoryId === "all") {
        data = await apiRequest("/menu");
      } else {
        data = await apiRequest(`/menu/category/${state.activeCategoryId}`);
      }
      state.menuItems = data.menu || [];
      renderMenuGrid();
    } catch (err) {
      console.error("Failed to load menu:", err);
      showToast("Could not load the menu right now.", "error");
    }
  }

  async function searchMenu(term) {
    if (!term) {
      await loadMenuForCurrentFilter();
      return;
    }
    try {
      const data = await apiRequest(`/menu/search?q=${encodeURIComponent(term)}`);
      state.menuItems = data.menu || [];
      renderMenuGrid();
    } catch (err) {
      console.error("Menu search failed:", err);
      showToast(err.message || "Search failed. Please try again.", "error");
    }
  }

  function renderMenuGrid() {
    if (!dom.menuGrid) return;
    dom.menuGrid.innerHTML = "";

    if (state.menuItems.length === 0) {
      if (dom.menuEmpty) dom.menuEmpty.hidden = false;
      return;
    }
    if (dom.menuEmpty) dom.menuEmpty.hidden = true;

    state.menuItems.forEach((item) => {
      dom.menuGrid.appendChild(buildMenuCard(item));
    });
  }

  function buildMenuCard(item) {
    if (!dom.menuCardTemplate) return document.createTextNode("");

    const node = dom.menuCardTemplate.content.cloneNode(true);
    const card = node.querySelector(".menu-card");
    card.dataset.itemId = item.item_id;

    const imageEl = node.querySelector('[data-field="image"]');
    if (imageEl) {
      if (item.image) {
        imageEl.style.backgroundImage = `url("${item.image}")`;
        imageEl.textContent = "";
      } else {
        imageEl.textContent = (item.item_name || "?").charAt(0).toUpperCase();
      }
    }

    const nameEl = node.querySelector('[data-field="name"]');
    if (nameEl) nameEl.textContent = item.item_name;

    const descEl = node.querySelector('[data-field="desc"]');
    if (descEl) descEl.textContent = item.category_name || "";

    const priceEl = node.querySelector('[data-field="price"]');
    if (priceEl) priceEl.textContent = formatCurrency(item.price);

    const addBtn = node.querySelector('[data-field="add"]');
    if (addBtn) {
      addBtn.addEventListener("click", () => handleAddToCart(item.item_id, addBtn));
    }

    return node.firstElementChild;
  }

  async function handleAddToCart(itemId, buttonEl) {
    try {
      const data = await apiRequest("/cart", {
        method: "POST",
        body: JSON.stringify({ item_id: itemId, quantity: 1 }),
      });
      applyCartResponse(data);

      if (buttonEl) {
        buttonEl.classList.add("is-added");
        setTimeout(() => buttonEl.classList.remove("is-added"), 500);
      }
    } catch (err) {
      showToast(err.message || "Could not add item to cart.", "error");
    }
  }

  // ===================================================================
  // CART
  // ===================================================================
  async function loadCart() {
    try {
      const data = await apiRequest("/cart");
      applyCartResponse(data);
    } catch (err) {
      console.error("Failed to load cart:", err);
    }
  }

  function applyCartResponse(data) {
    state.cart = { items: data.items || [], total_amount: data.total_amount || 0 };
    renderCart();
  }

  function renderCart() {
    const itemCount = state.cart.items.reduce((sum, item) => sum + item.quantity, 0);
    if (dom.cartCount) {
      dom.cartCount.textContent = itemCount;
      dom.cartCount.hidden = itemCount === 0;
    }

    if (!dom.cartItems) return;
    dom.cartItems.innerHTML = "";

    if (state.cart.items.length === 0) {
      if (dom.cartEmpty) dom.cartEmpty.hidden = false;
    } else {
      if (dom.cartEmpty) dom.cartEmpty.hidden = true;
      state.cart.items.forEach((item) => {
        dom.cartItems.appendChild(buildCartItemElement(item));
      });
    }

    if (dom.cartTotal) dom.cartTotal.textContent = formatCurrency(state.cart.total_amount);
    if (dom.cartCheckoutBtn) dom.cartCheckoutBtn.disabled = state.cart.items.length === 0;
  }

  function buildCartItemElement(item) {
    if (!dom.cartItemTemplate) return document.createTextNode("");

    const node = dom.cartItemTemplate.content.cloneNode(true);
    const row = node.querySelector(".cart-item");
    row.dataset.itemId = item.item_id;

    node.querySelector('[data-field="name"]').textContent = item.item_name;
    node.querySelector('[data-field="unit"]').textContent = `${formatCurrency(item.unit_price)} each`;
    node.querySelector('[data-field="subtotal"]').textContent = formatCurrency(item.subtotal);

    const qtyEl = node.querySelector('[data-field="qty"]');
    if (qtyEl) qtyEl.textContent = item.quantity;

    const minusBtn = node.querySelector('[data-field="minus"]');
    if (minusBtn) {
      minusBtn.disabled = item.quantity <= 1;
      minusBtn.addEventListener("click", () => handleQuantityChange(item.item_id, item.quantity - 1));
    }

    const plusBtn = node.querySelector('[data-field="plus"]');
    if (plusBtn) {
      plusBtn.disabled = item.quantity >= MAX_ITEM_QUANTITY;
      plusBtn.addEventListener("click", () => handleQuantityChange(item.item_id, item.quantity + 1));
    }

    const removeBtn = node.querySelector('[data-field="remove"]');
    if (removeBtn) {
      removeBtn.addEventListener("click", () => handleRemoveFromCart(item.item_id));
    }

    return node.firstElementChild;
  }

  async function handleQuantityChange(itemId, newQuantity) {
    if (newQuantity < 1) {
      await handleRemoveFromCart(itemId);
      return;
    }
    try {
      const data = await apiRequest("/cart", {
        method: "PUT",
        body: JSON.stringify({ item_id: itemId, quantity: newQuantity }),
      });
      applyCartResponse(data);
    } catch (err) {
      showToast(err.message || "Could not update your cart.", "error");
    }
  }

  async function handleRemoveFromCart(itemId) {
    try {
      const data = await apiRequest(`/cart/${itemId}`, { method: "DELETE" });
      applyCartResponse(data);
    } catch (err) {
      showToast(err.message || "Could not update your cart.", "error");
    }
  }

  function openCartDrawer() {
    if (dom.cartScrim) dom.cartScrim.hidden = false;
    if (dom.cartDrawer) dom.cartDrawer.classList.add("is-open");
  }

  function closeCartDrawer() {
    if (dom.cartDrawer) dom.cartDrawer.classList.remove("is-open");
    if (dom.cartScrim) dom.cartScrim.hidden = true;
  }

  // ===================================================================
  // CHECKOUT: seat selection -> payment -> waiting -> success/failure
  // ===================================================================
  function openCheckout() {
    if (state.cart.items.length === 0) {
      showToast("Your cart is empty.", "error");
      return;
    }
    state.selectedSeat = null;
    buildSeatGrid();
    showCheckoutStep("seat");
    if (dom.checkoutOverlay) dom.checkoutOverlay.hidden = false;
    closeCartDrawer();
  }

  function closeCheckout() {
    if (dom.checkoutOverlay) dom.checkoutOverlay.hidden = true;
  }

  function showCheckoutStep(stepName) {
    const steps = {
      seat: dom.stepSeat,
      payment: dom.stepPayment,
      waiting: dom.stepWaiting,
      failed: dom.stepFailed,
    };
    Object.entries(steps).forEach(([name, stepEl]) => {
      if (stepEl) stepEl.hidden = name !== stepName;
    });
  }

  function buildSeatGrid() {
    if (!dom.seatGrid) return;
    dom.seatGrid.innerHTML = "";
    for (let seat = MIN_SEAT_NUMBER; seat <= MAX_SEAT_NUMBER; seat += 1) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "seat-grid__btn";
      btn.textContent = seat;
      btn.dataset.seat = seat;
      btn.addEventListener("click", () => {
        state.selectedSeat = seat;
        dom.seatGrid.querySelectorAll(".seat-grid__btn").forEach((b) => {
          b.classList.toggle("is-selected", Number(b.dataset.seat) === seat);
        });
        if (dom.seatConfirm) dom.seatConfirm.disabled = false;
      });
      dom.seatGrid.appendChild(btn);
    }
    if (dom.seatConfirm) dom.seatConfirm.disabled = true;
  }

  function proceedToPayment() {
    if (!state.selectedSeat) {
      showToast("Please select your seat.", "error");
      return;
    }
    renderCheckoutSummary();
    showCheckoutStep("payment");
  }

  function renderCheckoutSummary() {
    if (dom.checkoutSummary) {
      dom.checkoutSummary.innerHTML = "";
      state.cart.items.forEach((item) => {
        const row = document.createElement("div");
        row.className = "checkout-summary__row";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = `${item.quantity}\u00d7 ${item.item_name}`;
        const priceSpan = document.createElement("span");
        priceSpan.textContent = formatCurrency(item.subtotal);
        row.append(nameSpan, priceSpan);
        dom.checkoutSummary.appendChild(row);
      });
    }
    if (dom.checkoutTotal) dom.checkoutTotal.textContent = formatCurrency(state.cart.total_amount);
  }

  function validatePhoneNumber(raw) {
    const digits = (raw || "").replace(/\D/g, "");
    // Accept 07XXXXXXXX, 01XXXXXXXX, 2547XXXXXXXX, 2541XXXXXXXX, or
    // bare 7XXXXXXXX/1XXXXXXXX - the backend does the authoritative
    // normalization; this is just a friendly client-side sanity check.
    const isValid =
      /^0(7|1)\d{8}$/.test(digits) ||
      /^254(7|1)\d{8}$/.test(digits) ||
      /^(7|1)\d{8}$/.test(digits);
    return isValid;
  }

  async function submitPayment() {
    const phoneNumber = (dom.phoneInput && dom.phoneInput.value.trim()) || "";

    if (!validatePhoneNumber(phoneNumber)) {
      if (dom.phoneError) {
        dom.phoneError.textContent = "Enter a valid M-Pesa phone number, e.g. 0712345678.";
        dom.phoneError.hidden = false;
      }
      return;
    }
    if (dom.phoneError) dom.phoneError.hidden = true;
    if (dom.payBtn) dom.payBtn.disabled = true;

    try {
      // 1. Place the order from the current session cart.
      const orderData = await apiRequest("/orders", {
        method: "POST",
        body: JSON.stringify({ seat_number: state.selectedSeat }),
      });
      state.pendingOrder = orderData;

      // 2. Kick off the M-Pesa STK push for that order.
      showCheckoutStep("waiting");
      if (dom.waitingOrderId) dom.waitingOrderId.textContent = orderData.order_id;

      await apiRequest("/payments/mpesa", {
        method: "POST",
        body: JSON.stringify({ order_id: orderData.order_id, phone_number: phoneNumber }),
      });

      // 3. Cart is now empty server-side too; reflect that locally.
      state.cart = { items: [], total_amount: 0 };
      renderCart();

      beginTrackingOrder(orderData.order_id);
      pollPaymentStatus(orderData.order_id);
    } catch (err) {
      showCheckoutFailure(err.message || "Could not complete checkout. Please try again.");
    } finally {
      if (dom.payBtn) dom.payBtn.disabled = false;
    }
  }

  function showCheckoutFailure(message) {
    if (dom.failedMessage) dom.failedMessage.textContent = message;
    showCheckoutStep("failed");
  }

  // Fallback poll in case the payment_success/payment_failed Socket.IO
  // events are missed (e.g. brief disconnect). Stops once the order
  // leaves "Pending" payment or tracking is abandoned.
  async function pollPaymentStatus(orderId) {
    const POLL_INTERVAL_MS = 4000;
    const MAX_ATTEMPTS = 30; // ~2 minutes

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (state.trackedOrderId !== orderId) return; // user moved on

      try {
        const payment = await apiRequest(`/payments/status/${orderId}`);
        if (payment.payment_status === "Paid") {
          onPaymentResolved(orderId, true);
          return;
        }
        if (payment.payment_status === "Failed") {
          onPaymentResolved(orderId, false);
          return;
        }
      } catch (err) {
        console.warn("Payment status poll failed:", err);
      }
    }
  }

  function onPaymentResolved(orderId, success) {
    // If the customer is still on the waiting screen for this order,
    // move them straight to tracking (success) or back to a retry
    // screen (failure). If they've already been moved to tracking
    // by the Socket.IO event, this is a harmless no-op.
    if (dom.checkoutOverlay && !dom.checkoutOverlay.hidden) {
      if (success) {
        closeCheckout();
        showToast("Payment received! Tracking your order.", "success");
      } else {
        showCheckoutFailure("Payment was not completed. You can try again.");
      }
    }
    if (dom.trackingPaymentBadge) {
      dom.trackingPaymentBadge.textContent = success ? "Paid" : "Payment failed";
    }
  }

  function retryPayment() {
    showCheckoutStep("payment");
  }

  // ===================================================================
  // ORDER TRACKING
  // ===================================================================
  function beginTrackingOrder(orderId) {
    state.trackedOrderId = orderId;
    localStorage.setItem(STORAGE_KEY_ORDER_ID, String(orderId));

    if (state.socket && state.socket.connected) {
      state.socket.emit("join_order_room", { order_id: orderId });
    }

    showTrackingView(orderId);
    fetchInitialOrderStatus(orderId);
  }

  async function fetchInitialOrderStatus(orderId) {
    try {
      const data = await apiRequest(`/orders/status/${orderId}`);
      updateTrackingUI(data.order_status, data.payment_status);
    } catch (err) {
      console.error("Failed to fetch initial order status:", err);
    }
  }

  function showTrackingView(orderId) {
    if (dom.menuView) dom.menuView.hidden = true;
    if (dom.trackingView) dom.trackingView.hidden = false;
    if (dom.trackingOrderId) dom.trackingOrderId.textContent = orderId;
    buildProgressTrack();
  }

  function buildProgressTrack() {
    if (!dom.progressTrack || !dom.progressStepTemplate) return;
    dom.progressTrack.innerHTML = "";
    TRACK_STEPS.forEach((step) => {
      const node = dom.progressStepTemplate.content.cloneNode(true);
      const stepEl = node.querySelector(".progress-track__step");
      stepEl.dataset.status = step.status;
      const labelEl = node.querySelector('[data-field="label"]');
      if (labelEl) labelEl.textContent = step.label;
      dom.progressTrack.appendChild(node.firstElementChild);
    });
  }

  function updateTrackingUI(orderStatus, paymentStatus) {
    if (!dom.progressTrack) return;

    if (paymentStatus && dom.trackingPaymentBadge) {
      dom.trackingPaymentBadge.textContent = paymentStatus === "Paid" ? "Paid" : "Awaiting payment";
    }

    const stepEls = Array.from(dom.progressTrack.querySelectorAll(".progress-track__step"));

    if (orderStatus === "Cancelled") {
      stepEls.forEach((stepEl) => stepEl.classList.add("is-cancelled"));
      dom.progressTrack.style.setProperty("--progress", "0");
      if (dom.trackingNewOrderBtn) dom.trackingNewOrderBtn.hidden = false;
      return;
    }

    const currentIndex = TRACK_STEPS.findIndex((s) => s.status === orderStatus);
    stepEls.forEach((stepEl, index) => {
      stepEl.classList.remove("is-complete", "is-current", "is-cancelled");
      if (index < currentIndex) stepEl.classList.add("is-complete");
      else if (index === currentIndex) stepEl.classList.add("is-current");
    });

    const progressFraction = currentIndex <= 0 ? 0 : currentIndex / (TRACK_STEPS.length - 1);
    dom.progressTrack.style.setProperty("--progress", String(progressFraction));

    if (dom.trackingNewOrderBtn) dom.trackingNewOrderBtn.hidden = orderStatus !== "Completed";
  }

  function startNewOrder() {
    state.trackedOrderId = null;
    localStorage.removeItem(STORAGE_KEY_ORDER_ID);
    if (dom.trackingView) dom.trackingView.hidden = true;
    if (dom.menuView) dom.menuView.hidden = false;
  }

  // Resume tracking an in-flight order after a page reload (e.g. the
  // tablet browser was refreshed while food was still being prepared).
  function resumeTrackingIfNeeded() {
    const storedOrderId = localStorage.getItem(STORAGE_KEY_ORDER_ID);
    if (!storedOrderId) return;
    beginTrackingOrder(Number(storedOrderId));
  }

  // ===================================================================
  // SOCKET.IO
  // ===================================================================
  function initSocket() {
    if (typeof io !== "function") {
      console.warn("Socket.IO client not loaded; live updates disabled.");
      return;
    }
    state.socket = io();

    state.socket.on("connect", () => {
      state.socket.emit("customer_connected", { seat_number: state.selectedSeat });
      if (state.trackedOrderId) {
        state.socket.emit("join_order_room", { order_id: state.trackedOrderId });
      }
    });

    ["order_received", "order_preparing", "order_ready", "order_completed", "order_cancelled"].forEach(
      (eventName) => {
        state.socket.on(eventName, (payload) => {
          if (!payload || payload.order_id !== state.trackedOrderId) return;
          updateTrackingUI(payload.order_status, payload.payment_status);
        });
      }
    );

    state.socket.on("payment_success", (payload) => {
      if (!payload || payload.order_id !== state.trackedOrderId) return;
      onPaymentResolved(payload.order_id, true);
    });

    state.socket.on("payment_failed", (payload) => {
      if (!payload || payload.order_id !== state.trackedOrderId) return;
      onPaymentResolved(payload.order_id, false);
    });
  }

  // ===================================================================
  // EVENT WIRING
  // ===================================================================
  function wireEvents() {
    if (dom.cartButton) dom.cartButton.addEventListener("click", openCartDrawer);
    if (dom.cartClose) dom.cartClose.addEventListener("click", closeCartDrawer);
    if (dom.cartScrim) dom.cartScrim.addEventListener("click", closeCartDrawer);
    if (dom.cartCheckoutBtn) dom.cartCheckoutBtn.addEventListener("click", openCheckout);

    if (dom.searchInput) {
      dom.searchInput.addEventListener(
        "input",
        debounce((event) => {
          state.searchTerm = event.target.value.trim();
          searchMenu(state.searchTerm);
        }, 300)
      );
    }

    if (dom.seatConfirm) dom.seatConfirm.addEventListener("click", proceedToPayment);
    if (dom.seatCancel) dom.seatCancel.addEventListener("click", closeCheckout);
    if (dom.payBtn) dom.payBtn.addEventListener("click", submitPayment);
    if (dom.paymentCancel) dom.paymentCancel.addEventListener("click", closeCheckout);
    if (dom.retryBtn) dom.retryBtn.addEventListener("click", retryPayment);
    if (dom.failedClose) dom.failedClose.addEventListener("click", closeCheckout);
    if (dom.trackingNewOrderBtn) dom.trackingNewOrderBtn.addEventListener("click", startNewOrder);
  }

  // ===================================================================
  // BOOTSTRAP
  // ===================================================================
  document.addEventListener("DOMContentLoaded", async () => {
    cacheDom();
    wireEvents();
    initSocket();

    await Promise.all([loadCategories(), loadMenuForCurrentFilter(), loadCart()]);

    resumeTrackingIfNeeded();
  });
})();
