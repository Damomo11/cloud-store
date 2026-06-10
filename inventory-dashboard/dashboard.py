#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Standalone inventory dashboard for cloud-store.sqlite.

Run:
  python inventory-dashboard/dashboard.py

Then open:
  http://127.0.0.1:8787/u/PlayerName
  http://127.0.0.1:8787/vault/WarehouseName
  http://127.0.0.1:8787/momo
"""

from __future__ import annotations

import argparse
import hashlib
import http.cookies
import importlib.util
import json
import re
import sqlite3
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPT_DIR.parent
DEFAULT_DB = ROOT_DIR / "data" / "cloud-store.sqlite"
DEFAULT_LANG = ROOT_DIR / "data" / "zh_cn.json"
DEFAULT_CONFIG = ROOT_DIR / "config.json"
DEFAULT_SERVER_ENCHANTMENTS = ROOT_DIR / "data" / "server-enchantments.json"
ADMIN_VIEWER_PATH = ROOT_DIR / "data" / "warehouse_viewer.py"
MOMO_OWNER = "__momo__"


def load_admin_viewer_module():
    spec = importlib.util.spec_from_file_location("cloud_store_admin_viewer", ADMIN_VIEWER_PATH)
    if not spec or not spec.loader:
        raise RuntimeError(f"无法加载管理员面板：{ADMIN_VIEWER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ADMIN_VIEWER = load_admin_viewer_module()


HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>云仓库库存看板</title>
  <style>
    :root {
      --bg: #0f0f0f;
      --panel: #c6c6c6;
      --panel-dark: #8b8b8b;
      --panel-light: #f7f7f7;
      --slot: #8b8b8b;
      --slot-inner: #6f6f6f;
      --text: #f8f8f8;
      --muted: #bdbdbd;
      --green: #55ff55;
      --yellow: #ffff55;
      --purple: #aa00aa;
      --black: rgba(0, 0, 0, .88);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background:
        linear-gradient(rgba(0,0,0,.36), rgba(0,0,0,.36)),
        repeating-linear-gradient(45deg, #26311f 0 18px, #20291a 18px 36px);
      font: 16px/1.4 "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif;
      min-height: 100vh;
    }
    .app {
      width: min(1360px, calc(100vw - 28px));
      margin: 18px auto 26px;
    }
    .mc-window {
      background: var(--panel);
      border: 4px solid;
      border-color: var(--panel-light) #555 #555 var(--panel-light);
      box-shadow: 0 0 0 3px #000, 0 14px 38px rgba(0,0,0,.42);
      color: #202020;
      padding: 12px;
    }
    header {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      align-items: end;
      margin-bottom: 12px;
    }
    h1 {
      margin: 0 0 4px;
      font-size: 22px;
      font-weight: 800;
      letter-spacing: 0;
      color: #222;
      text-shadow: 1px 1px #fff;
    }
    .subtitle { color: #3f3f3f; font-size: 13px; }
    .toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    input, select, button {
      height: 36px;
      border-radius: 0;
      border: 3px solid;
      border-color: #555 #fff #fff #555;
      background: #2b2b2b;
      color: var(--text);
      padding: 0 10px;
      font: inherit;
      outline: none;
    }
    input { width: min(360px, 60vw); }
    button {
      cursor: pointer;
      background: #737373;
      border-color: #aaa #3d3d3d #3d3d3d #aaa;
      color: #fff;
      text-shadow: 1px 1px #111;
    }
    button:active {
      border-color: #3d3d3d #aaa #aaa #3d3d3d;
      transform: translateY(1px);
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(130px, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }
    .stat {
      background: #e0e0e0;
      border: 3px solid;
      border-color: #fff #777 #777 #fff;
      padding: 8px 10px;
      min-height: 58px;
    }
    .stat span { display: block; color: #555; font-size: 12px; }
    .stat strong { display: block; color: #222; font-size: 20px; margin-top: 3px; }
    .inventory {
      display: grid;
      grid-template-columns: repeat(auto-fill, 54px);
      gap: 4px;
      align-items: start;
      min-height: 326px;
      padding: 8px;
      background: #b8b8b8;
      border: 3px solid;
      border-color: #777 #fff #fff #777;
    }
    .slot {
      position: relative;
      width: 54px;
      height: 54px;
      background: var(--slot);
      border: 3px solid;
      border-color: #5d5d5d #e3e3e3 #e3e3e3 #5d5d5d;
      image-rendering: pixelated;
      cursor: default;
    }
    .slot:hover {
      outline: 3px solid rgba(255,255,255,.65);
      z-index: 5;
    }
    .icon-wrap {
      position: absolute;
      inset: 5px;
      display: grid;
      place-items: center;
    }
    .icon-wrap img {
      width: 38px;
      height: 38px;
      object-fit: contain;
      image-rendering: pixelated;
      filter: drop-shadow(2px 2px 0 rgba(0,0,0,.35));
    }
    .fallback-icon {
      width: 38px;
      height: 38px;
      display: none;
      place-items: center;
      color: #fff;
      font-size: 10px;
      font-weight: 800;
      text-align: center;
      line-height: 1.05;
      text-shadow: 1px 1px #000;
      background: linear-gradient(135deg, #5f8f43, #917041);
      border: 2px solid rgba(255,255,255,.24);
      box-shadow: inset -3px -3px rgba(0,0,0,.22), inset 3px 3px rgba(255,255,255,.18);
      overflow: hidden;
      padding: 2px;
    }
    .count {
      position: absolute;
      right: 3px;
      bottom: 0;
      color: #fff;
      font-weight: 400;
      font-size: 15px;
      text-shadow: 2px 2px #202020;
      pointer-events: none;
    }
    .tooltip {
      position: fixed;
      z-index: 1000;
      max-width: min(560px, calc(100vw - 24px));
      pointer-events: none;
      background: var(--black);
      color: #fff;
      border: 2px solid #2d0a63;
      box-shadow: 0 0 0 2px #12002d, 0 8px 22px rgba(0,0,0,.45);
      padding: 9px 10px;
      display: none;
      font-size: 14px;
    }
    .tip-title { color: #fff; font-weight: 800; margin-bottom: 2px; }
    .tip-id { color: #5555ff; font-size: 12px; overflow-wrap: anywhere; }
    .tip-line { color: #bdbdbd; margin-top: 4px; }
    .tip-good { color: var(--green); }
    .tip-warn { color: var(--yellow); }
    .tip-purple { color: #ff55ff; }
    .shulker-grid {
      display: grid;
      grid-template-columns: repeat(7, 30px);
      gap: 3px;
      margin-top: 8px;
      width: max-content;
      max-width: 100%;
    }
    .mini-slot {
      position: relative;
      width: 30px;
      height: 30px;
      background: #8b8b8b;
      border: 2px solid;
      border-color: #5d5d5d #e3e3e3 #e3e3e3 #5d5d5d;
    }
    .mini-slot img {
      position: absolute;
      inset: 4px;
      width: 18px;
      height: 18px;
      object-fit: contain;
      image-rendering: pixelated;
    }
    .mini-count {
      position: absolute;
      right: 1px;
      bottom: -2px;
      color: #fff;
      font-size: 10px;
      font-weight: 400;
      text-shadow: 1px 1px #000;
    }
    .empty {
      min-height: 240px;
      display: grid;
      place-items: center;
      color: #3c3c3c;
      font-weight: 800;
      text-shadow: 1px 1px #fff;
    }
    .footer {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 10px;
      color: #343434;
      font-size: 12px;
    }
    .login {
      display: none;
      background: #e0e0e0;
      border: 3px solid;
      border-color: #fff #777 #777 #fff;
      padding: 12px;
      margin-bottom: 12px;
    }
    .login.visible { display: block; }
    .owner-select { min-width: 220px; }
    .link-button {
      display: inline-grid;
      place-items: center;
      height: 36px;
      padding: 0 10px;
      border: 3px solid;
      border-color: #aaa #3d3d3d #3d3d3d #aaa;
      background: #737373;
      color: #fff;
      text-decoration: none;
      text-shadow: 1px 1px #111;
    }
    @media (max-width: 780px) {
      header { grid-template-columns: 1fr; }
      .stats { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
      .inventory { grid-template-columns: repeat(auto-fill, 48px); }
      .slot { width: 48px; height: 48px; }
      .icon-wrap img, .fallback-icon { width: 34px; height: 34px; }
    }
  </style>
</head>
<body>
  <main class="app">
    <section class="mc-window">
      <header>
        <div>
          <h1 id="title">云仓库库存</h1>
          <div class="subtitle" id="subtitle">正在读取库存...</div>
        </div>
        <div class="toolbar">
          <select id="ownerSelect" class="owner-select"></select>
          <input id="search" placeholder="搜索物品名、ID、6位码、附魔、潜影盒内容">
          <button id="refresh">刷新</button>
          <a id="adminLink" class="link-button" href="/admin" style="display:none">管理员</a>
          <button id="logout">退出</button>
        </div>
      </header>
      <div class="login" id="loginBox">
        <div class="toolbar">
          <input id="tokenInput" placeholder="私聊机器人发送：登录密钥">
          <button id="loginBtn">登录</button>
        </div>
        <div class="subtitle">登录后只能查看自己的个人库存，以及自己加入的组织仓库库存。密钥泄露后可私聊机器人“重置密钥”。</div>
      </div>
      <div class="stats" id="stats"></div>
      <div class="inventory" id="inventory"></div>
      <div class="footer">
        <span id="status">等待数据</span>
        <span>每 5 秒自动刷新；鼠标放到格子上查看详情。</span>
      </div>
    </section>
  </main>
  <div class="tooltip" id="tooltip"></div>

  <script>
    const state = {
      owner: "",
      me: null,
      owners: [],
      items: [],
      filtered: [],
      lastLoadedAt: null,
      poll: null
    };

    const el = {
      title: document.getElementById("title"),
      subtitle: document.getElementById("subtitle"),
      stats: document.getElementById("stats"),
      inventory: document.getElementById("inventory"),
      loginBox: document.getElementById("loginBox"),
      tokenInput: document.getElementById("tokenInput"),
      loginBtn: document.getElementById("loginBtn"),
      ownerSelect: document.getElementById("ownerSelect"),
      search: document.getElementById("search"),
      refresh: document.getElementById("refresh"),
      logout: document.getElementById("logout"),
      adminLink: document.getElementById("adminLink"),
      status: document.getElementById("status"),
      tooltip: document.getElementById("tooltip")
    };

    function routeOwner() {
      const path = decodeURIComponent(location.pathname || "/");
      if (path === "/momo") return "momo";
      if (path.startsWith("/u/")) return path.slice(3);
      if (path.startsWith("/player/")) return path.slice(8);
      if (path.startsWith("/vault/")) return "仓库:" + path.slice(7);
      const params = new URLSearchParams(location.search);
      return params.get("owner") || "";
    }

    function api(path, params = {}) {
      const qs = new URLSearchParams(params);
      return fetch(path + "?" + qs.toString(), { cache: "no-store" }).then(async res => {
        const data = await res.json();
        if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
        return data;
      });
    }

    function apiPost(path, body = {}) {
      return fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(async res => {
        const data = await res.json();
        if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
        return data;
      });
    }

    function iconUrl(itemId, size = 64, type = "item") {
      const id = encodeURIComponent(itemId || "minecraft:stone");
      return `https://blocksitems.com/api/v1/${type}s/${id}/icon?size=${size}`;
    }

    function setIcon(img, itemId, size = 64) {
      img.dataset.stage = "item";
      img.src = iconUrl(itemId, size, "item");
      img.onerror = () => {
        if (img.dataset.stage === "item") {
          img.dataset.stage = "block";
          img.src = iconUrl(itemId, size, "block");
          return;
        }
        img.style.display = "none";
        const fallback = img.parentElement.querySelector(".fallback-icon");
        if (fallback) fallback.style.display = "grid";
      };
    }

    function shortAmount(value) {
      const n = Number(value || 0);
      if (n >= 1000000) return Math.floor(n / 100000) / 10 + "m";
      if (n >= 10000) return Math.floor(n / 1000) + "k";
      return String(n);
    }

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    function itemHaystack(item) {
      const parts = [
        item.displayName,
        item.baseName,
        item.itemId,
        item.itemKey,
        item.shortCode,
        item.customName,
        ...(item.details || []),
        ...(item.shulkerContents || []).flatMap(x => [x.displayName, x.itemId, x.shortCode, ...(x.details || [])])
      ];
      return parts.join(" ").toLowerCase();
    }

    function filterItems() {
      const q = el.search.value.trim().toLowerCase();
      state.filtered = q ? state.items.filter(item => itemHaystack(item).includes(q)) : [...state.items];
      render();
    }

    async function loadMe() {
      try {
        const data = await api("/api/me");
        state.me = data.user;
        state.owners = data.owners || [];
        el.loginBox.classList.remove("visible");
        el.logout.style.display = "";
        el.ownerSelect.style.display = "";
        el.search.style.display = "";
        el.refresh.style.display = "";
        el.adminLink.style.display = data.user?.isAdmin ? "" : "none";
        renderOwnerSelect();
        await load();
      } catch (error) {
        state.me = null;
        state.owners = [];
        el.title.textContent = "云仓库库存";
        el.subtitle.textContent = "请先登录。";
        el.stats.innerHTML = "";
        el.inventory.innerHTML = '<div class="empty">请先私聊机器人获取登录密钥。</div>';
        el.status.textContent = "未登录";
        el.loginBox.classList.add("visible");
        el.logout.style.display = "none";
        el.ownerSelect.style.display = "none";
        el.search.style.display = "none";
        el.refresh.style.display = "none";
        el.adminLink.style.display = "none";
      }
    }

    function renderOwnerSelect() {
      const preferred = routeOwner();
      el.ownerSelect.innerHTML = state.owners.map(owner => `<option value="${escapeHtml(owner.ownerUuid)}">${escapeHtml(owner.label)}</option>`).join("");
      const allowed = state.owners.find(owner => owner.ownerUuid === preferred || owner.label === preferred);
      state.owner = allowed ? allowed.ownerUuid : (state.owners[0]?.ownerUuid || "");
      el.ownerSelect.value = state.owner;
    }

    async function login() {
      const token = el.tokenInput.value.trim();
      if (!token) {
        el.status.textContent = "请填写登录密钥";
        return;
      }
      el.status.textContent = "正在登录...";
      await apiPost("/api/login", { token });
      el.tokenInput.value = "";
      await loadMe();
    }

    async function logout() {
      await apiPost("/api/logout", {});
      state.items = [];
      state.filtered = [];
      await loadMe();
    }

    async function load() {
      if (!state.me) return loadMe();
      state.owner = el.ownerSelect.value || state.owner;
      if (!state.owner) {
        el.inventory.innerHTML = '<div class="empty">没有可查看的仓库。</div>';
        return;
      }
      el.status.textContent = "正在刷新...";
      const data = await api("/api/inventory", { owner: state.owner });
      state.items = data.items || [];
      state.lastLoadedAt = new Date();
      el.title.textContent = data.ownerLabel || state.owner;
      el.subtitle.textContent = `${data.ownerUuid || ""}`;
      renderStats(data.stats || {});
      filterItems();
      el.status.textContent = `已刷新：${state.lastLoadedAt.toLocaleTimeString()}`;
    }

    function renderStats(stats) {
      el.stats.innerHTML = [
        ["物品总数", stats.totalAmount || 0],
        ["物品种类", stats.itemTypes || 0],
        ["折合格数", stats.usedSlots || 0],
        ["潜影盒", stats.shulkerBoxes || 0]
      ].map(([name, value]) => `<div class="stat"><span>${name}</span><strong>${value}</strong></div>`).join("");
    }

    function render() {
      const items = state.filtered;
      if (!items.length) {
        el.inventory.innerHTML = `<div class="empty">${state.items.length ? "没有匹配的物品" : "当前没有库存"}</div>`;
        return;
      }
      el.inventory.innerHTML = "";
      for (const item of items) {
        const slot = document.createElement("div");
        slot.className = "slot";
        slot.tabIndex = 0;
        slot.dataset.key = item.itemKey;
        slot.innerHTML = `
          <div class="icon-wrap">
            <img alt="">
            <div class="fallback-icon">${escapeHtml((item.displayName || item.itemId || "?").slice(0, 4))}</div>
          </div>
          <span class="count">${escapeHtml(shortAmount(item.amount))}</span>
        `;
        setIcon(slot.querySelector("img"), item.itemId, 64);
        slot.addEventListener("mousemove", event => showTooltip(item, event));
        slot.addEventListener("mouseenter", event => showTooltip(item, event));
        slot.addEventListener("mouseleave", hideTooltip);
        slot.addEventListener("blur", hideTooltip);
        slot.addEventListener("focus", event => showTooltip(item, event));
        el.inventory.appendChild(slot);
      }
    }

    function showTooltip(item, event) {
      const details = (item.details || []).map(x => `<div class="tip-line tip-good">${escapeHtml(x)}</div>`).join("");
      const shulker = item.shulkerContents?.length ? renderShulkerTooltip(item.shulkerContents) : "";
      el.tooltip.innerHTML = `
        <div class="tip-title">${escapeHtml(item.displayName || item.baseName || item.itemId)} <span class="tip-warn">x${escapeHtml(item.amount)}</span></div>
        ${item.customName && item.customName !== item.baseName ? `<div class="tip-line tip-purple">原名：${escapeHtml(item.baseName)}</div>` : ""}
        <div class="tip-id">${escapeHtml(item.itemId)}</div>
        ${item.shortCode ? `<div class="tip-line tip-warn">短码：${escapeHtml(item.shortCode)}</div>` : ""}
        ${details}
        ${shulker}
      `;
      el.tooltip.style.display = "block";
      moveTooltip(event);
    }

    function renderShulkerTooltip(contents) {
      const cells = contents.slice(0, 21).map(item => `
        <div class="mini-slot" title="${escapeHtml(item.displayName)} x${escapeHtml(item.amount)}">
          <img src="${escapeHtml(iconUrl(item.itemId, 32, "item"))}" onerror="this.onerror=null;this.src='${escapeHtml(iconUrl(item.itemId, 32, "block"))}'">
          <span class="mini-count">${escapeHtml(shortAmount(item.amount))}</span>
        </div>
      `).join("");
      const extra = contents.length > 21 ? `<div class="tip-line tip-warn">还有 ${contents.length - 21} 种未显示</div>` : "";
      const list = contents.map(item => `<div class="tip-line">${escapeHtml(item.displayName)} x${escapeHtml(item.amount)}${item.details?.length ? "，" + escapeHtml(item.details.join("，")) : ""}</div>`).join("");
      return `<div class="tip-line tip-warn">潜影盒内容</div><div class="shulker-grid">${cells}</div>${extra}${list}`;
    }

    function moveTooltip(event) {
      const pad = 14;
      const rect = el.tooltip.getBoundingClientRect();
      let x = (event.clientX || 24) + pad;
      let y = (event.clientY || 24) + pad;
      if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
      if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
      el.tooltip.style.left = Math.max(8, x) + "px";
      el.tooltip.style.top = Math.max(8, y) + "px";
    }

    function hideTooltip() {
      el.tooltip.style.display = "none";
    }

    el.search.addEventListener("input", filterItems);
    el.refresh.addEventListener("click", () => load().catch(showError));
    el.ownerSelect.addEventListener("change", () => load().catch(showError));
    el.loginBtn.addEventListener("click", () => login().catch(showError));
    el.tokenInput.addEventListener("keydown", event => {
      if (event.key === "Enter") login().catch(showError);
    });
    el.logout.addEventListener("click", () => logout().catch(showError));
    window.addEventListener("scroll", hideTooltip, { passive: true });

    function showError(error) {
      console.error(error);
      el.status.textContent = "读取失败：" + error.message;
      el.inventory.innerHTML = `<div class="empty">读取失败：${escapeHtml(error.message)}</div>`;
    }

    loadMe().catch(showError);
    state.poll = setInterval(() => load().catch(showError), 5000);
  </script>
</body>
</html>
"""


