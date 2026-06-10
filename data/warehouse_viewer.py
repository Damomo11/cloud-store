#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Local web viewer and ledger editor for cloud-store.sqlite.

Run:
  python data/warehouse_viewer.py

Then open:
  http://127.0.0.1:8765/
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DB = SCRIPT_DIR / "cloud-store.sqlite"
MOMO_OWNER = "__momo__"


HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>云仓库查看器</title>
  <style>
    :root {
      --bg: #f6f7f8;
      --panel: #ffffff;
      --text: #17202a;
      --muted: #65717f;
      --line: #dce2e8;
      --accent: #2563eb;
      --accent-soft: #e7efff;
      --danger: #b42318;
      --ok: #087443;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      background: rgba(255,255,255,.96);
      border-bottom: 1px solid var(--line);
      padding: 12px 18px;
    }
    h1 { margin: 0 0 10px; font-size: 20px; }
    nav { display: flex; gap: 8px; flex-wrap: wrap; }
    button, input, select {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--text);
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit;
    }
    button {
      cursor: pointer;
      min-width: 74px;
    }
    button.active {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    button.secondary { background: var(--accent-soft); color: var(--accent); border-color: #bed3ff; }
    main { max-width: 1380px; margin: 0 auto; padding: 18px; }
    .toolbar {
      display: grid;
      grid-template-columns: repeat(5, minmax(140px, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .toolbar .wide { grid-column: span 2; }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(150px, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .stat {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
    }
    .stat strong { display: block; font-size: 22px; margin-top: 4px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    table { width: 100%; border-collapse: collapse; }
    th, td {
      padding: 9px 10px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      white-space: nowrap;
    }
    th { background: #f0f3f6; color: #334155; font-weight: 650; }
    tr:hover td { background: #fafcff; }
    td.wrap { white-space: normal; min-width: 220px; }
    .muted { color: var(--muted); }
    .key {
      color: var(--muted);
      font-size: 12px;
      max-width: 520px;
      overflow-wrap: anywhere;
      white-space: normal;
    }
    .ok { color: var(--ok); }
    .danger { color: var(--danger); }
    .hidden { display: none; }
    .grid2 {
      display: grid;
      grid-template-columns: minmax(360px, 45%) 1fr;
      gap: 12px;
    }
    .grid3 {
      display: grid;
      grid-template-columns: repeat(3, minmax(260px, 1fr));
      gap: 12px;
    }
    .detail {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      min-height: 320px;
      overflow: hidden;
    }
    .detail h2 { font-size: 16px; margin: 0; padding: 12px; border-bottom: 1px solid var(--line); }
    .items {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 10px;
    }
    .pill {
      background: #eef2f7;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 8px;
      white-space: nowrap;
    }
    .inline-name {
      width: 220px;
      max-width: 28vw;
      padding: 5px 7px;
    }
    .inline-edit {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
    }
    .inline-edit input {
      width: 120px;
      max-width: 16vw;
      padding: 5px 7px;
    }
    .inline-amount {
      width: 92px;
      padding: 5px 7px;
    }
    .msg { padding: 14px; color: var(--muted); }
    .msg:empty { display: none; }
    .ops {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
      min-width: 360px;
    }
    .ops button { height: 30px; padding: 0 8px; }
    .detail-modal {
      position: fixed;
      inset: 0;
      display: none;
      place-items: center;
      background: rgba(15, 23, 42, .45);
      z-index: 20;
      padding: 20px;
    }
    .detail-modal.visible { display: grid; }
    .detail-box {
      width: min(920px, calc(100vw - 40px));
      max-height: calc(100vh - 40px);
      overflow: auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 18px 60px rgba(15, 23, 42, .22);
    }
    .detail-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      padding: 12px;
      border-bottom: 1px solid var(--line);
    }
    .detail-body { padding: 12px; }
    .detail-body pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: #0f172a;
      color: #e5e7eb;
      padding: 10px;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.45;
    }
    @media (max-width: 900px) {
      .toolbar, .stats, .grid2, .grid3 { grid-template-columns: 1fr; }
      .toolbar .wide { grid-column: auto; }
      th, td { white-space: normal; }
    }
  </style>
</head>
<body>
  <header>
    <h1>云仓库查看器</h1>
    <nav>
      <button data-view="inventory" class="active">当前库存</button>
      <button data-view="mismatches">库存异常</button>
      <button data-view="warehouses">自定义仓库</button>
      <button data-view="transactions">存取记录</button>
      <button data-view="chests">木桶位置</button>
      <button data-view="names">物品命名</button>
      <button data-view="manage">库存管理</button>
      <button class="secondary" id="refreshBtn">刷新</button>
    </nav>
  </header>
  <main>
    <section id="inventory" class="view">
      <div class="toolbar">
        <input id="invOwner" placeholder="玩家名 / 仓库名 / 玩家:名字 / 仓库:名字 / momo">
        <input id="invItem" placeholder="物品名 / minecraft:id / itemKey">
        <button id="invSearch">查询</button>
      </div>
      <div class="stats" id="invStats"></div>
      <div id="invResult" class="msg"></div>
      <div class="panel"><table id="invTable"></table></div>
    </section>

    <section id="mismatches" class="view hidden">
      <div class="toolbar">
        <select id="mmKind">
          <option value="">全部类型</option>
          <option value="extra">多余物品</option>
          <option value="missing">缺失物品</option>
        </select>
        <select id="mmStatus">
          <option value="open">未处理</option>
          <option value="">全部状态</option>
          <option value="resolved">已处理</option>
        </select>
        <input id="mmOwner" placeholder="归属 / 玩家 / 仓库 / momo">
        <input id="mmItem" placeholder="物品名 / minecraft:id / 短码 / itemKey">
        <button id="mmSearch">查询</button>
      </div>
      <div class="stats" id="mmStats"></div>
      <div id="mmResult" class="msg"></div>
      <div class="panel"><table id="mmTable"></table></div>
    </section>

    <section id="transactions" class="view hidden">
      <div class="toolbar">
        <input id="txOwner" placeholder="玩家名 / 仓库名 / UUID / 仓库:名字">
        <input id="txItem" placeholder="物品名 / minecraft:id / itemKey">
        <select id="txType">
          <option value="">全部类型</option>
          <option value="deposit_session">存入会话</option>
          <option value="deposit">存入 deposit</option>
          <option value="withdraw">取出 withdraw</option>
          <option value="sync">同步 sync</option>
          <option value="admin_adjust_add">管理员增加</option>
          <option value="admin_adjust_remove">管理员减少</option>
          <option value="viewer_adjust_add">查看器增加</option>
          <option value="viewer_adjust_remove">查看器减少</option>
          <option value="viewer_adjust_set">查看器设置</option>
          <option value="viewer_transfer_out">查看器转出</option>
          <option value="viewer_transfer_in">查看器转入</option>
          <option value="viewer_rename_item">查看器改名</option>
        </select>
        <input id="txDate" type="date" placeholder="日期">
        <input id="txLimit" type="number" min="1" max="1000" value="200" placeholder="数量">
        <button id="txSearch">查询</button>
      </div>
      <div class="panel"><table id="txTable"></table></div>
    </section>

    <section id="warehouses" class="view hidden">
      <div class="toolbar">
        <input id="whName" placeholder="仓库名 / 创建者 / 成员">
        <label class="checkline"><input id="whShowEmpty" type="checkbox"> 显示空仓库</label>
        <button id="whSearch">查询</button>
      </div>
      <div class="grid2">
        <div class="panel"><table id="whTable"></table></div>
        <div class="detail">
          <h2 id="whTitle">选择一个仓库</h2>
          <div id="whDetail" class="msg">左侧点击仓库后查看成员和库存摘要。</div>
        </div>
      </div>
    </section>

    <section id="chests" class="view hidden">
      <div class="toolbar">
        <input id="chestItem" placeholder="筛选含有某物品的木桶，可用 itemKey">
        <input id="chestId" placeholder="木桶坐标，例如 -1,64,2">
        <button id="chestSearch">查询</button>
      </div>
      <div class="grid2">
        <div class="panel"><table id="chestTable"></table></div>
        <div class="detail">
          <h2 id="chestTitle">选择一个木桶</h2>
          <div id="chestDetail" class="msg">左侧点击木桶后查看槽位内容。</div>
        </div>
      </div>
    </section>

    <section id="names" class="view hidden">
      <div class="stats">
        <div class="stat"><span class="muted">人工命名</span><strong style="font-size:15px">6位码 -> 显示名</strong></div>
        <div class="stat"><span class="muted">用途</span><strong style="font-size:15px">附魔书、烟花、特殊NBT命名</strong></div>
        <div class="stat"><span class="muted">持久化</span><strong style="font-size:15px">清空库存不会删除</strong></div>
        <div class="stat"><span class="muted">铁砧改名</span><strong style="font-size:15px">仍按物品 custom_name 区分</strong></div>
      </div>
      <div class="toolbar">
        <input id="nameCode" placeholder="6位码 / itemKey / 当前库存物品名">
        <input id="nameDisplay" placeholder="人工显示名，例如 经验修补一 / 烟花火箭三">
        <input id="nameSearch" placeholder="筛选名称 / 6位码 / itemKey">
        <button id="nameSave" class="secondary">保存命名</button>
        <button id="nameLoad">查询</button>
      </div>
      <div class="panel"><table id="nameTable"></table></div>
    </section>

    <section id="manage" class="view hidden">
      <div class="stats">
        <div class="stat"><span class="muted">说明</span><strong style="font-size:15px">直接修改数据库账本</strong></div>
        <div class="stat"><span class="muted">归属写法</span><strong style="font-size:15px">玩家:名字 / 仓库:名称 / momo</strong></div>
        <div class="stat"><span class="muted">物品写法</span><strong style="font-size:15px">石头 / minecraft:stone / itemKey</strong></div>
        <div class="stat"><span class="muted">注意</span><strong style="font-size:15px">不会移动实体物品或修改游戏 NBT</strong></div>
      </div>
      <div class="grid3">
        <div class="panel" style="padding:12px">
          <h2 style="margin:0 0 10px;font-size:16px">增删改库存</h2>
          <div class="toolbar" style="grid-template-columns:1fr 1fr">
            <input id="mgOwner" placeholder="归属，例如 玩家:PlayerName / momo / 仓库:仓库名1">
            <input id="mgItem" placeholder="物品，例如 石头 / 经验修补一 / itemKey">
            <input id="mgAmount" type="number" min="0" placeholder="数量">
            <select id="mgAction">
              <option value="add">增加</option>
              <option value="subtract">减少</option>
              <option value="set">设置为</option>
            </select>
          </div>
          <button id="mgApply" class="secondary">执行修改</button>
        </div>
        <div class="panel" style="padding:12px">
          <h2 style="margin:0 0 10px;font-size:16px">更改主人</h2>
          <div class="toolbar" style="grid-template-columns:1fr 1fr">
            <input id="trFrom" placeholder="原主人，例如 玩家:PlayerName">
            <input id="trTo" placeholder="新主人，例如 仓库:仓库名1">
            <input id="trItem" placeholder="物品，留空表示全部；可用 itemKey">
            <input id="trAmount" type="number" min="0" placeholder="数量，留空表示全部">
          </div>
          <button id="trApply" class="secondary">执行转移</button>
        </div>
        <div class="panel" style="padding:12px">
          <h2 style="margin:0 0 10px;font-size:16px">修改物品名</h2>
          <div class="toolbar" style="grid-template-columns:1fr 1fr">
            <input id="rnItem" placeholder="短码 / itemKey / 当前物品名">
            <input id="rnName" placeholder="新显示名，例如 风爆三">
          </div>
          <button id="rnApply" class="secondary">保存名称</button>
        </div>
      </div>
      <div id="manageResult" class="msg"></div>
    </section>
  </main>
  <div id="itemDetailModal" class="detail-modal">
    <div class="detail-box">
      <div class="detail-head">
        <strong id="itemDetailTitle">物品详情</strong>
        <button id="itemDetailClose">关闭</button>
      </div>
      <div class="detail-body" id="itemDetailBody"></div>
    </div>
  </div>

  <script>
    const state = { view: "inventory", selectedChest: "", selectedWarehouse: "", inventoryByKey: {}, mismatchById: {} };

    function qs(id) { return document.getElementById(id); }
    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      }[ch]));
    }
    function n(value) { return Number(value || 0).toLocaleString("zh-CN"); }
    function api(path, params = {}) {
      const url = new URL(path, location.origin);
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && String(v).trim() !== "") url.searchParams.set(k, v);
      });
      return fetch(url).then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
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
        if (!res.ok) throw new Error(data.error || res.statusText);
        return data;
      });
    }
    function renderTable(id, headers, rows, empty = "没有数据") {
      const table = qs(id);
      if (!rows.length) {
        table.innerHTML = `<tbody><tr><td class="msg">${esc(empty)}</td></tr></tbody>`;
        return;
      }
      table.innerHTML = `<thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody>`;
    }
    function showError(id, error) {
      qs(id).innerHTML = `<tbody><tr><td class="msg danger">${esc(error.message || error)}</td></tr></tbody>`;
    }
    function showInventoryResult(message, ok = true) {
      const result = qs("invResult");
      result.className = ok ? "msg ok" : "msg danger";
      result.textContent = message || "";
    }
    function showMismatchResult(message, ok = true) {
      const result = qs("mmResult");
      result.className = ok ? "msg ok" : "msg danger";
      result.textContent = message || "";
    }
    function prettyJsonText(value) {
      const text = String(value ?? "").trim();
      if (!text) return "";
      try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
    }
    function showItemDetail(itemKey) {
      const item = state.inventoryByKey[itemKey];
      if (!item) return;
      qs("itemDetailTitle").textContent = `${item.displayName} x${n(item.amount)}`;
      qs("itemDetailBody").innerHTML = `
        <div><strong>归属</strong>：${esc(item.ownerLabel)}</div>
        <div><strong>短码</strong>：${esc(item.shortCode || "")}</div>
        <div><strong>ID</strong>：${esc(item.itemId)}</div>
        <div><strong>itemKey</strong></div>
        <pre>${esc(item.itemKey)}</pre>
        <div><strong>NBT</strong></div>
        <pre>${esc(prettyJsonText(item.nbtJson) || "无")}</pre>
        <div><strong>Meta / Components</strong></div>
        <pre>${esc(prettyJsonText(item.metaJson) || "无")}</pre>
      `;
      qs("itemDetailModal").classList.add("visible");
    }
    function closeItemDetail() {
      qs("itemDetailModal").classList.remove("visible");
    }

    async function loadInventory() {
      const params = { owner: qs("invOwner").value, item: qs("invItem").value };
      try {
        showInventoryResult("");
        const data = await api("/api/inventory", params);
        qs("invStats").innerHTML = `
          <div class="stat"><span class="muted">总物品数</span><strong>${n(data.stats.totalAmount)}</strong></div>
          <div class="stat"><span class="muted">物品种类</span><strong>${n(data.stats.itemTypes)}</strong></div>
          <div class="stat"><span class="muted">归属数量</span><strong>${n(data.stats.owners)}</strong></div>
          <div class="stat"><span class="muted">筛选行数</span><strong>${n(data.rows.length)}</strong></div>
        `;
        renderTable("invTable", ["归属", "短码", "物品", "ID", "数量", "操作"], data.rows.map(row => `
          <tr>
            <td>${esc(row.ownerLabel)}</td>
            <td>${esc(row.shortCode)}</td>
            <td>${esc(row.displayName)}</td>
            <td>${esc(row.itemId)}</td>
            <td>${n(row.amount)}</td>
            <td>
              <div class="ops">
                <button class="secondary" data-item-detail="${esc(row.itemKey)}">详情</button>
                <input data-owner-target placeholder="新归属">
                <button class="secondary" data-owner-set data-owner="${esc(row.ownerUuid)}" data-item="${esc(row.itemKey)}" data-amount="${esc(row.amount)}">改归属</button>
                <input class="inline-amount" data-amount-input type="number" min="0" step="1" value="${esc(row.amount)}">
                <button class="secondary" data-amount-set data-owner="${esc(row.ownerUuid)}" data-item="${esc(row.itemKey)}" data-current="${esc(row.amount)}">设数量</button>
              </div>
            </td>
          </tr>
        `));
        state.inventoryByKey = Object.fromEntries(data.rows.map(row => [row.itemKey, row]));
        document.querySelectorAll("[data-item-detail]").forEach(el => {
          el.addEventListener("click", () => showItemDetail(el.getAttribute("data-item-detail")));
        });
        document.querySelectorAll("[data-owner-set]").forEach(el => {
          el.addEventListener("click", () => transferInventoryOwner(el));
        });
        document.querySelectorAll("[data-amount-set]").forEach(el => {
          el.addEventListener("click", () => setInventoryAmount(el));
        });
      } catch (error) { showError("invTable", error); }
    }

    function mismatchKindName(kind) {
      return kind === "extra" ? "多余" : kind === "missing" ? "缺失" : kind;
    }
    function mismatchStatusName(status) {
      return status === "open" ? "未处理" : status === "resolved" ? "已处理" : status;
    }
    async function loadMismatches() {
      const params = { kind: qs("mmKind").value, status: qs("mmStatus").value, owner: qs("mmOwner").value, item: qs("mmItem").value };
      try {
        showMismatchResult("");
        const data = await api("/api/mismatches", params);
        qs("mmStats").innerHTML = `
          <div class="stat"><span class="muted">未处理异常</span><strong>${n(data.stats.openRows)}</strong></div>
          <div class="stat"><span class="muted">多余物品</span><strong>${n(data.stats.extraAmount)}</strong></div>
          <div class="stat"><span class="muted">缺失物品</span><strong>${n(data.stats.missingAmount)}</strong></div>
          <div class="stat"><span class="muted">筛选行数</span><strong>${n(data.rows.length)}</strong></div>
        `;
        renderTable("mmTable", ["时间", "类型", "归属", "短码", "物品", "数量", "说明", "操作"], data.rows.map(row => `
          <tr>
            <td>${esc(row.createdAt)}${row.resolvedAt ? `<div class="muted">处理：${esc(row.resolvedAt)}</div>` : ""}</td>
            <td>${esc(mismatchKindName(row.kind))}<div class="muted">${esc(mismatchStatusName(row.status))}</div></td>
            <td>${esc(row.ownerLabel || row.username || "")}</td>
            <td>${esc(row.shortCode)}</td>
            <td>${esc(row.displayName)}<div class="muted">${esc(row.itemId)}</div></td>
            <td>${n(row.amount)}</td>
            <td class="wrap muted">${esc(row.note || "")}</td>
            <td>
              <div class="ops">
                ${row.kind === "extra" && row.status === "open" ? `<input data-mm-target placeholder="转移到：玩家名 / 仓库:名"><button class="secondary" data-mm-transfer="${esc(row.id)}">转移</button>` : ""}
                ${row.status === "open" ? `<button data-mm-delete="${esc(row.id)}">删除记录</button>` : ""}
              </div>
            </td>
          </tr>
        `), "没有库存异常记录。");
        state.mismatchById = Object.fromEntries(data.rows.map(row => [String(row.id), row]));
        document.querySelectorAll("[data-mm-transfer]").forEach(el => {
          el.addEventListener("click", () => transferMismatch(el));
        });
        document.querySelectorAll("[data-mm-delete]").forEach(el => {
          el.addEventListener("click", () => deleteMismatch(el.getAttribute("data-mm-delete")));
        });
      } catch (error) { showError("mmTable", error); }
    }

    async function transferMismatch(button) {
      const id = button.getAttribute("data-mm-transfer");
      const row = state.mismatchById[id];
      const input = button.closest("td").querySelector("[data-mm-target]");
      const toOwner = input ? input.value.trim() : "";
      if (!row || !toOwner) {
        showMismatchResult("请填写要转移到的归属。", false);
        return;
      }
      if (!confirm(`把 momo 中的 ${row.displayName} x${row.amount} 转移到 ${toOwner}，并处理这条异常？`)) return;
      try {
        const data = await apiPost("/api/mismatches/transfer", { id, toOwner });
        showMismatchResult(data.message || "已转移");
        loadMismatches();
        loadInventory();
      } catch (error) {
        showMismatchResult(error.message || String(error), false);
      }
    }

    async function deleteMismatch(id) {
      if (!id || !confirm("删除这条异常记录？这只删除提示记录，不修改库存账本。")) return;
      try {
        const data = await apiPost("/api/mismatches/delete", { id });
        showMismatchResult(data.message || "已删除");
        loadMismatches();
      } catch (error) {
        showMismatchResult(error.message || String(error), false);
      }
    }

    function txTypeName(type) {
      const map = {
        deposit_session: "存入会话",
        deposit: "存入",
        withdraw: "取出",
        sync: "同步",
        admin_adjust_add: "管理员增加",
        admin_adjust_remove: "管理员减少",
        viewer_adjust_add: "查看器增加",
        viewer_adjust_remove: "查看器减少",
        viewer_adjust_set: "查看器设置",
        viewer_transfer_out: "查看器转出",
        viewer_transfer_in: "查看器转入",
        viewer_rename_item: "查看器改名",
        viewer_name_override: "人工命名",
        viewer_name_override_delete: "删除命名"
      };
      return map[type] || type;
    }
    function txStatusName(status) {
      const map = {
        ok: "成功",
        partial: "部分成功",
        teleport_timeout: "传送超时",
        cancelled: "任务取消",
        empty: "未收到物品",
        no_space: "仓库已满",
        quota_full: "额度已满",
        error: "异常",
      };
      return map[status] || status;
    }
    async function loadTransactions() {
      const params = { owner: qs("txOwner").value, item: qs("txItem").value, type: qs("txType").value, date: qs("txDate").value, limit: qs("txLimit").value };
      try {
        const data = await api("/api/transactions", params);
        renderTable("txTable", ["时间", "类型", "归属", "数量", "物品", "备注"], data.rows.map(row => `
          <tr>
            <td>${esc(row.createdAt)}</td>
            <td>${esc(txTypeName(row.type))}<div class="muted">${esc(txStatusName(row.status))}</div></td>
            <td>${esc(row.ownerLabel)}<div class="muted">${esc(row.playerUuid)}</div></td>
            <td>${n(row.totalAmount)}</td>
            <td class="wrap">${row.items.length ? row.items.map(item => `<span class="pill" title="${esc(item.itemKey || item.itemId)}">${esc(item.displayName || item.itemId || "未知物品")} x${n(item.amount)}</span>`).join(" ") : `<span class="muted">无物品变更</span>`}</td>
            <td class="wrap muted">${esc(row.message)}</td>
          </tr>
        `));
      } catch (error) { showError("txTable", error); }
    }

    async function loadWarehouses() {
      const params = { q: qs("whName").value, showEmpty: qs("whShowEmpty").checked ? "1" : "" };
      try {
        const data = await api("/api/warehouses", params);
        renderTable("whTable", ["仓库", "创建者", "成员", "库存"], data.rows.map(row => `
          <tr>
            <td><button class="secondary" data-warehouse="${esc(row.name)}">${esc(row.name)}</button><div class="muted">${esc(row.ownerUuid)}</div></td>
            <td>${esc(row.creatorUsername)}</td>
            <td>${n(row.memberCount)}</td>
            <td>${n(row.totalAmount)}</td>
          </tr>
        `), "没有自定义仓库。");
        document.querySelectorAll("[data-warehouse]").forEach(el => {
          el.addEventListener("click", () => loadWarehouseDetail(el.getAttribute("data-warehouse")));
        });
      } catch (error) { showError("whTable", error); }
    }

    async function loadWarehouseDetail(name) {
      if (!name) return;
      state.selectedWarehouse = name;
      qs("whTitle").textContent = `仓库 ${name}`;
      qs("whDetail").innerHTML = "读取中...";
      try {
        const data = await api("/api/warehouse", { name });
        qs("whDetail").innerHTML = `
          <div class="items">
            ${data.members.map(member => `<span class="pill">${esc(member.username)}${member.role === "admin" ? "(管理员)" : ""}</span>`).join("")}
          </div>
          <table>
            <thead><tr><th>短码</th><th>物品</th><th>ID</th><th>数量</th></tr></thead>
            <tbody>${data.items.length ? data.items.map(item => `
              <tr><td>${esc(item.shortCode)}</td><td>${esc(item.displayName)}</td><td><div class="muted">${esc(item.itemId)}</div><div class="key">${esc(item.itemKey)}</div></td><td>${n(item.amount)}</td></tr>
            `).join("") : `<tr><td class="msg" colspan="4">这个仓库当前没有库存。</td></tr>`}</tbody>
          </table>
        `;
      } catch (error) {
        qs("whDetail").innerHTML = `<div class="msg danger">${esc(error.message || error)}</div>`;
      }
    }

    async function loadChests() {
      const params = { item: qs("chestItem").value, chest: qs("chestId").value };
      try {
        const data = await api("/api/chests", params);
        renderTable("chestTable", ["坐标", "槽位", "物品数", "最后同步"], data.rows.map(row => `
          <tr data-chest="${esc(row.chestId)}" class="chest-row">
            <td><button class="secondary" data-chest="${esc(row.chestId)}">${esc(row.chestId)}</button></td>
            <td>${n(row.slotCount)}</td>
            <td>${n(row.totalAmount)}</td>
            <td class="muted">${esc(row.lastSeenAt)}</td>
          </tr>
        `), "没有木桶数据。请先用机器人执行 !同步 半径");
        document.querySelectorAll("[data-chest]").forEach(el => {
          el.addEventListener("click", () => loadChestDetail(el.getAttribute("data-chest")));
        });
      } catch (error) { showError("chestTable", error); }
    }

    async function applyManage() {
      const result = qs("manageResult");
      result.className = "msg";
      result.textContent = "执行中...";
      try {
        const data = await apiPost("/api/manage/adjust", {
          owner: qs("mgOwner").value,
          item: qs("mgItem").value,
          amount: qs("mgAmount").value,
          action: qs("mgAction").value
        });
        result.className = "msg ok";
        result.textContent = data.message;
        loadInventory();
      } catch (error) {
        result.className = "msg danger";
        result.textContent = error.message || String(error);
      }
    }

    async function applyTransfer() {
      const result = qs("manageResult");
      result.className = "msg";
      result.textContent = "执行中...";
      try {
        const data = await apiPost("/api/manage/transfer", {
          fromOwner: qs("trFrom").value,
          toOwner: qs("trTo").value,
          item: qs("trItem").value,
          amount: qs("trAmount").value
        });
        result.className = "msg ok";
        result.textContent = data.message;
        loadInventory();
      } catch (error) {
        result.className = "msg danger";
        result.textContent = error.message || String(error);
      }
    }
    async function applyRenameItem() {
      const result = qs("manageResult");
      result.className = "msg";
      result.textContent = "执行中...";
      try {
        const data = await apiPost("/api/manage/rename-item", {
          item: qs("rnItem").value,
          displayName: qs("rnName").value
        });
        result.className = "msg ok";
        result.textContent = data.message;
        loadInventory();
        if (state.selectedWarehouse) loadWarehouseDetail(state.selectedWarehouse);
        if (state.selectedChest) loadChestDetail(state.selectedChest);
      } catch (error) {
        result.className = "msg danger";
        result.textContent = error.message || String(error);
      }
    }
    async function setInventoryAmount(button) {
      const input = button.closest("td").querySelector("[data-amount-input]");
      const amount = input ? input.value.trim() : "";
      if (!/^\d+$/.test(amount)) {
        showInventoryResult("数量必须是大于等于 0 的整数", false);
        return;
      }
      const current = button.getAttribute("data-current") || "0";
      if (amount === current) {
        showInventoryResult("数量没有变化。");
        return;
      }
      if (!confirm(`把这一行库存从 ${current} 设置为 ${amount}？`)) {
        return;
      }
      try {
        const data = await apiPost("/api/manage/adjust", {
          owner: button.getAttribute("data-owner"),
          item: button.getAttribute("data-item"),
          amount,
          action: "set"
        });
        showInventoryResult(data.message || "已设置数量");
        loadInventory();
      } catch (error) {
        showInventoryResult(error.message || String(error), false);
      }
    }

    async function transferInventoryOwner(button) {
      const input = button.closest("td").querySelector("[data-owner-target]");
      const toOwner = input ? input.value.trim() : "";
      if (!toOwner) {
        showInventoryResult("请填写新归属", false);
        return;
      }
      const amount = button.getAttribute("data-amount") || "";
      if (!confirm(`把这一行 ${amount} 个物品转移到 ${toOwner}？`)) {
        return;
      }
      try {
        const data = await apiPost("/api/manage/transfer", {
          fromOwner: button.getAttribute("data-owner"),
          toOwner,
          item: button.getAttribute("data-item"),
          amount
        });
        showInventoryResult(data.message || "已修改归属");
        loadInventory();
      } catch (error) {
        showInventoryResult(error.message || String(error), false);
      }
    }
    async function loadChestDetail(chestId) {
      if (!chestId) return;
      state.selectedChest = chestId;
      qs("chestTitle").textContent = `木桶 ${chestId}`;
      qs("chestDetail").innerHTML = "读取中...";
      try {
        const data = await api("/api/chest", { chest: chestId });
        if (!data.items.length) {
          qs("chestDetail").innerHTML = `<div class="msg">这个木桶当前没有记录到物品。</div>`;
          return;
        }
        qs("chestDetail").innerHTML = `<table><thead><tr><th>槽位</th><th>短码</th><th>物品</th><th>ID / itemKey</th><th>数量</th></tr></thead><tbody>${data.items.map(item => `
          <tr>
            <td>${n(item.slot)}</td>
            <td>${esc(item.shortCode)}</td>
            <td>${esc(item.displayName)}</td>
            <td><div class="muted">${esc(item.itemId)}</div><div class="key">${esc(item.itemKey)}</div></td>
            <td>${n(item.amount)}</td>
          </tr>
        `).join("")}</tbody></table>`;
      } catch (error) {
        qs("chestDetail").innerHTML = `<div class="msg danger">${esc(error.message || error)}</div>`;
      }
    }

    async function loadNameOverrides() {
      try {
        const data = await api("/api/name-overrides", { q: qs("nameSearch").value });
        renderTable("nameTable", ["6位码", "人工显示名", "绑定物品", "更新时间", "操作"], data.rows.map(row => `
          <tr>
            <td>${esc(row.shortCode)}</td>
            <td><input class="inline-name" data-name-input="${esc(row.shortCode)}" value="${esc(row.displayName)}"></td>
            <td><div class="muted">${esc(row.itemId || "")}</div><div class="key">${esc(row.itemKey || "")}</div></td>
            <td>${esc(row.updatedAt || "")}</td>
            <td>
              <button class="secondary" data-name-save="${esc(row.shortCode)}">保存</button>
              <button data-name-delete="${esc(row.shortCode)}">删除</button>
            </td>
          </tr>
        `), "还没有人工命名规则。");
        document.querySelectorAll("[data-name-save]").forEach(el => {
          el.addEventListener("click", () => saveNameOverride(el.getAttribute("data-name-save")));
        });
        document.querySelectorAll("[data-name-delete]").forEach(el => {
          el.addEventListener("click", () => deleteNameOverride(el.getAttribute("data-name-delete")));
        });
      } catch (error) { showError("nameTable", error); }
    }

    async function saveNameOverride(existingCode = "") {
      const codeOrItem = existingCode || qs("nameCode").value.trim();
      const input = existingCode ? document.querySelector(`[data-name-input="${CSS.escape(existingCode)}"]`) : qs("nameDisplay");
      const displayName = input ? input.value.trim() : "";
      if (!codeOrItem || !displayName) {
        alert("请填写 6位码/itemKey 和人工显示名");
        return;
      }
      try {
        const data = await apiPost("/api/name-overrides/save", { item: codeOrItem, displayName });
        qs("nameCode").value = "";
        qs("nameDisplay").value = "";
        loadNameOverrides();
        loadInventory();
        if (state.selectedWarehouse) loadWarehouseDetail(state.selectedWarehouse);
        if (state.selectedChest) loadChestDetail(state.selectedChest);
        alert(data.message || "已保存");
      } catch (error) {
        alert(error.message || error);
      }
    }

    async function deleteNameOverride(shortCode) {
      if (!shortCode || !confirm(`删除 ${shortCode} 的人工命名规则？`)) return;
      try {
        await apiPost("/api/name-overrides/delete", { shortCode });
        loadNameOverrides();
      } catch (error) {
        alert(error.message || error);
      }
    }

    function setView(view) {
      state.view = view;
      document.querySelectorAll(".view").forEach(el => el.classList.toggle("hidden", el.id !== view));
      document.querySelectorAll("nav button[data-view]").forEach(el => el.classList.toggle("active", el.dataset.view === view));
      refresh();
    }
    function refresh() {
      if (state.view === "inventory") loadInventory();
      if (state.view === "mismatches") loadMismatches();
      if (state.view === "warehouses") {
        loadWarehouses();
        if (state.selectedWarehouse) loadWarehouseDetail(state.selectedWarehouse);
      }
      if (state.view === "transactions") loadTransactions();
      if (state.view === "chests") {
        loadChests();
        if (state.selectedChest) loadChestDetail(state.selectedChest);
      }
      if (state.view === "names") loadNameOverrides();
    }
    document.querySelectorAll("nav button[data-view]").forEach(btn => btn.addEventListener("click", () => setView(btn.dataset.view)));
    qs("refreshBtn").addEventListener("click", refresh);
    qs("itemDetailClose").addEventListener("click", closeItemDetail);
    qs("itemDetailModal").addEventListener("click", event => {
      if (event.target === qs("itemDetailModal")) closeItemDetail();
    });
    qs("invSearch").addEventListener("click", loadInventory);
    qs("mmSearch").addEventListener("click", loadMismatches);
    qs("txSearch").addEventListener("click", loadTransactions);
    qs("whSearch").addEventListener("click", loadWarehouses);
    qs("whShowEmpty").addEventListener("change", loadWarehouses);
    qs("chestSearch").addEventListener("click", loadChests);
    qs("nameLoad").addEventListener("click", loadNameOverrides);
    qs("nameSave").addEventListener("click", () => saveNameOverride());
    qs("mgApply").addEventListener("click", applyManage);
    qs("trApply").addEventListener("click", applyTransfer);
    qs("rnApply").addEventListener("click", applyRenameItem);
    document.querySelectorAll("input, select").forEach(el => el.addEventListener("keydown", ev => {
      if (ev.key === "Enter") refresh();
    }));
    loadInventory();
  </script>
