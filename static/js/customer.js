/**
 * customer.js
 *
 * Drives the entire customer ordering single-page app. No page ever
 * reloads: seat entry -> menu browsing -> cart -> checkout -> payment
 * -> live order tracking are all just view states toggled with the
 * `hidden` attribute, and order status updates arrive over Socket.IO.
 */

(() => {
  "use strict";

  // ===================================================================
  // STATE
  // ===================================================================
  const state = {
    seatNumber: null,
    categories: [],
    menu: [],            // full cached list of available menu items
    activeCategory: "all",
    searchTerm: "",
    cart: { items: [], total_amount: 0 },
    currentOrderId: null,
  };

  const SEAT_COUNT = 12;
  let socket = null;

  // ===================================================================
  // DOM SHORTCUTS
  // ===================================================================
  const el = (id) => document.getElementById(id);

  const seatModal = el("seat-modal");
  const seatGrid = el("seat-grid");
  const seatContinueBtn = el("seat-continue");

  const searchInput = el("search-input");
  const categoryRail = el("category-rail");
  const menuGrid = el("menu-grid");
  const menuEmpty = el("menu-empty");

  const cartToggleBtn = el("cart-toggle");
  const cartCountBadge = el("cart-count");
  const cartScrim = el("cart-scrim");
  const cartDrawer = el("cart-drawer");
  const cartCloseBtn = el("cart-close");
  const cartItemsEl = el("cart-items");
  const cartEmptyEl = el("cart-empty");
  const cartTotalEl = el("cart-total");
  const checkoutBtn = el("checkout-btn");

  const checkoutModal = el("checkout-modal");
  const stepConfirm = el("checkout-step-confirm");
  const stepPay = el("checkout-step-pay");
  const stepWaiting = el("checkout-step-waiting");
  const stepFailed = el("checkout-step-failed");
  const checkoutSeatNumberEl = el("checkout-seat-number");
  const checkoutSummaryEl = el("checkout-summary");
  const checkoutTotalEl = el("checkout-total");
  const placeOrderBtn = el("place-order-btn");
  const payOrderIdEl = el("pay-order-id");
  const phoneInput = el("phone-input");
  const phoneErrorEl = el("phone-error");
  const payBtn = el("pay-btn");
  const paymentFailReasonEl = el("payment-fail-reason");
  const retryPayBtn = el("retry-pay-btn");

  const trackingView = el("tracking-view");
  const trackerOrderIdEl = el("tracker-order-id");
  const progressTrack = el("progress-track");
  const trackerItemsEl = el("tracker-items");
  const trackerTotalEl = el("tracker-total");
  const newOrderBtn = el("new-order-btn");

  const appRoot = el("app");
  const menuView = el("menu-view");

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
      /* empty/non-JSON body is fine for some responses */
    }
    if (!response.ok) {
      throw new Error(data.error || `Something went wrong (${response.status}).`);
    }
    return data;
  }

  function formatCurrency(amount) {
    const value = Number(amount) || 0;
    return `KSh ${value.toLocaleString("en-KE", { maximumFractionDigits: 0 })}`;
  }

  function showToast(message, type = "error") {
    const container = el("toast-container");
    const toast = document.createElement("div");
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // ===================================================================
  // SEAT ENTRY
  // ===================================================================
  function buildSeatGrid() {
    let selectedBtn = null;
    for (let seat = 1; seat <= SEAT_COUNT; seat++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "seat-grid__btn";
      btn.textContent = String(seat);
      btn.addEventListener("click", () => {
        if (selectedBtn) selectedBtn.classList.remove("is-selected");
        btn.classList.add("is-selected");
        selectedBtn = btn;
        state.seatNumber = seat;
        seatContinueBtn.disabled = false;
      });
      seatGrid.appendChild(btn);
    }
  }

  function initSeatEntry() {
    const savedSeat = sessionStorage.getItem("seatNumber");
    if (savedSeat) {
      state.seatNumber = parseInt(savedSeat, 10);
      seatModal.hidden = true;
      startApp();
      return;
    }

    buildSeatGrid();
    seatContinueBtn.addEventListener("click", () => {
      if (!state.seatNumber) return;
      sessionStorage.setItem("seatNumber", String(state.seatNumber));
      seatModal.hidden = true;
      startApp();
    });
  }

  function resetSeatForNewCustomer() {
    sessionStorage.removeItem("seatNumber");
    state.seatNumber = null;
    seatGrid.innerHTML = "";
    seatContinueBtn.disabled = true;
    buildSeatGrid();
    seatModal.hidden = false;
  }

  // ===================================================================
  // MENU BROWSING
  // ===================================================================
  async function loadCategories() {
    const data = await apiRequest("/categories");
    state.categories = data.categories || [];
    renderCategoryRail();
  }

  async function loadMenu() {
    const data = await apiRequest("/menu");
    state.menu = data.menu || [];
    renderMenu();
  }

  function renderCategoryRail() {
    categoryRail.innerHTML = "";

    const allTab = document.createElement("button");
    allTab.type = "button";
    allTab.className = "category-tab is-active";
    allTab.textContent = "All";
    allTab.addEventListener("click", () => setActiveCategory("all", allTab));
    categoryRail.appendChild(allTab);

    state.categories.forEach((category) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "category-tab";
      tab.textContent = category.category_name;
      tab.addEventListener("click", () => setActiveCategory(category.category_id, tab));
      categoryRail.appendChild(tab);
    });
  }

  function setActiveCategory(categoryId, tabEl) {
    state.activeCategory = categoryId;
    categoryRail.querySelectorAll(".category-tab").forEach((t) => t.classList.remove("is-active"));
    tabEl.classList.add("is-active");
    // Switching category clears any active search, since they're two
    // different ways of narrowing the same menu grid.
    searchInput.value = "";
    state.searchTerm = "";
    renderMenu();
  }

  function renderMenu() {
    let itemsToShow = state.menu;
    if (state.activeCategory !== "all") {
      itemsToShow = itemsToShow.filter((item) => item.category_id === state.activeCategory);
    }

    menuGrid.innerHTML = "";
    menuEmpty.hidden = itemsToShow.length > 0;

    itemsToShow.forEach((item) => menuGrid.appendChild(buildMenuCard(item)));
  }

  function buildMenuCard(item) {
    const card = document.createElement("div");
    card.className = "menu-card";

    const image = document.createElement("div");
    image.className = "menu-card__image";
    if (item.image) {
      image.style.backgroundImage = `url('/static/uploads/${item.image}')`;
    } else {
      image.textContent = item.item_name.charAt(0).toUpperCase();
    }

    const body = document.createElement("div");
    body.className = "menu-card__body";
    body.innerHTML = `
      <div class="menu-card__name"></div>
      <div class="menu-card__footer">
        <span class="menu-card__price mono"></span>
        <button type="button" class="menu-card__add" aria-label="Add ${item.item_name}">+</button>
      </div>
    `;
    body.querySelector(".menu-card__name").textContent = item.item_name;
    body.querySelector(".menu-card__price").textContent = formatCurrency(item.price);

    const addBtn = body.querySelector(".menu-card__add");
    addBtn.addEventListener("click", () => addToCart(item.item_id, addBtn));

    card.appendChild(image);
    card.appendChild(body);
    return card;
  }

  // Debounced server-side search using GET /menu/search.
  let searchDebounce = null;
  function initSearch() {
    searchInput.addEventListener("input", () => {
      clearTimeout(searchDebounce);
      const term = searchInput.value.trim();
      searchDebounce = setTimeout(() => runSearch(term), 300);
    });
  }

  async function runSearch(term) {
    state.searchTerm = term;
    if (!term) {
      renderMenu();
      return;
    }
    try {
      const data = await apiRequest(`/menu/search?q=${encodeURIComponent(term)}`);
      const results = data.menu || [];
      menuGrid.innerHTML = "";
      menuEmpty.hidden = results.length > 0;
      results.forEach((item) => menuGrid.appendChild(buildMenuCard(item)));
    } catch (err) {
      showToast(err.message);
    }
  }

  // ===================================================================
  // CART
  // ===================================================================
  async function addToCart(itemId, buttonEl) {
    try {
      const cart = await apiRequest("/cart", {
        method: "POST",
        body: JSON.stringify({ item_id: itemId, quantity: 1 }),
      });
      state.cart = cart;
      renderCart();
      if (buttonEl) {
        buttonEl.classList.add("is-added");
        buttonEl.textContent = "\u2713";
        setTimeout(() => {
          buttonEl.classList.remove("is-added");
          buttonEl.textContent = "+";
        }, 700);
      }
    } catch (err) {
      showToast(err.message);
    }
  }

  async function setCartQuantity(itemId, quantity) {
    try {
      const cart = await apiRequest("/cart", {
        method: "PUT",
        body: JSON.stringify({ item_id: itemId, quantity }),
      });
      state.cart = cart;
      renderCart();
    } catch (err) {
      showToast(err.message);
    }
  }

  async function removeFromCart(itemId) {
    try {
      const cart = await apiRequest(`/cart/${itemId}`, { method: "DELETE" });
      state.cart = cart;
      renderCart();
    } catch (err) {
      showToast(err.message);
    }
  }

  async function loadCart() {
    try {
      state.cart = await apiRequest("/cart");
      renderCart();
    } catch (err) {
      showToast(err.message);
    }
  }

  function renderCart() {
    const { items, total_amount } = state.cart;

    const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
    cartCountBadge.hidden = itemCount === 0;
    cartCountBadge.textContent = String(itemCount);

    cartItemsEl.innerHTML = "";
    cartEmptyEl.hidden = items.length > 0;
    checkoutBtn.disabled = items.length === 0;

    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "cart-item";
      row.innerHTML = `
        <div>
          <div class="cart-item__name"></div>
          <div class="cart-item__unit mono"></div>
        </div>
        <div class="cart-item__subtotal mono"></div>
        <div class="cart-item__controls">
          <div class="qty-stepper">
            <button type="button" class="qty-minus" aria-label="Decrease quantity">&minus;</button>
            <span></span>
            <button type="button" class="qty-plus" aria-label="Increase quantity">+</button>
          </div>
          <button type="button" class="cart-item__remove">Remove</button>
        </div>
      `;
      row.querySelector(".cart-item__name").textContent = item.item_name;
      row.querySelector(".cart-item__unit").textContent = `${formatCurrency(item.unit_price)} each`;
      row.querySelector(".cart-item__subtotal").textContent = formatCurrency(item.subtotal);
      row.querySelector(".qty-stepper span").textContent = String(item.quantity);

      row.querySelector(".qty-minus").addEventListener("click", () => {
        if (item.quantity <= 1) {
          removeFromCart(item.item_id);
        } else {
          setCartQuantity(item.item_id, item.quantity - 1);
        }
      });
      row.querySelector(".qty-plus").addEventListener("click", () => {
        setCartQuantity(item.item_id, item.quantity + 1);
      });
      row.querySelector(".cart-item__remove").addEventListener("click", () => {
        removeFromCart(item.item_id);
      });

      cartItemsEl.appendChild(row);
    });

    cartTotalEl.textContent = formatCurrency(total_amount);
  }

  function openCart() {
    cartDrawer.classList.add("is-open");
    cartScrim.hidden = false;
  }
  function closeCart() {
    cartDrawer.classList.remove("is-open");
    cartScrim.hidden = true;
  }

  // ===================================================================
  // CHECKOUT / PAYMENT
  // ===================================================================
  function showCheckoutStep(stepEl) {
    [stepConfirm, stepPay, stepWaiting, stepFailed].forEach((s) => {
      s.hidden = s !== stepEl;
    });
  }

  function openCheckout() {
    closeCart();
    checkoutSeatNumberEl.textContent = state.seatNumber;
    checkoutSummaryEl.innerHTML = "";
    state.cart.items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "checkout-summary__row";
      row.innerHTML = `<span></span><span></span>`;
      row.children[0].textContent = `${item.quantity}\u00d7 ${item.item_name}`;
      row.children[1].textContent = formatCurrency(item.subtotal);
      checkoutSummaryEl.appendChild(row);
    });
    checkoutTotalEl.textContent = formatCurrency(state.cart.total_amount);
    showCheckoutStep(stepConfirm);
    checkoutModal.hidden = false;
  }

  function closeCheckout() {
    checkoutModal.hidden = true;
  }

  async function cancelCurrentOrder() {
    const orderId = state.currentOrderId;
    state.currentOrderId = null;
    closeCheckout();

    if (!orderId) return; // Nothing was ever placed yet - just closing is enough.

    try {
      await apiRequest(`/kitchen/orders/${orderId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "Cancelled" }),
      });
      showToast("Order cancelled.", "success");
    } catch (err) {
      showToast(`Order #${orderId} may not have been cancelled: ${err.message}`);
    }
  }

  async function placeOrder() {
    placeOrderBtn.disabled = true;
    try {
      const result = await apiRequest("/orders", {
        method: "POST",
        body: JSON.stringify({ seat_number: state.seatNumber }),
      });
      state.currentOrderId = result.order_id;

      // Cart was cleared server-side on successful checkout - mirror that locally.
      state.cart = { items: [], total_amount: 0 };
      renderCart();

      socket.emit("join_order_room", { order_id: result.order_id });

      payOrderIdEl.textContent = result.order_id;
      showCheckoutStep(stepPay);
    } catch (err) {
      showToast(err.message);
    } finally {
      placeOrderBtn.disabled = false;
    }
  }

  function validatePhoneNumber(raw) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 9) return "Enter a valid phone number.";
    return null;
  }

  async function sendPayment() {
    const raw = phoneInput.value.trim();
    const error = validatePhoneNumber(raw);
    if (error) {
      phoneErrorEl.textContent = error;
      phoneErrorEl.hidden = false;
      return;
    }
    phoneErrorEl.hidden = true;
    payBtn.disabled = true;

    try {
      await apiRequest("/payments/mpesa", {
        method: "POST",
        body: JSON.stringify({ order_id: state.currentOrderId, phone_number: raw }),
      });
      showCheckoutStep(stepWaiting);
    } catch (err) {
      phoneErrorEl.textContent = err.message;
      phoneErrorEl.hidden = false;
    } finally {
      payBtn.disabled = false;
    }
  }

  // ===================================================================
  // LIVE ORDER TRACKING
  // ===================================================================
  const STATUS_STEPS = ["Pending", "Preparing", "Ready", "Completed"];

  function applyOrderStatus(status) {
    const steps = progressTrack.querySelectorAll(".progress-track__step");

    if (status === "Cancelled") {
      progressTrack.style.setProperty("--progress", "0");
      steps.forEach((step) => {
        step.classList.remove("is-complete", "is-current");
        step.classList.add("is-cancelled");
      });
      trackingView.querySelector(".tracker-heading").textContent = "This order was cancelled";
      newOrderBtn.hidden = false;
      return;
    }

    const currentIndex = STATUS_STEPS.indexOf(status);
    steps.forEach((step, index) => {
      step.classList.remove("is-complete", "is-current", "is-cancelled");
      if (index < currentIndex) step.classList.add("is-complete");
      if (index === currentIndex) step.classList.add("is-current");
    });
    progressTrack.style.setProperty("--progress", String(currentIndex / (STATUS_STEPS.length - 1)));

    const heading = trackingView.querySelector(".tracker-heading");
    if (status === "Completed") {
      heading.textContent = "Enjoy your meal!";
      newOrderBtn.hidden = false;
    } else {
      heading.textContent = "We've got it from here";
      newOrderBtn.hidden = true;
    }
  }

  function openTrackingView(orderId, total) {
    closeCheckout();
    menuView.hidden = true;
    trackerOrderIdEl.textContent = orderId;
    trackerItemsEl.innerHTML = checkoutSummaryEl.innerHTML;
    trackerTotalEl.textContent = formatCurrency(total);
    trackingView.hidden = false;
  }

  function startNewOrder() {
    trackingView.hidden = true;
    menuView.hidden = false;
    state.currentOrderId = null;
    resetSeatForNewCustomer();
  }

  // ===================================================================
  // SOCKET.IO
  // ===================================================================
  function initSocket() {
    socket = io();

    socket.on("connect", () => {
      socket.emit("customer_connected", {
        table_id: appRoot.dataset.tableNumber,
        seat_number: state.seatNumber,
      });
      if (state.currentOrderId) {
        socket.emit("join_order_room", { order_id: state.currentOrderId });
      }
    });

    socket.on("payment_success", (payload) => {
      if (payload.order_id !== state.currentOrderId) return;
      openTrackingView(state.currentOrderId, payload.amount || state.cart.total_amount);
      applyOrderStatus("Pending");
      showToast("Payment received - your order is on its way!", "success");
    });

    socket.on("payment_failed", (payload) => {
      if (payload.order_id !== state.currentOrderId) return;
      paymentFailReasonEl.textContent = payload.reason || "Please try again.";
      showCheckoutStep(stepFailed);
    });

    const statusHandler = (status) => (payload) => {
      if (payload.order_id !== state.currentOrderId) return;
      applyOrderStatus(status);
    };
    socket.on("order_received", statusHandler("Pending"));
    socket.on("order_preparing", statusHandler("Preparing"));
    socket.on("order_ready", statusHandler("Ready"));
    socket.on("order_completed", statusHandler("Completed"));
    socket.on("order_cancelled", statusHandler("Cancelled"));
  }

  // ===================================================================
  // BOOTSTRAP
  // ===================================================================
  function startApp() {
    initSocket();
    Promise.all([loadCategories(), loadMenu(), loadCart()]).catch((err) => showToast(err.message));
  }

  function initEventListeners() {
    initSearch();

    cartToggleBtn.addEventListener("click", openCart);
    cartCloseBtn.addEventListener("click", closeCart);
    cartScrim.addEventListener("click", closeCart);

    checkoutBtn.addEventListener("click", openCheckout);
    document.querySelectorAll(".checkout-cancel").forEach((btn) =>
      btn.addEventListener("click", closeCheckout)
    );
    document.querySelectorAll(".cancel-order-btn").forEach((btn) =>
      btn.addEventListener("click", cancelCurrentOrder)
    );

    placeOrderBtn.addEventListener("click", placeOrder);
    payBtn.addEventListener("click", sendPayment);
    retryPayBtn.addEventListener("click", () => showCheckoutStep(stepPay));

    newOrderBtn.addEventListener("click", startNewOrder);
  }

  document.addEventListener("DOMContentLoaded", () => {
    initEventListeners();
    initSeatEntry();
  });
})();