def connect_db(db_path: Path, query_only: bool = True) -> sqlite3.Connection:
    if not db_path.exists():
        raise FileNotFoundError(f"找不到数据库文件：{db_path}")
    conn = sqlite3.connect(str(db_path), timeout=5)
    conn.row_factory = sqlite3.Row
    if query_only:
        conn.execute("PRAGMA query_only = ON")
    else:
        ensure_web_schema(conn)
    return conn


def ensure_web_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS web_login_tokens (
          owner_uuid TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          token_hint TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_web_login_tokens_hash ON web_login_tokens(token_hash)")


def token_hash(token: str) -> str:
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


def load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


CONFIG = load_json(DEFAULT_CONFIG)
LANG = load_json(DEFAULT_LANG)


def load_enchantments() -> tuple[dict[int, dict], dict[str, dict]]:
    server_data = load_json(DEFAULT_SERVER_ENCHANTMENTS)
    server_rows = server_data.get("enchantments") if isinstance(server_data, dict) else None
    if isinstance(server_rows, list) and server_rows:
        by_id: dict[int, dict] = {}
        by_name: dict[str, dict] = {}
        for row in server_rows:
            if not isinstance(row, dict):
                continue
            try:
                numeric_id = int(row.get("id"))
            except Exception:
                continue
            name = str(row.get("name") or row.get("key") or "").replace("minecraft:", "")
            if not name:
                continue
            normalized = {"id": numeric_id, "name": name, "displayName": row.get("displayName") or name}
            by_id[numeric_id] = normalized
            by_name[name] = normalized
        if by_id:
            return by_id, by_name

    version = str(((CONFIG.get("server") or {}).get("version")) or "1.21.11")
    candidates = [
        ROOT_DIR / "node_modules" / "minecraft-data" / "minecraft-data" / "data" / "pc" / version / "enchantments.json",
        ROOT_DIR / "node_modules" / "minecraft-data" / "minecraft-data" / "data" / "pc" / "1.21.11" / "enchantments.json",
        ROOT_DIR / "node_modules" / "minecraft-data" / "minecraft-data" / "data" / "pc" / "1.21.4" / "enchantments.json",
    ]
    rows = []
    for path in candidates:
        rows = load_json(path)
        if isinstance(rows, list) and rows:
            break
    by_id: dict[int, dict] = {}
    by_name: dict[str, dict] = {}
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        if isinstance(row.get("id"), int):
            by_id[row["id"]] = row
        if row.get("name"):
            by_name[str(row["name"])] = row
    return by_id, by_name


ENCHANTMENTS_MTIME = DEFAULT_SERVER_ENCHANTMENTS.stat().st_mtime if DEFAULT_SERVER_ENCHANTMENTS.exists() else None
ENCHANTMENTS_BY_ID, ENCHANTMENTS_BY_NAME = load_enchantments()


def refresh_enchantments_if_changed() -> None:
    global ENCHANTMENTS_MTIME, ENCHANTMENTS_BY_ID, ENCHANTMENTS_BY_NAME
    current = DEFAULT_SERVER_ENCHANTMENTS.stat().st_mtime if DEFAULT_SERVER_ENCHANTMENTS.exists() else None
    if current == ENCHANTMENTS_MTIME:
        return
    ENCHANTMENTS_MTIME = current
    ENCHANTMENTS_BY_ID, ENCHANTMENTS_BY_NAME = load_enchantments()


def item_simple_id(item_id: str) -> str:
    return str(item_id or "").replace("minecraft:", "", 1)


def base_display_name(item_id: str) -> str:
    simple = item_simple_id(item_id)
    return LANG.get(f"block.minecraft.{simple}") or LANG.get(f"item.minecraft.{simple}") or simple


def short_code(item_key: str) -> str:
    text = str(item_key or "")
    if "|" not in text:
        return ""
    return text.split("|", 1)[1][:6].lower()


def owner_label(owner_uuid: str, players: dict[str, str] | None = None) -> str:
    players = players or {}
    if owner_uuid == MOMO_OWNER:
        return "momo"
    if owner_uuid in players:
        return players[owner_uuid]
    if owner_uuid.startswith("vault:"):
        return f"仓库:{owner_uuid[6:]}"
    if owner_uuid.startswith("name:"):
        return owner_uuid[5:]
    return owner_uuid


def load_players(conn: sqlite3.Connection) -> dict[str, str]:
    rows = conn.execute("SELECT uuid, username FROM players").fetchall()
    labels = {row["uuid"]: row["username"] for row in rows}
    try:
        vaults = conn.execute("SELECT name_lower AS nameLower, name FROM custom_warehouses").fetchall()
        for row in vaults:
            labels[f"vault:{row['nameLower']}"] = f"仓库:{row['name']}"
    except sqlite3.OperationalError:
        pass
    return labels


def is_admin(conn: sqlite3.Connection, owner_uuid: str, username: str) -> bool:
    try:
        row = conn.execute(
            """
            SELECT 1
            FROM admin_users
            WHERE lower(username) = lower(?) OR (uuid IS NOT NULL AND uuid = ?)
            LIMIT 1
            """,
            (username, owner_uuid),
        ).fetchone()
        return bool(row)
    except sqlite3.OperationalError:
        return False


def web_user_from_token(conn: sqlite3.Connection, token: str) -> dict | None:
    if not token:
        return None
    try:
        row = conn.execute(
            """
            SELECT owner_uuid AS ownerUuid, username, token_hint AS tokenHint, updated_at AS updatedAt
            FROM web_login_tokens
            WHERE token_hash = ?
            LIMIT 1
            """,
            (token_hash(token),),
        ).fetchone()
    except sqlite3.OperationalError:
        return None
    if not row:
        return None
    return {
        "ownerUuid": row["ownerUuid"],
        "username": row["username"],
        "tokenHint": row["tokenHint"],
        "updatedAt": row["updatedAt"],
        "isAdmin": is_admin(conn, row["ownerUuid"], row["username"]),
    }


def owner_options_for_user(conn: sqlite3.Connection, user: dict) -> list[dict]:
    if user.get("isAdmin"):
        owners: list[dict] = []
        player_rows = conn.execute(
            """
            SELECT p.uuid, p.username, COALESCE(SUM(b.amount), 0) AS totalAmount
            FROM players p
            JOIN balances b ON b.owner_uuid = p.uuid AND b.amount > 0
            GROUP BY p.uuid
            HAVING totalAmount > 0
            ORDER BY p.username COLLATE NOCASE ASC
            """
        ).fetchall()
        for row in player_rows:
            owners.append(
                {
                    "ownerUuid": row["uuid"],
                    "label": row["username"],
                    "type": "personal",
                    "role": "admin",
                    "totalAmount": int(row["totalAmount"] or 0),
                }
            )

        momo_total = conn.execute(
            "SELECT COALESCE(SUM(amount), 0) AS totalAmount FROM balances WHERE owner_uuid = ? AND amount > 0",
            (MOMO_OWNER,),
        ).fetchone()["totalAmount"]
        if momo_total:
            owners.append(
                {
                    "ownerUuid": MOMO_OWNER,
                    "label": "momo",
                    "type": "system",
                    "role": "admin",
                    "totalAmount": int(momo_total or 0),
                }
            )

        try:
            warehouse_rows = conn.execute(
                """
                SELECT w.name_lower AS nameLower, w.name, COALESCE(SUM(b.amount), 0) AS totalAmount
                FROM custom_warehouses w
                JOIN balances b ON b.owner_uuid = 'vault:' || w.name_lower AND b.amount > 0
                GROUP BY w.name_lower
                HAVING totalAmount > 0
                ORDER BY w.name COLLATE NOCASE ASC
                """
            ).fetchall()
            for row in warehouse_rows:
                owners.append(
                    {
                        "ownerUuid": f"vault:{row['nameLower']}",
                        "label": f"仓库:{row['name']}",
                        "type": "custom",
                        "role": "admin",
                        "totalAmount": int(row["totalAmount"] or 0),
                    }
                )
        except sqlite3.OperationalError:
            pass

        return owners

    owners = []
    personal_total = conn.execute(
        "SELECT COALESCE(SUM(amount), 0) AS totalAmount FROM balances WHERE owner_uuid = ? AND amount > 0",
        (user["ownerUuid"],),
    ).fetchone()["totalAmount"]
    if personal_total:
        owners.append(
            {
                "ownerUuid": user["ownerUuid"],
                "label": user["username"],
                "type": "personal",
                "role": "owner",
                "totalAmount": int(personal_total or 0),
            }
        )
    try:
        rows = conn.execute(
            """
            SELECT w.name_lower AS nameLower, w.name, m.role, COALESCE(SUM(b.amount), 0) AS totalAmount
            FROM custom_warehouse_members m
            JOIN custom_warehouses w ON w.name_lower = m.warehouse_name_lower
            JOIN balances b ON b.owner_uuid = 'vault:' || w.name_lower AND b.amount > 0
            WHERE m.player_uuid = ?
            GROUP BY w.name_lower
            HAVING totalAmount > 0
            ORDER BY w.name COLLATE NOCASE ASC
            """,
            (user["ownerUuid"],),
        ).fetchall()
        for row in rows:
            owners.append(
                {
                    "ownerUuid": f"vault:{row['nameLower']}",
                    "label": f"仓库:{row['name']}",
                    "type": "custom",
                    "role": row["role"],
                    "totalAmount": int(row["totalAmount"] or 0),
                }
            )
    except sqlite3.OperationalError:
        pass
    return owners


def can_view_owner(conn: sqlite3.Connection, user: dict, owner_uuid: str) -> bool:
    if user.get("isAdmin"):
        return True
    return any(owner["ownerUuid"] == owner_uuid for owner in owner_options_for_user(conn, user))


def resolve_owner(conn: sqlite3.Connection, raw_owner: str) -> tuple[str, str]:
    raw = urllib.parse.unquote(str(raw_owner or "")).strip()
    if not raw:
        raise ValueError("缺少 owner。请使用 /u/玩家名 或 /vault/仓库名")
    if raw.lower() == "momo":
        return MOMO_OWNER, "momo"
    if raw.startswith("仓库:"):
        name = raw[3:].strip()
        row = conn.execute(
            "SELECT name_lower AS nameLower, name FROM custom_warehouses WHERE name_lower = lower(?) OR name = ? LIMIT 1",
            (name, name),
        ).fetchone()
        if row:
            return f"vault:{row['nameLower']}", f"仓库:{row['name']}"
        return f"vault:{name.lower()}", f"仓库:{name}"
    if raw.lower().startswith("vault:"):
        name = raw[6:].strip()
        row = conn.execute(
            "SELECT name_lower AS nameLower, name FROM custom_warehouses WHERE name_lower = lower(?) OR name = ? LIMIT 1",
            (name, name),
        ).fetchone()
        if row:
            return f"vault:{row['nameLower']}", f"仓库:{row['name']}"
        return f"vault:{name.lower()}", f"仓库:{name}"
    row = conn.execute(
        "SELECT uuid, username FROM players WHERE lower(username) = lower(?) ORDER BY last_seen_at DESC LIMIT 1",
        (raw,),
    ).fetchone()
    if row:
        return row["uuid"], row["username"]
    if raw.startswith("name:"):
        return raw, raw[5:]
    if "-" in raw or raw == MOMO_OWNER:
        players = load_players(conn)
        return raw, owner_label(raw, players)
    return f"name:{raw}", raw


def parse_json(value: str) -> object:
    try:
        return json.loads(value or "{}")
    except Exception:
        try:
            return json.loads(re.sub(r":(?=[,}\]])", ":null", value or "{}"))
        except Exception:
            return {}


def walk(value: object):
    yield value
    if isinstance(value, list):
        for item in value:
            yield from walk(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from walk(item)


def component_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        try:
            return component_text(json.loads(value))
        except Exception:
            return value
    if isinstance(value, list):
        return "".join(component_text(item) for item in value)
    if not isinstance(value, dict):
        return str(value)
    if isinstance(value.get("type"), str) and "value" in value:
        return component_text(value.get("value"))
    text = ""
    raw_text = value.get("text")
    if isinstance(raw_text, str):
        text += raw_text
    elif isinstance(raw_text, dict):
        text += component_text(raw_text)
    for key in ("extra", "with"):
        if key in value:
            text += component_text(value.get(key))
    return text


def direct_component_payloads(components: list) -> list[object]:
    payloads: list[object] = []
    for component in components:
        if not isinstance(component, dict):
            continue
        if component.get("type") in {"container", "bundle_contents"}:
            continue
        payloads.append(component)
        if "data" in component:
            payloads.append(component.get("data"))
    return payloads


def components_from_meta(meta_json: str) -> list:
    meta = parse_json(meta_json)
    if isinstance(meta, dict) and isinstance(meta.get("components"), list):
        return meta["components"]
    return []


def custom_name(components: list) -> str:
    for component in components:
        if isinstance(component, dict) and component.get("type") == "custom_name":
            return component_text(component.get("data")).strip()
    return ""


def level_name(level: int) -> str:
    names = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]
    return names[level] if 0 < level < len(names) else str(level)


def enchantment_name(enchantment_id: object) -> str:
    text = str(enchantment_id).replace("minecraft:", "")
    row = None
    if text.isdigit():
        row = ENCHANTMENTS_BY_ID.get(int(text))
    else:
        row = ENCHANTMENTS_BY_NAME.get(text)
    name = str(row.get("name")) if row else text
    if LANG.get(f"enchantment.minecraft.{name}"):
        return LANG[f"enchantment.minecraft.{name}"]
    if row and row.get("displayName"):
        return str(row["displayName"])
    return f"附魔{text}" if text.isdigit() else name


def extract_enchantments(components: list, deep: bool = False) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    roots = [components] if deep else direct_component_payloads(components)
    for root in roots:
      for node in walk(root):
        if not isinstance(node, dict):
            continue
        entries = node.get("enchantments")
        if isinstance(entries, list):
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                ench_id = entry.get("id") or entry.get("name") or entry.get("key")
                level = int(entry.get("level") or entry.get("lvl") or 1)
                label = f"{enchantment_name(ench_id)}{level_name(level)}"
                if label not in seen:
                    seen.add(label)
                    result.append(label)
        levels = node.get("levels")
        if isinstance(levels, dict):
            for ench_id, level in levels.items():
                label = f"{enchantment_name(ench_id)}{level_name(int(level or 1))}"
                if label not in seen:
                    seen.add(label)
                    result.append(label)
    return result


def firework_flight(components: list, deep: bool = False) -> int | None:
    roots = [components] if deep else direct_component_payloads(components)
    for root in roots:
      for node in walk(root):
        if not isinstance(node, dict):
            continue
        raw = node.get("flightDuration") or node.get("flight_duration") or node.get("flight")
        if raw is None:
            continue
        try:
            return max(1, min(3, int(raw)))
        except Exception:
            pass
    return None


def item_details(item_id: str, meta_json: str) -> dict:
    components = components_from_meta(meta_json)
    base_name = base_display_name(item_id)
    name = custom_name(components)
    enchantments = extract_enchantments(components)
    details: list[str] = []
    if item_id == "minecraft:firework_rocket":
        flight = firework_flight(components) or 1
        details.append(f"飞行时间 {flight}")
    if enchantments:
        details.extend(enchantments)
    return {
        "baseName": base_name,
        "customName": name,
        "details": details,
    }


def stack_size(item_id: str) -> int:
    simple = item_simple_id(item_id)
    if simple.endswith("shulker_box"):
        return 1
    if simple in {"ender_pearl", "snowball", "egg", "sign", "hanging_sign"} or simple.endswith("_sign"):
        return 16
    if simple in {"bucket", "water_bucket", "lava_bucket", "milk_bucket", "saddle"}:
        return 1
    if any(token in simple for token in ("sword", "pickaxe", "axe", "shovel", "hoe", "helmet", "chestplate", "leggings", "boots", "elytra", "trident", "bow", "crossbow", "shield")):
        return 1
    return 64


def normalize_item(row: sqlite3.Row) -> dict:
    extra = item_details(row["itemId"], row["metaJson"] or "")
    display_name = row["displayName"] or extra["customName"] or extra["baseName"]
    details = list(extra["details"])
    if row["itemId"] == "minecraft:enchanted_book" and display_name and display_name != extra["baseName"]:
        has_unknown_numeric = any(re.match(r"^附魔\d+", detail) for detail in details)
        if has_unknown_numeric or not details:
            details = [display_name]
    return {
        "itemKey": row["itemKey"],
        "itemId": row["itemId"],
        "shortCode": short_code(row["itemKey"]),
        "displayName": display_name,
        "baseName": extra["baseName"],
        "customName": extra["customName"],
        "amount": int(row["amount"] or 0),
        "details": details,
        "shulkerContents": [],
    }


def load_shulker_contents(conn: sqlite3.Connection, shulker_keys: list[str]) -> dict[str, list[dict]]:
    if not shulker_keys:
        return {}
    placeholders = ",".join("?" for _ in shulker_keys)
    rows = conn.execute(
        f"""
        SELECT sc.shulker_item_key AS shulkerItemKey,
               sc.contained_item_key AS itemKey,
               i.item_id AS itemId,
               i.display_name AS displayName,
               i.meta_json AS metaJson,
               sc.amount AS amount,
               sc.slot_count AS slotCount
        FROM shulker_contents sc
        JOIN items i ON i.item_key = sc.contained_item_key
        WHERE sc.shulker_item_key IN ({placeholders})
        ORDER BY sc.shulker_item_key, i.display_name COLLATE NOCASE ASC
        """,
        shulker_keys,
    ).fetchall()
    by_box: dict[str, list[dict]] = {}
    for row in rows:
        item = normalize_item(row)
        item["slotCount"] = int(row["slotCount"] or 0)
        by_box.setdefault(row["shulkerItemKey"], []).append(item)
    return by_box


def inventory_payload(db_path: Path, raw_owner: str) -> dict:
    refresh_enchantments_if_changed()
    with connect_db(db_path) as conn:
        owner_uuid, label = resolve_owner(conn, raw_owner)
        rows = conn.execute(
            """
            SELECT i.item_key AS itemKey, i.item_id AS itemId, i.display_name AS displayName,
                   i.meta_json AS metaJson, SUM(b.amount) AS amount
            FROM balances b
            JOIN items i ON i.item_key = b.item_key
            WHERE b.owner_uuid = ? AND b.amount > 0
            GROUP BY i.item_key
            ORDER BY i.display_name COLLATE NOCASE ASC
            """,
            (owner_uuid,),
        ).fetchall()
        items = [normalize_item(row) for row in rows]
        shulker_keys = [item["itemKey"] for item in items if item["itemId"].endswith("shulker_box")]
        shulker_contents = load_shulker_contents(conn, shulker_keys)

    total_amount = 0
    used_slots = 0
    shulker_boxes = 0
    for item in items:
        item["shulkerContents"] = shulker_contents.get(item["itemKey"], [])
        total_amount += item["amount"]
        used_slots += (item["amount"] + stack_size(item["itemId"]) - 1) // stack_size(item["itemId"])
        if item["itemId"].endswith("shulker_box"):
            shulker_boxes += item["amount"]

    return {
        "ok": True,
        "ownerUuid": owner_uuid,
        "ownerLabel": label,
        "stats": {
            "totalAmount": total_amount,
            "itemTypes": len(items),
            "usedSlots": used_slots,
            "shulkerBoxes": shulker_boxes,
        },
        "items": items,
    }


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "CloudStoreDashboard/0.2"

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        params = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/api/me":
                self.send_json(self.api_me())
                return
            if path == "/api/inventory":
                self.send_json(self.api_inventory(params))
                return
            if path == "/admin":
                user = self.require_user(require_admin=True)
                self.send_html(self.admin_html())
                return
            if path.startswith("/admin/api/"):
                self.send_json(self.admin_api_get(path, params))
                return
            if path == "/" or path == "/momo" or path.startswith("/u/") or path.startswith("/player/") or path.startswith("/vault/"):
                self.send_html(HTML)
                return
            self.send_error(404, "Not found")
        except PermissionError as error:
            self.send_json({"ok": False, "error": str(error)}, status=403)
        except Exception as error:
            self.send_json({"ok": False, "error": str(error)}, status=500)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path == "/api/login":
                payload = self.read_json_body()
                token = str(payload.get("token") or "").strip()
                result = self.api_login(token)
                result.pop("_setToken", None)
                self.send_json(result, token=token)
                return
            if parsed.path == "/api/logout":
                self.send_json({"ok": True}, clear_token=True)
                return
            if parsed.path.startswith("/admin/api/"):
                self.send_json(self.admin_api_post(parsed.path))
                return
            self.send_error(404, "Not found")
        except PermissionError as error:
            self.send_json({"ok": False, "error": str(error)}, status=403)
        except Exception as error:
            self.send_json({"ok": False, "error": str(error)}, status=400)

    def log_message(self, fmt: str, *args) -> None:
        if getattr(self.server, "quiet", False):
            return
        super().log_message(fmt, *args)

    def send_html(self, html: str) -> None:
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, payload: dict, status: int = 200, token: str | None = None, clear_token: bool = False) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if token is not None:
            self.send_header("Set-Cookie", f"cloud_store_token={urllib.parse.quote(token)}; Path=/; SameSite=Lax; HttpOnly")
        if clear_token:
            self.send_header("Set-Cookie", "cloud_store_token=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or "0")
        data = self.rfile.read(length)
        if not data:
            return {}
        payload = json.loads(data.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return payload

    def cookie_token(self) -> str:
        raw = self.headers.get("Cookie", "")
        if not raw:
            return ""
        cookie = http.cookies.SimpleCookie()
        cookie.load(raw)
        morsel = cookie.get("cloud_store_token")
        return urllib.parse.unquote(morsel.value) if morsel else ""

    def require_user(self, require_admin: bool = False) -> dict:
        token = self.cookie_token()
        with connect_db(self.server.db_path) as conn:
            user = web_user_from_token(conn, token)
            if not user:
                raise PermissionError("请先登录。")
            if require_admin and not user.get("isAdmin"):
                raise PermissionError("你不是管理员。")
            return user

    def api_login(self, token: str) -> dict:
        token = token.strip()
        if not token:
            raise ValueError("登录密钥不能为空。")
        with connect_db(self.server.db_path, query_only=False) as conn:
            user = web_user_from_token(conn, token)
            if not user:
                raise PermissionError("登录密钥无效。请私聊机器人重新获取。")
        return {"ok": True, "user": user, "_setToken": token}

    def api_me(self) -> dict:
        token = self.cookie_token()
        with connect_db(self.server.db_path) as conn:
            user = web_user_from_token(conn, token)
            if not user:
                raise PermissionError("请先登录。")
            return {"ok": True, "user": user, "owners": owner_options_for_user(conn, user)}

    def api_inventory(self, params: dict[str, list[str]]) -> dict:
        raw_owner = params.get("owner", [""])[0]
        token = self.cookie_token()
        with connect_db(self.server.db_path) as conn:
            user = web_user_from_token(conn, token)
            if not user:
                raise PermissionError("请先登录。")
            owner_uuid, _ = resolve_owner(conn, raw_owner or user["ownerUuid"])
            if not can_view_owner(conn, user, owner_uuid):
                raise PermissionError("你没有权限查看这个库存。")
        return inventory_payload(self.server.db_path, owner_uuid)

    def admin_html(self) -> str:
        return ADMIN_VIEWER.HTML.replace('"/api/', '"/admin/api/')

    def arg(self, params: dict[str, list[str]], name: str, default: str = "") -> str:
        return (params.get(name, [default])[0] or "").strip()

    def admin_api_get(self, path: str, params: dict[str, list[str]]) -> dict:
        self.require_user(require_admin=True)
        self.db_path = self.server.db_path
        api_path = path.replace("/admin/api", "/api", 1)
        mapping = {
            "/api/inventory": ADMIN_VIEWER.ViewerHandler.api_inventory,
            "/api/warehouses": ADMIN_VIEWER.ViewerHandler.api_warehouses,
            "/api/warehouse": ADMIN_VIEWER.ViewerHandler.api_warehouse,
            "/api/transactions": ADMIN_VIEWER.ViewerHandler.api_transactions,
            "/api/mismatches": ADMIN_VIEWER.ViewerHandler.api_mismatches,
            "/api/chests": ADMIN_VIEWER.ViewerHandler.api_chests,
            "/api/chest": ADMIN_VIEWER.ViewerHandler.api_chest,
            "/api/name-overrides": ADMIN_VIEWER.ViewerHandler.api_name_overrides,
        }
        if api_path not in mapping:
            raise ValueError("未知管理员接口。")
        return mapping[api_path](self, params)

    def admin_api_post(self, path: str) -> dict:
        self.require_user(require_admin=True)
        self.db_path = self.server.db_path
        payload = self.read_json_body()
        api_path = path.replace("/admin/api", "/api", 1)
        mapping = {
            "/api/manage/adjust": ADMIN_VIEWER.ViewerHandler.api_manage_adjust,
            "/api/manage/transfer": ADMIN_VIEWER.ViewerHandler.api_manage_transfer,
            "/api/manage/rename-item": ADMIN_VIEWER.ViewerHandler.api_manage_rename_item,
            "/api/mismatches/transfer": ADMIN_VIEWER.ViewerHandler.api_mismatch_transfer,
            "/api/mismatches/delete": ADMIN_VIEWER.ViewerHandler.api_mismatch_delete,
            "/api/name-overrides/save": ADMIN_VIEWER.ViewerHandler.api_name_override_save,
            "/api/name-overrides/delete": ADMIN_VIEWER.ViewerHandler.api_name_override_delete,
        }
        if api_path not in mapping:
            raise ValueError("未知管理员接口。")
        return mapping[api_path](self, payload)


class DashboardServer(ThreadingHTTPServer):
    def __init__(self, address, handler, db_path: Path, quiet: bool):
        super().__init__(address, handler)
        self.db_path = db_path
        self.quiet = quiet


def main() -> int:
    parser = argparse.ArgumentParser(description="Cloud Store standalone inventory dashboard")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--no-open", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    db_path = args.db.resolve()
    server = DashboardServer((args.host, args.port), DashboardHandler, db_path, args.quiet)
    url = f"http://{args.host}:{args.port}/"
    print(f"Cloud Store inventory dashboard: {url}")
    print(f"Player endpoint: {url}u/玩家名")
    print(f"Vault endpoint:  {url}vault/仓库名")
    print(f"Database: {db_path}")
    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nDashboard stopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