</body>
</html>
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Open a local web viewer for cloud-store.sqlite.")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="SQLite database path")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    parser.add_argument("--port", default=8765, type=int, help="Bind port")
    parser.add_argument("--no-browser", action="store_true", help="Do not open browser automatically")
    return parser.parse_args()


def connect_db(db_path: Path, query_only: bool = True) -> sqlite3.Connection:
    if not db_path.exists():
      raise FileNotFoundError(f"找不到数据库文件：{db_path}")
    conn = sqlite3.connect(str(db_path), timeout=5)
    conn.row_factory = sqlite3.Row
    if not query_only:
        ensure_viewer_schema(conn)
    if query_only:
        conn.execute("PRAGMA query_only = ON")
    return conn


def ensure_viewer_schema(conn: sqlite3.Connection) -> None:
    columns = [row["name"] for row in conn.execute("PRAGMA table_info(items)").fetchall()]
    if "display_name_manual" not in columns:
        conn.execute("ALTER TABLE items ADD COLUMN display_name_manual INTEGER NOT NULL DEFAULT 0")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS item_name_overrides (
          short_code TEXT PRIMARY KEY,
          item_key TEXT,
          item_id TEXT,
          display_name TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS inventory_mismatches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          owner_uuid TEXT NOT NULL DEFAULT '',
          username TEXT NOT NULL DEFAULT '',
          item_key TEXT NOT NULL,
          item_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          nbt_json TEXT NOT NULL DEFAULT '',
          meta_json TEXT NOT NULL DEFAULT '',
          amount INTEGER NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          resolved_at TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_inventory_mismatches_status ON inventory_mismatches(status, kind, created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_inventory_mismatches_item_key ON inventory_mismatches(item_key)")


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


def text_matches(value: object, needle: str) -> bool:
    if not needle:
        return True
    return needle.lower() in str(value or "").lower()


def item_matches(item: dict, needle: str) -> bool:
    if not needle:
        return True
    return (
        text_matches(clean_display_name(item.get("displayName")), needle)
        or text_matches(item.get("itemId"), needle)
        or text_matches(item.get("itemKey"), needle)
        or text_matches(item.get("shortCode"), needle)
    )


def parse_items_json(value: str) -> list[dict]:
    try:
        items = json.loads(value or "[]")
        return items if isinstance(items, list) else []
    except json.JSONDecodeError:
        return []


def stable_stringify(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(stable_stringify(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False, separators=(",", ":")) + ":" + stable_stringify(value[key])
            for key in sorted(value)
        ) + "}"
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def load_config() -> dict:
    path = SCRIPT_DIR.parent / "config.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def load_language() -> dict:
    path = SCRIPT_DIR / "zh_cn.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


CONFIG = load_config()
LANG = load_language()


def normalize_item_id(value: str) -> str:
    text = (value or "").strip()
    if not text:
        raise ValueError("物品不能为空")
    if text.startswith("minecraft:"):
        return text
    return f"minecraft:{text}"


def item_id_from_language(name: str) -> str | None:
    raw = (name or "").strip()
    if not raw:
        return None
    lower = raw.lower()

    aliases = CONFIG.get("aliases") or {}
    for alias, item_id in aliases.items():
        if alias.lower() == lower:
            return normalize_item_id(str(item_id))

    if raw.startswith("minecraft:"):
        return raw

    for key, value in LANG.items():
        if str(value).lower() != lower:
            continue
        if key.startswith("block.minecraft."):
            return "minecraft:" + key[len("block.minecraft."):]
        if key.startswith("item.minecraft."):
            return "minecraft:" + key[len("item.minecraft."):]

    if all(ch.isascii() and (ch.isalnum() or ch == "_") for ch in raw):
        return normalize_item_id(raw)
    return None


def display_name_for_item_id(item_id: str) -> str:
    simple = normalize_item_id(item_id).replace("minecraft:", "", 1)
    return LANG.get(f"block.minecraft.{simple}") or LANG.get(f"item.minecraft.{simple}") or simple


def short_code_for_item_key(item_key: object) -> str:
    text = str(item_key or "")
    if "|" not in text:
        return ""
    return text.split("|", 1)[1][:6].lower()


def get_name_override(conn: sqlite3.Connection, item_key: str) -> sqlite3.Row | None:
    code = short_code_for_item_key(item_key)
    if not code:
        return None
    try:
        return conn.execute(
            """
            SELECT short_code AS shortCode, item_key AS itemKey, item_id AS itemId, display_name AS displayName
            FROM item_name_overrides
            WHERE short_code = ?
            LIMIT 1
            """,
            (code,),
        ).fetchone()
    except sqlite3.OperationalError:
        return None


def save_name_override(conn: sqlite3.Connection, short_code: str, display_name: str, item_key: str = "", item_id: str = "") -> None:
    ensure_viewer_schema(conn)
    conn.execute(
        """
        INSERT INTO item_name_overrides (short_code, item_key, item_id, display_name, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(short_code) DO UPDATE SET
          item_key = COALESCE(NULLIF(excluded.item_key, ''), item_name_overrides.item_key),
          item_id = COALESCE(NULLIF(excluded.item_id, ''), item_name_overrides.item_id),
          display_name = excluded.display_name,
          updated_at = CURRENT_TIMESTAMP
        """,
        (short_code, item_key or None, item_id or None, display_name),
    )
    conn.execute(
        """
        UPDATE items
        SET display_name = ?, display_name_manual = 1
        WHERE lower(substr(item_key, instr(item_key, '|') + 1, 6)) = lower(?)
        """,
        (display_name, short_code),
    )


def clean_display_name(display_name: object) -> str:
    text = str(display_name or "").strip()
    for prefix in ("附魔书：", "附魔书:"):
        if text.startswith(prefix):
            return text[len(prefix):].strip() or text
    return text


def base_item_for_item_id(item_id: str) -> dict:
    normalized = normalize_item_id(item_id)
    nbt_json = "null"
    meta_json = stable_stringify({"metadata": None, "components": None})
    fingerprint = hashlib.sha1(
        stable_stringify({"itemId": normalized, "nbtJson": nbt_json, "metaJson": meta_json}).encode("utf-8")
    ).hexdigest()
    return {
        "itemKey": f"{normalized}|{fingerprint}",
        "itemId": normalized,
        "displayName": display_name_for_item_id(normalized),
        "nbtJson": nbt_json,
        "metaJson": meta_json,
        "amount": 0,
    }


def item_ref_from_row(row: sqlite3.Row, exact: bool = True) -> dict:
    data = dict(row)
    data["displayName"] = clean_display_name(data.get("displayName"))
    data["exact"] = exact
    return data


def resolve_item_ref(conn: sqlite3.Connection, item_text: str) -> dict:
    raw = (item_text or "").strip()
    if not raw:
        raise ValueError("物品不能为空")
    lower = raw.lower()

    row = conn.execute(
        """
        SELECT item_key AS itemKey, item_id AS itemId, display_name AS displayName,
               nbt_json AS nbtJson, meta_json AS metaJson
        FROM items
        WHERE item_key = ?
        LIMIT 1
        """,
        (raw,),
    ).fetchone()
    if row:
        return item_ref_from_row(row)

    code = raw[1:] if raw.startswith("#") else raw
    if len(code) == 6 and all(ch in "0123456789abcdefABCDEF" for ch in code):
        rows = conn.execute(
            """
            SELECT item_key AS itemKey, item_id AS itemId, display_name AS displayName,
                   nbt_json AS nbtJson, meta_json AS metaJson
            FROM items
            WHERE lower(substr(item_key, instr(item_key, '|') + 1, 6)) = lower(?)
            ORDER BY created_at
            LIMIT 2
            """,
            (code,),
        ).fetchall()
        if len(rows) == 1:
            return item_ref_from_row(rows[0])
        if len(rows) > 1:
            raise ValueError(f"短码 {code} 匹配到多个物品，请用 itemKey 精确指定。")

    all_rows = conn.execute(
        """
        SELECT item_key AS itemKey, item_id AS itemId, display_name AS displayName,
               nbt_json AS nbtJson, meta_json AS metaJson
        FROM items
        ORDER BY created_at
        """
    ).fetchall()

    exact_rows = [row for row in all_rows if str(row["displayName"] or "").lower() == lower]
    if len(exact_rows) == 1:
        return item_ref_from_row(exact_rows[0])
    if len(exact_rows) > 1:
        raise ValueError(f"物品名 {raw} 匹配到多个 NBT 变体，请用 itemKey 精确指定。")

    clean_exact_rows = [row for row in all_rows if clean_display_name(row["displayName"]).lower() == lower]
    if len(clean_exact_rows) == 1:
        return item_ref_from_row(clean_exact_rows[0])
    if len(clean_exact_rows) > 1:
        raise ValueError(f"物品名 {raw} 匹配到多个 NBT 变体，请用 itemKey 精确指定。")

    item_row = conn.execute(
        """
        SELECT item_id AS itemId, display_name AS displayName
        FROM items
        WHERE lower(item_id) = lower(?)
        ORDER BY created_at
        LIMIT 1
        """,
        (raw,),
    ).fetchone()
    if item_row:
        return {"itemId": item_row["itemId"], "displayName": display_name_for_item_id(item_row["itemId"]), "exact": False}

    item_id = item_id_from_language(raw)
    if item_id:
        return {"itemId": item_id, "displayName": display_name_for_item_id(item_id), "exact": False}

    fuzzy_rows = [
        row for row in all_rows
        if lower in clean_display_name(row["displayName"]).lower()
           or lower in str(row["displayName"] or "").lower()
    ][:6]
    if len(fuzzy_rows) == 1:
        return item_ref_from_row(fuzzy_rows[0])
    if len(fuzzy_rows) > 1:
        names = "，".join(clean_display_name(row["displayName"]) for row in fuzzy_rows[:5])
        raise ValueError(f"物品名 {raw} 不够精确，匹配到：{names}")

    raise ValueError(f"未知物品：{raw}")


def resolve_owner(conn: sqlite3.Connection, owner_text: str) -> tuple[str, str]:
    raw = (owner_text or "").strip()
    if not raw:
        raise ValueError("归属不能为空")
    lower = raw.lower()
    if lower in ("momo", MOMO_OWNER.lower()):
        return MOMO_OWNER, "momo"
    if raw.startswith("玩家:"):
        player = raw[3:].strip()
        if not player:
            raise ValueError("玩家名不能为空")
        row = find_player(conn, player)
        if row:
            return row["uuid"], row["username"]
        return f"name:{player}", player
    if raw.startswith("仓库:"):
        vault = raw[3:].strip()
        if not vault:
            raise ValueError("仓库名不能为空")
        row = find_vault(conn, vault)
        if row:
            return f"vault:{row['nameLower']}", f"仓库:{row['name']}"
        return f"vault:{vault.lower()}", f"仓库:{vault}"
    if lower.startswith("vault:"):
        vault = raw[6:].strip()
        if not vault:
            raise ValueError("仓库名不能为空")
        row = find_vault(conn, vault)
        if row:
            return f"vault:{row['nameLower']}", f"仓库:{row['name']}"
        return f"vault:{vault.lower()}", f"仓库:{vault}"

    vault_row = find_vault(conn, raw)
    player_row = find_player(conn, raw)
    if vault_row and player_row:
        raise ValueError(f"归属 {raw} 同时是玩家名和仓库名，请写 玩家:{raw} 或 仓库:{raw}")
    if vault_row:
        return f"vault:{vault_row['nameLower']}", f"仓库:{vault_row['name']}"
    if player_row:
        return player_row["uuid"], player_row["username"]

    if raw.startswith("name:"):
        return raw, raw[5:]
    if len(raw) >= 24 and "-" in raw:
        return raw, raw
    return f"name:{raw}", raw


def find_vault(conn: sqlite3.Connection, name: str) -> sqlite3.Row | None:
    try:
        return conn.execute(
            """
            SELECT name_lower AS nameLower, name
            FROM custom_warehouses
            WHERE name_lower = lower(?)
            LIMIT 1
            """,
            (name,),
        ).fetchone()
    except sqlite3.OperationalError:
        return None


def find_player(conn: sqlite3.Connection, name: str) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT uuid, username
        FROM players
        WHERE lower(username) = lower(?) OR uuid = ?
        ORDER BY last_seen_at DESC
        LIMIT 1
        """,
        (name, name),
    ).fetchone()


def upsert_item(conn: sqlite3.Connection, item: dict) -> None:
    ensure_viewer_schema(conn)
    override = get_name_override(conn, item["itemKey"])
    display_name = override["displayName"] if override else item["displayName"]
    conn.execute(
        """
        INSERT INTO items (item_key, item_id, display_name, nbt_json, meta_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(item_key) DO UPDATE SET
          display_name = CASE
            WHEN items.display_name_manual = 1 THEN items.display_name
            ELSE excluded.display_name
          END,
          nbt_json = excluded.nbt_json,
          meta_json = excluded.meta_json
        """,
        (item["itemKey"], item["itemId"], display_name, item["nbtJson"], item["metaJson"]),
    )
    if override and (not override["itemKey"] or not override["itemId"]):
        conn.execute(
            """
            UPDATE item_name_overrides
            SET item_key = COALESCE(item_key, ?),
                item_id = COALESCE(item_id, ?),
                updated_at = CURRENT_TIMESTAMP
            WHERE short_code = ?
            """,
            (item["itemKey"], item["itemId"], override["shortCode"]),
        )


def set_balance(conn: sqlite3.Connection, owner_uuid: str, item_key: str, amount: int) -> None:
    if amount < 0:
        raise ValueError("库存不能小于 0")
    if amount == 0:
        conn.execute("DELETE FROM balances WHERE owner_uuid = ? AND item_key = ?", (owner_uuid, item_key))
        return
    conn.execute(
        """
        INSERT INTO balances (owner_uuid, item_key, amount)
        VALUES (?, ?, ?)
        ON CONFLICT(owner_uuid, item_key) DO UPDATE SET amount = excluded.amount
        """,
        (owner_uuid, item_key, amount),
    )


def owner_item_rows(conn: sqlite3.Connection, owner_uuid: str, item_ref: dict | None = None) -> list[sqlite3.Row]:
    if item_ref and item_ref.get("itemKey"):
        return conn.execute(
            """
            SELECT b.owner_uuid AS ownerUuid, b.item_key AS itemKey, b.amount,
                   i.item_id AS itemId, i.display_name AS displayName,
                   i.nbt_json AS nbtJson, i.meta_json AS metaJson
            FROM balances b
            JOIN items i ON i.item_key = b.item_key
            WHERE b.owner_uuid = ? AND i.item_key = ? AND b.amount > 0
            ORDER BY i.created_at, i.item_key
            """,
            (owner_uuid, item_ref["itemKey"]),
        ).fetchall()
    if item_ref and item_ref.get("itemId"):
        return conn.execute(
            """
            SELECT b.owner_uuid AS ownerUuid, b.item_key AS itemKey, b.amount,
                   i.item_id AS itemId, i.display_name AS displayName,
                   i.nbt_json AS nbtJson, i.meta_json AS metaJson
            FROM balances b
            JOIN items i ON i.item_key = b.item_key
            WHERE b.owner_uuid = ? AND i.item_id = ? AND b.amount > 0
            ORDER BY i.created_at, i.item_key
            """,
            (owner_uuid, item_ref["itemId"]),
        ).fetchall()
    return conn.execute(
        """
        SELECT b.owner_uuid AS ownerUuid, b.item_key AS itemKey, b.amount,
               i.item_id AS itemId, i.display_name AS displayName,
               i.nbt_json AS nbtJson, i.meta_json AS metaJson
        FROM balances b
        JOIN items i ON i.item_key = b.item_key
        WHERE b.owner_uuid = ? AND b.amount > 0
        ORDER BY i.created_at, i.item_key
        """,
        (owner_uuid,),
    ).fetchall()


def add_balance(conn: sqlite3.Connection, owner_uuid: str, item: dict, amount: int) -> None:
    if amount <= 0:
        return
    upsert_item(conn, item)
    row = conn.execute(
        "SELECT amount FROM balances WHERE owner_uuid = ? AND item_key = ?",
        (owner_uuid, item["itemKey"]),
    ).fetchone()
    set_balance(conn, owner_uuid, item["itemKey"], (row["amount"] if row else 0) + amount)


def item_for_ref(item_ref: dict) -> dict:
    if item_ref.get("itemKey"):
        return {
            "itemKey": item_ref["itemKey"],
            "itemId": item_ref["itemId"],
            "displayName": clean_display_name(item_ref["displayName"]),
            "nbtJson": item_ref.get("nbtJson") or "",
            "metaJson": item_ref.get("metaJson") or "",
            "amount": 0,
        }
    return base_item_for_item_id(item_ref["itemId"])


def is_plain_item_row(row: sqlite3.Row) -> bool:
    nbt_json = (row["nbtJson"] or "").strip()
    meta_json = (row["metaJson"] or "").replace(" ", "")
    if nbt_json not in ("", "null"):
        return False
    return (
        not meta_json
        or '"components":[]' in meta_json
        or '"components":null' in meta_json
        or meta_json == stable_stringify({"metadata": None, "components": None}).replace(" ", "")
    )


def canonical_item_for_ref(conn: sqlite3.Connection, item_ref: dict) -> dict:
    if item_ref.get("itemKey"):
        return item_for_ref(item_ref)

    rows = conn.execute(
        """
        SELECT item_key AS itemKey, item_id AS itemId, display_name AS displayName,
               nbt_json AS nbtJson, meta_json AS metaJson
        FROM items
        WHERE item_id = ?
        ORDER BY created_at ASC, item_key ASC
        """,
        (item_ref["itemId"],),
    ).fetchall()
    for row in rows:
        if is_plain_item_row(row):
            return row_to_item(row, 0)
    return base_item_for_item_id(item_ref["itemId"])


def subtract_item_amount(conn: sqlite3.Connection, owner_uuid: str, item_ref: dict, amount: int) -> list[dict]:
    rows = owner_item_rows(conn, owner_uuid, item_ref)
    current = sum(int(row["amount"]) for row in rows)
    to_remove = min(amount, current)
    removed: list[dict] = []
    remaining = to_remove
    for row in rows:
        if remaining <= 0:
            break
        count = min(int(row["amount"]), remaining)
        set_balance(conn, owner_uuid, row["itemKey"], int(row["amount"]) - count)
        removed.append(row_to_item(row, count))
        remaining -= count
    return removed


def row_to_item(row: sqlite3.Row, amount: int | None = None) -> dict:
    return {
        "itemKey": row["itemKey"],
        "itemId": row["itemId"],
        "displayName": clean_display_name(row["displayName"]),
        "nbtJson": row["nbtJson"] or "",
        "metaJson": row["metaJson"] or "",
        "amount": int(row["amount"] if amount is None else amount),
    }


def add_transaction(conn: sqlite3.Connection, tx_type: str, owner_uuid: str, username: str, items: list[dict], message: str) -> None:
    conn.execute(
        """
        INSERT INTO transactions (type, status, player_uuid, username, items_json, message)
        VALUES (?, 'ok', ?, ?, ?, ?)
        """,
        (tx_type, owner_uuid, username, json.dumps(items, ensure_ascii=False), message),
    )


class ViewerHandler(BaseHTTPRequestHandler):
    db_path: Path = DEFAULT_DB

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[viewer] {self.address_string()} {fmt % args}")

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        params = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/":
                self.send_html(HTML)
            elif path == "/api/inventory":
                self.send_json(self.api_inventory(params))
            elif path == "/api/mismatches":
                self.send_json(self.api_mismatches(params))
            elif path == "/api/warehouses":
                self.send_json(self.api_warehouses(params))
            elif path == "/api/warehouse":
                self.send_json(self.api_warehouse(params))
            elif path == "/api/transactions":
                self.send_json(self.api_transactions(params))
            elif path == "/api/chests":
                self.send_json(self.api_chests(params))
            elif path == "/api/chest":
                self.send_json(self.api_chest(params))
            elif path == "/api/name-overrides":
                self.send_json(self.api_name_overrides(params))
            else:
                self.send_error(404, "Not found")
        except Exception as exc:
            self.send_json({"error": str(exc)}, status=500)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        try:
            payload = self.read_json_body()
            if parsed.path == "/api/manage/adjust":
                self.send_json(self.api_manage_adjust(payload))
            elif parsed.path == "/api/manage/transfer":
                self.send_json(self.api_manage_transfer(payload))
            elif parsed.path == "/api/manage/rename-item":
                self.send_json(self.api_manage_rename_item(payload))
            elif parsed.path == "/api/mismatches/transfer":
                self.send_json(self.api_mismatch_transfer(payload))
            elif parsed.path == "/api/mismatches/delete":
                self.send_json(self.api_mismatch_delete(payload))
            elif parsed.path == "/api/name-overrides/save":
                self.send_json(self.api_name_override_save(payload))
            elif parsed.path == "/api/name-overrides/delete":
                self.send_json(self.api_name_override_delete(payload))
            else:
                self.send_error(404, "Not found")
        except Exception as exc:
            self.send_json({"error": str(exc)}, status=400)

    def arg(self, params: dict[str, list[str]], name: str, default: str = "") -> str:
        return (params.get(name, [default])[0] or "").strip()

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or "0")
        data = self.rfile.read(length)
        if not data:
            return {}
        payload = json.loads(data.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return payload

    def send_html(self, html: str) -> None:
        data = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload: object, status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def api_mismatches(self, params: dict[str, list[str]]) -> dict:
        kind_q = self.arg(params, "kind")
        status_q = self.arg(params, "status") or "open"
        owner_q = self.arg(params, "owner")
        item_q = self.arg(params, "item")
        if kind_q and kind_q not in ("extra", "missing"):
            raise ValueError("异常类型必须是 extra / missing")
        if status_q and status_q not in ("open", "resolved"):
            raise ValueError("状态必须是 open / resolved")

        where = []
        sql_params: list[object] = []
        if kind_q:
            where.append("kind = ?")
            sql_params.append(kind_q)
        if status_q:
            where.append("status = ?")
            sql_params.append(status_q)
        where_sql = "WHERE " + " AND ".join(where) if where else ""

        with connect_db(self.db_path) as conn:
            players = load_players(conn)
            try:
                rows = conn.execute(
                    f"""
                    SELECT id, kind, status, owner_uuid AS ownerUuid, username,
                           item_key AS itemKey, item_id AS itemId, display_name AS displayName,
                           nbt_json AS nbtJson, meta_json AS metaJson, amount, note,
                           created_at AS createdAt, resolved_at AS resolvedAt
                    FROM inventory_mismatches
                    {where_sql}
                    ORDER BY status = 'open' DESC, id DESC
                    LIMIT 1000
                    """,
                    sql_params,
                ).fetchall()
            except sqlite3.OperationalError:
                rows = []

        result = []
        open_rows = 0
        extra_amount = 0
        missing_amount = 0
        for row in rows:
            item = {
                "itemKey": row["itemKey"],
                "itemId": row["itemId"],
                "displayName": clean_display_name(row["displayName"]),
                "shortCode": short_code_for_item_key(row["itemKey"]),
            }
            owner = owner_label(row["ownerUuid"], players) if row["ownerUuid"] else (row["username"] or "未知归属")
            if owner_q and not (
                text_matches(owner, owner_q)
                or text_matches(row["username"], owner_q)
                or text_matches(row["ownerUuid"], owner_q)
            ):
                continue
            if not item_matches(item, item_q):
                continue
            amount = int(row["amount"] or 0)
            if row["status"] == "open":
                open_rows += 1
            if row["kind"] == "extra":
                extra_amount += amount
            elif row["kind"] == "missing":
                missing_amount += amount
            result.append(
                {
                    "id": row["id"],
                    "kind": row["kind"],
                    "status": row["status"],
                    "ownerUuid": row["ownerUuid"],
                    "username": row["username"],
                    "ownerLabel": owner,
                    "shortCode": item["shortCode"],
                    "itemKey": row["itemKey"],
                    "itemId": row["itemId"],
                    "displayName": item["displayName"],
                    "amount": amount,
                    "note": row["note"],
                    "createdAt": row["createdAt"],
                    "resolvedAt": row["resolvedAt"] or "",
                }
            )
        return {
            "stats": {
                "openRows": open_rows,
                "extraAmount": extra_amount,
                "missingAmount": missing_amount,
            },
            "rows": result,
        }

    def api_mismatch_transfer(self, payload: dict) -> dict:
        try:
            mismatch_id = int(str(payload.get("id") or ""))
        except ValueError:
            raise ValueError("异常 ID 必须是整数")
        to_text = str(payload.get("toOwner") or "").strip()
        if not to_text:
            raise ValueError("请填写目标归属")

        with connect_db(self.db_path, query_only=False) as conn:
            row = conn.execute(
                """
                SELECT id, kind, status, item_key AS itemKey, item_id AS itemId,
                       display_name AS displayName, nbt_json AS nbtJson, meta_json AS metaJson,
                       amount
                FROM inventory_mismatches
                WHERE id = ?
                """,
                (mismatch_id,),
            ).fetchone()
            if not row:
                raise ValueError("找不到这条异常记录")
            if row["kind"] != "extra":
                raise ValueError("只有多余物品可以直接转移")
            if row["status"] != "open":
                raise ValueError("这条异常已经处理过了")

            to_uuid, to_name = resolve_owner(conn, to_text)
            item = row_to_item(row, int(row["amount"]))
            momo_rows = owner_item_rows(conn, MOMO_OWNER, {"itemKey": item["itemKey"], "itemId": item["itemId"]})
            available = sum(int(momo_row["amount"]) for momo_row in momo_rows)
            move_amount = min(int(row["amount"]), available)
            if move_amount <= 0:
                raise ValueError("momo 当前没有这项多余库存，无法转移。你可以删除这条异常记录。")

            set_balance(conn, MOMO_OWNER, item["itemKey"], available - move_amount)
            moved = {**item, "amount": move_amount}
            add_balance(conn, to_uuid, moved, move_amount)
            add_transaction(conn, "viewer_transfer_out", MOMO_OWNER, "momo", [moved], f"mismatch extra transfer #{mismatch_id} -> {to_text}")
            add_transaction(conn, "viewer_transfer_in", to_uuid, to_name, [moved], f"mismatch extra transfer #{mismatch_id} from momo")
            conn.execute(
                """
                UPDATE inventory_mismatches
                SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP,
                    note = note || CASE WHEN note = '' THEN '' ELSE '；' END || ?
                WHERE id = ?
                """,
                (f"已转移给 {owner_label(to_uuid, load_players(conn))} x{move_amount}", mismatch_id),
            )
            conn.commit()
            suffix = "" if move_amount == int(row["amount"]) else f"；momo 只剩 x{move_amount}，未能按原记录全量转移"
            return {"ok": True, "message": f"已转移 {clean_display_name(item['displayName'])} x{move_amount} 到 {owner_label(to_uuid, load_players(conn))}{suffix}。"}

    def api_mismatch_delete(self, payload: dict) -> dict:
        try:
            mismatch_id = int(str(payload.get("id") or ""))
        except ValueError:
            raise ValueError("异常 ID 必须是整数")
        with connect_db(self.db_path, query_only=False) as conn:
            changed = conn.execute("DELETE FROM inventory_mismatches WHERE id = ?", (mismatch_id,)).rowcount
            conn.commit()
            return {"ok": True, "message": "已删除异常记录。" if changed else "没有找到这条异常记录。"}

    def api_manage_adjust(self, payload: dict) -> dict:
        action = str(payload.get("action") or "").strip()
        owner_text = str(payload.get("owner") or "").strip()
        item_text = str(payload.get("item") or "").strip()
        try:
            amount = int(str(payload.get("amount") or ""))
        except ValueError:
            raise ValueError("数量必须是整数")
        if action not in ("add", "subtract", "set"):
            raise ValueError("动作必须是 add / subtract / set")
        if amount < 0:
            raise ValueError("数量不能小于 0")

        with connect_db(self.db_path, query_only=False) as conn:
            owner_uuid, owner_name = resolve_owner(conn, owner_text)
            item_ref = resolve_item_ref(conn, item_text)
            item = canonical_item_for_ref(conn, item_ref)
            rows = owner_item_rows(conn, owner_uuid, item_ref)
            current = sum(int(row["amount"]) for row in rows)
            item_label = clean_display_name(item_ref["displayName"])

            if action == "add":
                add_balance(conn, owner_uuid, item, amount)
                changed = [{**item, "amount": amount}]
                message = f"viewer add {owner_text} {item_text} {amount}"
                label = f"已给 {owner_label(owner_uuid, load_players(conn))} 增加 {item['displayName']} x{amount}，现在共 x{current + amount}。"
                tx_type = "viewer_adjust_add"
            elif action == "subtract":
                changed = subtract_item_amount(conn, owner_uuid, item_ref, amount)
                removed = sum(item["amount"] for item in changed)
                message = f"viewer subtract {owner_text} {item_text} requested={amount}"
                label = f"已从 {owner_label(owner_uuid, load_players(conn))} 减少 {item_label} x{removed}，现在剩余 x{max(0, current - removed)}。"
                tx_type = "viewer_adjust_remove"
            else:
                if amount > current:
                    add_balance(conn, owner_uuid, item, amount - current)
                    changed = [{**item, "amount": amount - current}]
                else:
                    changed = subtract_item_amount(conn, owner_uuid, item_ref, current - amount)
                message = f"viewer set {owner_text} {item_text} {amount}"
                label = f"已把 {owner_label(owner_uuid, load_players(conn))} 的 {item_label} 设置为 x{amount}。"
                tx_type = "viewer_adjust_set"

            if changed:
                add_transaction(conn, tx_type, owner_uuid, owner_name, changed, message)
            conn.commit()
            return {"ok": True, "message": label}

    def api_manage_transfer(self, payload: dict) -> dict:
        from_text = str(payload.get("fromOwner") or "").strip()
        to_text = str(payload.get("toOwner") or "").strip()
        item_text = str(payload.get("item") or "").strip()
        amount_text = str(payload.get("amount") or "").strip()
        amount_limit = None
        if amount_text:
            try:
                amount_limit = int(amount_text)
            except ValueError:
                raise ValueError("数量必须是整数")
            if amount_limit <= 0:
                raise ValueError("转移数量必须大于 0")

        with connect_db(self.db_path, query_only=False) as conn:
            from_uuid, from_name = resolve_owner(conn, from_text)
            to_uuid, to_name = resolve_owner(conn, to_text)
            if from_uuid == to_uuid:
                raise ValueError("原主人和新主人不能相同")
            item_ref = resolve_item_ref(conn, item_text) if item_text else None
            rows = owner_item_rows(conn, from_uuid, item_ref)
            if not rows:
                raise ValueError("原主人没有可转移的库存")

            remaining = amount_limit
            moved: list[dict] = []
            for row in rows:
                if remaining is not None and remaining <= 0:
                    break
                row_amount = int(row["amount"])
                count = row_amount if remaining is None else min(row_amount, remaining)
                if count <= 0:
                    continue
                set_balance(conn, from_uuid, row["itemKey"], row_amount - count)
                item = row_to_item(row, count)
                upsert_item(conn, item)
                add_balance(conn, to_uuid, item, count)
                moved.append(item)
                if remaining is not None:
                    remaining -= count

            if not moved:
                raise ValueError("没有转移任何库存")
            total = sum(item["amount"] for item in moved)
            detail = item_text or "全部物品"
            message = f"viewer transfer {from_text} -> {to_text}, item={detail}, requested={amount_text or 'all'}"
            add_transaction(conn, "viewer_transfer_out", from_uuid, from_name, moved, message)
            add_transaction(conn, "viewer_transfer_in", to_uuid, to_name, moved, message)
            conn.commit()
            return {
                "ok": True,
                "message": f"已从 {owner_label(from_uuid, load_players(conn))} 转移 {total} 个物品到 {owner_label(to_uuid, load_players(conn))}。"
            }

    def api_manage_rename_item(self, payload: dict) -> dict:
        item_text = str(payload.get("item") or "").strip()
        display_name = str(payload.get("displayName") or "").strip()
        if not item_text:
            raise ValueError("物品不能为空")
        if not display_name:
            raise ValueError("新显示名不能为空")
        if len(display_name) > 80:
            raise ValueError("新显示名不能超过 80 个字符")

        with connect_db(self.db_path, query_only=False) as conn:
            item_ref = resolve_item_ref(conn, item_text)
            if not item_ref.get("itemKey"):
                raise ValueError("修改物品名必须精确到一个物品变体，请使用短码或 itemKey。")
            old_name = item_ref["displayName"]
            short_code = short_code_for_item_key(item_ref["itemKey"])
            if not short_code:
                raise ValueError("这个物品没有 6 位码，无法保存人工命名规则。")
            save_name_override(conn, short_code, display_name, item_ref["itemKey"], item_ref["itemId"])
            item = {
                "itemKey": item_ref["itemKey"],
                "itemId": item_ref["itemId"],
                "displayName": display_name,
                "nbtJson": item_ref.get("nbtJson") or "",
                "metaJson": item_ref.get("metaJson") or "",
                "amount": 0,
            }
            add_transaction(
                conn,
                "viewer_rename_item",
                MOMO_OWNER,
                "viewer",
                [item],
                f"rename item {item_text}: {old_name} -> {display_name}",
            )
            conn.commit()
            return {
                "ok": True,
                "message": f"已把 {short_code_for_item_key(item_ref['itemKey'])} 的显示名从 {old_name} 改为 {display_name}。"
            }

    def api_name_overrides(self, params: dict[str, list[str]]) -> dict:
        q = self.arg(params, "q")
        with connect_db(self.db_path) as conn:
            try:
                rows = conn.execute(
                    """
                    SELECT short_code AS shortCode, item_key AS itemKey, item_id AS itemId,
                           display_name AS displayName, created_at AS createdAt, updated_at AS updatedAt
                    FROM item_name_overrides
                    ORDER BY updated_at DESC, short_code ASC
                    """
                ).fetchall()
            except sqlite3.OperationalError:
                rows = []

        result = []
        for row in rows:
            item = {
                "shortCode": row["shortCode"],
                "itemKey": row["itemKey"] or "",
                "itemId": row["itemId"] or "",
                "displayName": row["displayName"],
                "createdAt": row["createdAt"],
                "updatedAt": row["updatedAt"],
            }
            if q and not (
                text_matches(item["shortCode"], q)
                or text_matches(item["itemKey"], q)
                or text_matches(item["itemId"], q)
                or text_matches(item["displayName"], q)
            ):
                continue
            result.append(item)
        return {"rows": result}

    def api_name_override_save(self, payload: dict) -> dict:
        item_text = str(payload.get("item") or payload.get("shortCode") or "").strip()
        display_name = str(payload.get("displayName") or "").strip()
        if not item_text:
            raise ValueError("请填写 6位码、itemKey 或当前物品名。")
        if not display_name:
            raise ValueError("人工显示名不能为空。")
        if len(display_name) > 80:
            raise ValueError("人工显示名不能超过 80 个字符。")

        with connect_db(self.db_path, query_only=False) as conn:
            item_key = ""
            item_id = ""
            raw_code = item_text[1:] if item_text.startswith("#") else item_text
            if len(raw_code) == 6 and all(ch in "0123456789abcdefABCDEF" for ch in raw_code):
                short_code = raw_code.lower()
                row = conn.execute(
                    """
                    SELECT item_key AS itemKey, item_id AS itemId
                    FROM items
                    WHERE lower(substr(item_key, instr(item_key, '|') + 1, 6)) = lower(?)
                    ORDER BY created_at
                    LIMIT 1
                    """,
                    (short_code,),
                ).fetchone()
                if row:
                    item_key = row["itemKey"]
                    item_id = row["itemId"]
            else:
                item_ref = resolve_item_ref(conn, item_text)
                if not item_ref.get("itemKey"):
                    raise ValueError("保存人工命名需要精确到 6位码、短码或 itemKey。")
                short_code = short_code_for_item_key(item_ref["itemKey"])
                item_key = item_ref["itemKey"]
                item_id = item_ref["itemId"]
                if not short_code:
                    raise ValueError("这个物品没有 6 位码，无法保存人工命名规则。")

            save_name_override(conn, short_code, display_name, item_key, item_id)
            add_transaction(
                conn,
                "viewer_name_override",
                MOMO_OWNER,
                "viewer",
                [],
                f"name override {short_code}: {display_name}",
            )
            conn.commit()
            return {"ok": True, "message": f"已保存 {short_code} -> {display_name}。"}

    def api_name_override_delete(self, payload: dict) -> dict:
        short_code = str(payload.get("shortCode") or "").strip().replace("#", "").lower()
        if not short_code or len(short_code) != 6 or any(ch not in "0123456789abcdef" for ch in short_code):
            raise ValueError("短码必须是 6 位十六进制。")
        with connect_db(self.db_path, query_only=False) as conn:
            changed = conn.execute(
                "DELETE FROM item_name_overrides WHERE short_code = ?",
                (short_code,),
            ).rowcount
            conn.execute(
                """
                UPDATE items
                SET display_name_manual = 0
                WHERE lower(substr(item_key, instr(item_key, '|') + 1, 6)) = lower(?)
                """,
                (short_code,),
            )
            add_transaction(
                conn,
                "viewer_name_override_delete",
                MOMO_OWNER,
                "viewer",
                [],
                f"delete name override {short_code}",
            )
            conn.commit()
            return {"ok": True, "message": "已删除。" if changed else "没有找到这条命名规则。"}

    def api_inventory(self, params: dict[str, list[str]]) -> dict:
        owner_q = self.arg(params, "owner")
        item_q = self.arg(params, "item")
        with connect_db(self.db_path) as conn:
            players = load_players(conn)
            rows = conn.execute(
                """
                SELECT b.owner_uuid AS ownerUuid, i.item_key AS itemKey, i.item_id AS itemId,
                       i.display_name AS displayName, i.nbt_json AS nbtJson,
                       i.meta_json AS metaJson, SUM(b.amount) AS amount
                FROM balances b
                JOIN items i ON i.item_key = b.item_key
                WHERE b.amount > 0
                GROUP BY b.owner_uuid, i.item_key
                ORDER BY b.owner_uuid, i.display_name
                """
            ).fetchall()

        result = []
        owners = set()
        item_keys = set()
        total = 0
        for row in rows:
            item = {
                "ownerUuid": row["ownerUuid"],
                "ownerLabel": owner_label(row["ownerUuid"], players),
                "shortCode": short_code_for_item_key(row["itemKey"]),
                "itemKey": row["itemKey"],
                "itemId": row["itemId"],
                "displayName": clean_display_name(row["displayName"]),
                "nbtJson": row["nbtJson"] or "",
                "metaJson": row["metaJson"] or "",
                "amount": row["amount"],
            }
            if owner_q and not (
                text_matches(item["ownerLabel"], owner_q) or text_matches(item["ownerUuid"], owner_q)
            ):
                continue
            if not item_matches(item, item_q):
                continue
            result.append(item)
            owners.add(item["ownerUuid"])
            item_keys.add(item["itemKey"])
            total += item["amount"]

        return {
            "stats": {
                "totalAmount": total,
                "itemTypes": len(item_keys),
                "owners": len(owners),
            },
            "rows": result,
        }

    def api_transactions(self, params: dict[str, list[str]]) -> dict:
        owner_q = self.arg(params, "owner")
        item_q = self.arg(params, "item")
        type_q = self.arg(params, "type")
        date_q = self.arg(params, "date")
        try:
            limit = max(1, min(1000, int(self.arg(params, "limit", "200"))))
        except ValueError:
            limit = 200

        where = []
        sql_params: list[object] = []
        if type_q:
            where.append("type = ?")
            sql_params.append(type_q)
        if date_q:
            if len(date_q) != 10 or date_q[4] != "-" or date_q[7] != "-":
                raise ValueError("日期格式应为 YYYY-MM-DD")
            where.append("substr(created_at, 1, 10) = ?")
            sql_params.append(date_q)
        where_sql = "WHERE " + " AND ".join(where) if where else ""

        with connect_db(self.db_path) as conn:
            players = load_players(conn)
            rows = conn.execute(
                f"""
                SELECT id, type, status, player_uuid AS playerUuid, username,
                       items_json AS itemsJson, message, created_at AS createdAt
                FROM transactions
                {where_sql}
                ORDER BY id DESC
                LIMIT ?
                """,
                [*sql_params, limit * 3],
            ).fetchall()

        result = []
        for row in rows:
            items = parse_items_json(row["itemsJson"])
            label = owner_label(row["playerUuid"], players)
            if owner_q and not (
                text_matches(label, owner_q)
                or text_matches(row["username"], owner_q)
                or text_matches(row["playerUuid"], owner_q)
                or text_matches(row["message"], owner_q)
            ):
                continue
            if item_q and not any(item_matches(item, item_q) for item in items):
                continue
            total_amount = sum(int(item.get("amount") or 0) for item in items)
            result.append(
                {
                    "id": row["id"],
                    "type": row["type"],
                    "status": row["status"],
                    "playerUuid": row["playerUuid"],
                    "username": row["username"],
                    "ownerLabel": label,
                    "message": row["message"],
                    "createdAt": row["createdAt"],
                    "totalAmount": total_amount,
                    "items": [
                        {
                            "itemKey": item.get("itemKey", ""),
                            "shortCode": short_code_for_item_key(item.get("itemKey", "")),
                            "itemId": item.get("itemId", ""),
                            "displayName": clean_display_name(item.get("displayName", "")),
                            "amount": int(item.get("amount") or 0),
                        }
                        for item in items
                    ],
                }
            )
            if len(result) >= limit:
                break

        return {"rows": result}

    def api_warehouses(self, params: dict[str, list[str]]) -> dict:
        query = self.arg(params, "q")
        show_empty = self.arg(params, "showEmpty") in ("1", "true", "yes", "on")
        with connect_db(self.db_path) as conn:
            rows = conn.execute(
                """
                WITH member_counts AS (
                  SELECT warehouse_name_lower AS nameLower, COUNT(*) AS memberCount
                  FROM custom_warehouse_members
                  GROUP BY warehouse_name_lower
                ),
                inventory_counts AS (
                  SELECT substr(owner_uuid, 7) AS nameLower, SUM(amount) AS totalAmount
                  FROM balances
                  WHERE owner_uuid LIKE 'vault:%'
                  GROUP BY owner_uuid
                )
                SELECT w.name_lower AS nameLower, w.name, w.creator_uuid AS creatorUuid,
                       w.creator_username AS creatorUsername, w.created_at AS createdAt,
                       COALESCE(mc.memberCount, 0) AS memberCount,
                       COALESCE(ic.totalAmount, 0) AS totalAmount
                FROM custom_warehouses w
                LEFT JOIN member_counts mc ON mc.nameLower = w.name_lower
                LEFT JOIN inventory_counts ic ON ic.nameLower = w.name_lower
                ORDER BY w.created_at ASC, w.name ASC
                """
            ).fetchall()
            member_rows = conn.execute(
                """
                SELECT warehouse_name_lower AS nameLower, username
                FROM custom_warehouse_members
                """
            ).fetchall()

        members_by_vault: dict[str, list[str]] = {}
        for row in member_rows:
            members_by_vault.setdefault(row["nameLower"], []).append(row["username"])

        result = []
        for row in rows:
            haystack = [row["name"], row["creatorUsername"], *members_by_vault.get(row["nameLower"], [])]
            if query and not any(text_matches(value, query) for value in haystack):
                continue
            if not query and not show_empty and int(row["totalAmount"] or 0) <= 0:
                continue
            result.append(
                {
                    "nameLower": row["nameLower"],
                    "name": row["name"],
                    "creatorUuid": row["creatorUuid"],
                    "creatorUsername": row["creatorUsername"],
                    "createdAt": row["createdAt"],
                    "ownerUuid": f"vault:{row['nameLower']}",
                    "memberCount": row["memberCount"],
                    "totalAmount": row["totalAmount"],
                }
            )
        return {"rows": result}

    def api_warehouse(self, params: dict[str, list[str]]) -> dict:
        name = self.arg(params, "name")
        if not name:
            raise ValueError("缺少仓库名")
        with connect_db(self.db_path) as conn:
            warehouse = find_vault(conn, name)
            if not warehouse:
                raise ValueError(f"找不到仓库：{name}")
            members = conn.execute(
                """
                SELECT player_uuid AS playerUuid, username, role, added_at AS addedAt
                FROM custom_warehouse_members
                WHERE warehouse_name_lower = ?
                ORDER BY role = 'admin' DESC, username COLLATE NOCASE ASC
                """,
                (warehouse["nameLower"],),
            ).fetchall()
            items = conn.execute(
                """
                SELECT i.item_key AS itemKey, i.item_id AS itemId, i.display_name AS displayName,
                       SUM(b.amount) AS amount
                FROM balances b
                JOIN items i ON i.item_key = b.item_key
                WHERE b.owner_uuid = ? AND b.amount > 0
                GROUP BY i.item_key
                ORDER BY i.display_name ASC
                """,
                (f"vault:{warehouse['nameLower']}",),
            ).fetchall()
        return {
            "warehouse": dict(warehouse),
            "ownerUuid": f"vault:{warehouse['nameLower']}",
            "members": [dict(row) for row in members],
            "items": [
                {**dict(row), "displayName": clean_display_name(row["displayName"]), "shortCode": short_code_for_item_key(row["itemKey"])}
                for row in items
            ],
        }

    def api_chests(self, params: dict[str, list[str]]) -> dict:
        item_q = self.arg(params, "item")
        chest_q = self.arg(params, "chest")
        with connect_db(self.db_path) as conn:
            rows = conn.execute(
                """
                SELECT c.chest_id AS chestId, c.x, c.y, c.z, c.block_name AS blockName,
                       c.last_seen_at AS lastSeenAt,
                       COUNT(cs.slot) AS slotCount,
                       COALESCE(SUM(cs.amount), 0) AS totalAmount
                FROM chests c
                LEFT JOIN chest_slots cs ON cs.chest_id = c.chest_id
                GROUP BY c.chest_id
                ORDER BY c.y, c.x, c.z
                """
            ).fetchall()
            chest_items = {}
            if item_q:
                item_rows = conn.execute(
                    """
                    SELECT cs.chest_id AS chestId, i.item_key AS itemKey, i.item_id AS itemId,
                           i.display_name AS displayName
                    FROM chest_slots cs
                    JOIN items i ON i.item_key = cs.item_key
                    """
                ).fetchall()
                for row in item_rows:
                    chest_items.setdefault(row["chestId"], []).append(dict(row))

        result = []
        for row in rows:
            chest_id = row["chestId"]
            if chest_q and not text_matches(chest_id, chest_q):
                continue
            if item_q and not any(item_matches(item, item_q) for item in chest_items.get(chest_id, [])):
                continue
            result.append(
                {
                    "chestId": chest_id,
                    "x": row["x"],
                    "y": row["y"],
                    "z": row["z"],
                    "blockName": row["blockName"],
                    "lastSeenAt": row["lastSeenAt"],
                    "slotCount": row["slotCount"],
                    "totalAmount": row["totalAmount"],
                }
            )
        return {"rows": result}

    def api_chest(self, params: dict[str, list[str]]) -> dict:
        chest_id = self.arg(params, "chest")
        if not chest_id:
            raise ValueError("缺少 chest 参数")
        with connect_db(self.db_path) as conn:
            chest = conn.execute(
                """
                SELECT chest_id AS chestId, x, y, z, block_name AS blockName,
                       last_seen_at AS lastSeenAt
                FROM chests
                WHERE chest_id = ?
                """,
                (chest_id,),
            ).fetchone()
            if not chest:
                raise ValueError(f"找不到木桶：{chest_id}")
            items = conn.execute(
                """
                SELECT cs.slot, cs.amount, i.item_key AS itemKey, i.item_id AS itemId,
                       i.display_name AS displayName, i.nbt_json AS nbtJson,
                       i.meta_json AS metaJson
                FROM chest_slots cs
                JOIN items i ON i.item_key = cs.item_key
                WHERE cs.chest_id = ?
                ORDER BY cs.slot
                """,
                (chest_id,),
            ).fetchall()
        return {
            "chest": dict(chest),
            "items": [
                {**dict(row), "displayName": clean_display_name(row["displayName"]), "shortCode": short_code_for_item_key(row["itemKey"])}
                for row in items
            ],
        }


def main() -> int:
    args = parse_args()
    db_path = Path(args.db).resolve()
    if not db_path.exists():
        print(f"找不到数据库文件：{db_path}", file=sys.stderr)
        return 1

    ViewerHandler.db_path = db_path
    server = ThreadingHTTPServer((args.host, args.port), ViewerHandler)
    url = f"http://{args.host}:{args.port}/"
    print(f"云仓库查看器已启动：{url}")
    print(f"数据库：{db_path}")
    print("按 Ctrl+C 退出。")

    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在退出...")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
