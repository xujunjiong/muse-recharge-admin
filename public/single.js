"use strict";
let csrf = "";
const $ = (id) => document.getElementById(id);
const statusText = {
  queued: "排队中（优先）",
  preparing: "准备中",
  payment_submitting: "提交付款中",
  processing: "充值中",
  needs_review: "待核查",
  succeeded: "成功",
  partial: "部分成功",
  failed: "失败",
  cancelled: "已取消",
};
function show(el, msg) {
  el.textContent = msg || "";
  el.hidden = !msg;
}
async function api(path, body) {
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(body === undefined ? {} : { "x-csrf-token": csrf }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("请求失败 " + r.status));
  return j;
}
function renderOrders(orders) {
  const ul = $("orders");
  ul.innerHTML = "";
  if (!orders.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "还没有单子";
    ul.appendChild(li);
    return;
  }
  for (const o of orders) {
    const li = document.createElement("li");
    li.className = "order";
    const cost = o.actualCost != null ? o.actualCost + " IDR" : "—";
    li.textContent =
      o.code +
      " · " +
      (statusText[o.status] || o.status) +
      " · 30B · 实扣 " +
      cost +
      " · " +
      (o.message || "") +
      " · " +
      (o.updatedAt || "");
    ul.appendChild(li);
  }
}
async function refresh() {
  try {
    const d = await api("/api/single/orders");
    renderOrders(d.orders || []);
  } catch (e) {
    show($("order-error"), e.message);
  }
}
let polling = null;
function startPolling() {
  if (!polling) polling = setInterval(refresh, 5000);
}
async function boot() {
  try {
    const s = await api("/api/session");
    if (s.role !== "single") throw new Error("not single");
    csrf = s.csrf;
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    await refresh();
    startPolling();
  } catch {
    $("login-view").hidden = false;
    $("app-view").hidden = true;
  }
}
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  show($("login-error"), "");
  try {
    const r = await api("/api/login", { password: $("password").value });
    if (r.role === "admin") {
      window.location.href = "/";
      return;
    }
    csrf = r.csrf;
    $("password").value = "";
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    await refresh();
    startPolling();
  } catch (err) {
    show($("login-error"), err.message);
  }
});
$("order-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  show($("order-error"), "");
  show($("order-ok"), "");
  try {
    const code = $("code").value.trim().toUpperCase();
    await api("/api/single/order", { code });
    $("code").value = "";
    show($("order-ok"), code + " 已提交，优先排队中");
    await refresh();
  } catch (err) {
    show($("order-error"), err.message);
  }
});
$("logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", {});
  } finally {
    window.location.reload();
  }
});
boot();
