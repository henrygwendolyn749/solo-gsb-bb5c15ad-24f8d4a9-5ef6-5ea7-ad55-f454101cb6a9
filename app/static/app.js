"use strict";

/* 编织行指令审校前端：编辑 -> 防抖调用 /api/analyze -> 渲染逐行结果 */

const STORAGE_KEY = "knit-review-plan-v1";
const BASELINE_KEY = "knit-review-baseline-v1";
const SIZES_KEY = "knit-review-sizes-v1";
const DEBOUNCE_MS = 250;

const EXAMPLE = {
  name: "示例方案",
  start_stitches: 20,
  rows: [
    "[k2 inc1]*4 k8",
    "[k3 dec2]*4",
    "k16",
    "[k3 inc2]*4",
    "[k2]*~4 k4",
  ],
};

const els = {
  start: document.getElementById("start-stitches"),
  editor: document.getElementById("rows-editor"),
  add: document.getElementById("btn-add-row"),
  results: document.getElementById("results"),
  summary: document.getElementById("summary"),
  sync: document.getElementById("sync-state"),
  btnExample: document.getElementById("btn-example"),
  btnImport: document.getElementById("btn-import"),
  btnExport: document.getElementById("btn-export"),
  file: document.getElementById("file-import"),
  btnSaveBaseline: document.getElementById("btn-save-baseline"),
  btnClearBaseline: document.getElementById("btn-clear-baseline"),
  baselineInfo: document.getElementById("baseline-info"),
  comparePanel: document.getElementById("compare-panel"),
  compareSummary: document.getElementById("compare-summary"),
  compareTableWrap: document.getElementById("compare-table-wrap"),
  compareState: document.getElementById("compare-state"),
  sizesEditor: document.getElementById("sizes-editor"),
  btnAddSize: document.getElementById("btn-add-size"),
  btnRunSizes: document.getElementById("btn-run-sizes"),
  sizesHint: document.getElementById("sizes-hint"),
  sizesState: document.getElementById("sizes-state"),
  sizesSummary: document.getElementById("sizes-summary"),
  sizesMatrixWrap: document.getElementById("sizes-matrix-wrap"),
  sizesDetail: document.getElementById("sizes-detail"),
};

let state = load() || { start_stitches: 20, rows: [...EXAMPLE.rows] };
let baseline = loadBaseline();
// 最近一次逐行审校接口结果：两侧分别缓存，一侧失败不影响另一侧展示。
let currentRows = null;
let currentErr = null;
let baselineRows = null;
let baselineErr = null;
let debounceTimer = null;
let reqSeq = 0;
// 尺码联检：尺码列表持久化在浏览器本地；联检结果仅在点击「开始联检」后更新。
let sizes = loadSizes() || defaultSizes();
let sizesResult = null; // { sizes: [{name, start_stitches, rows}], rowTexts: [...] }
let sizesErr = null;
let sizesStale = false; // 联检后方案或尺码又被修改，矩阵结果已过期
let selectedCell = null; // { sizeIdx, rowIdx }
let sizesReqSeq = 0;

// ---------------------------------------------------------------- 初始化
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (typeof obj.start_stitches !== "number" || !Array.isArray(obj.rows)) return null;
    return { start_stitches: obj.start_stitches, rows: obj.rows.map(String) };
  } catch {
    return null;
  }
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------------------------------------------------------------- 尺码存取
function defaultSizes() {
  const base = state && Number.isInteger(state.start_stitches) ? state.start_stitches : 20;
  return [
    { name: "S", start_stitches: base },
    { name: "M", start_stitches: base + 4 },
  ];
}

function loadSizes() {
  try {
    const raw = localStorage.getItem(SIZES_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length < 2 || arr.length > 8) return null;
    const ok = arr.every((s) => s && typeof s.name === "string"
      && Number.isInteger(s.start_stitches) && s.start_stitches >= 0);
    if (!ok) return null;
    return arr.map((s) => ({ name: s.name, start_stitches: s.start_stitches }));
  } catch {
    return null;
  }
}

function persistSizes() {
  localStorage.setItem(SIZES_KEY, JSON.stringify(sizes));
}

// ---------------------------------------------------------------- 基线存取
function loadBaseline() {
  try {
    const raw = localStorage.getItem(BASELINE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (typeof obj.start_stitches !== "number" || !Array.isArray(obj.rows)) return null;
    return {
      start_stitches: obj.start_stitches,
      rows: obj.rows.map(String),
      saved_at: typeof obj.saved_at === "string" ? obj.saved_at : null,
    };
  } catch {
    return null;
  }
}

function fmtTime(iso) {
  if (!iso) return "未知时间";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function updateBaselineBar() {
  const has = !!baseline;
  els.btnClearBaseline.hidden = !has;
  els.btnSaveBaseline.textContent = has ? "更新基线为当前" : "保存当前为基线";
  els.baselineInfo.textContent = has
    ? `基线：起始 ${baseline.start_stitches} 针 · ${baseline.rows.length} 行 · 保存于 ${fmtTime(baseline.saved_at)}`
    : "尚未保存基线。保存后可在下方对照当前编辑与基线的差异。";
}

els.btnSaveBaseline.addEventListener("click", () => {
  baseline = {
    start_stitches: state.start_stitches,
    rows: [...state.rows],
    saved_at: new Date().toISOString(),
  };
  localStorage.setItem(BASELINE_KEY, JSON.stringify(baseline));
  baselineRows = null;
  baselineErr = null;
  updateBaselineBar();
  analyze();
});

els.btnClearBaseline.addEventListener("click", () => {
  baseline = null;
  baselineRows = null;
  baselineErr = null;
  localStorage.removeItem(BASELINE_KEY);
  updateBaselineBar();
  renderCompare();
});

// ---------------------------------------------------------------- 编辑器
function renderEditor(focusIndex = -1) {
  els.start.value = state.start_stitches;
  els.editor.innerHTML = "";
  state.rows.forEach((text, i) => {
    const wrap = document.createElement("div");
    wrap.className = "row-edit";
    wrap.dataset.rowIndex = i;

    const no = document.createElement("span");
    no.className = "row-no";
    no.textContent = `第 ${i + 1} 行`;

    const input = document.createElement("input");
    input.type = "text";
    input.value = text;
    input.placeholder = "如 k4 [k2 inc1]*3 dec2 或 [k2]*~6 k6";
    input.setAttribute("aria-label", `第 ${i + 1} 行指令`);
    input.addEventListener("input", () => {
      state.rows[i] = input.value;
      scheduleAnalyze();
    });

    const ops = document.createElement("div");
    ops.className = "row-ops";
    const up = miniBtn("↑", "上移", () => moveRow(i, -1));
    const down = miniBtn("↓", "下移", () => moveRow(i, 1));
    const del = miniBtn("删除", "删除本行", () => removeRow(i));
    del.classList.add("danger");
    ops.append(up, down, del);

    wrap.append(no, input, ops);
    els.editor.appendChild(wrap);
    if (i === focusIndex) input.focus();
  });
}

function miniBtn(text, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn btn-mini";
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function moveRow(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= state.rows.length) return;
  [state.rows[i], state.rows[j]] = [state.rows[j], state.rows[i]];
  renderEditor(j);
  persist();
  scheduleAnalyze();
}

function removeRow(i) {
  state.rows.splice(i, 1);
  renderEditor();
  persist();
  scheduleAnalyze();
}

els.start.addEventListener("input", () => {
  const v = Number(els.start.value);
  state.start_stitches = Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  scheduleAnalyze();
});

els.add.addEventListener("click", () => {
  state.rows.push("");
  renderEditor(state.rows.length - 1);
  persist();
});

// ---------------------------------------------------------------- 分析
function scheduleAnalyze() {
  persist();
  markSizesStale();
  clearTimeout(debounceTimer);
  els.sync.textContent = "计算中…";
  els.sync.className = "sync-state pending";
  debounceTimer = setTimeout(analyze, DEBOUNCE_MS);
}

async function postAnalyze(plan) {
  const resp = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start_stitches: plan.start_stitches, rows: plan.rows }),
  });
  if (!resp.ok) throw new Error(`服务返回 ${resp.status}`);
  return (await resp.json()).rows;
}

async function analyze() {
  const seq = ++reqSeq;
  // 当前方案与基线分别调用同一个逐行审校接口，各自独立 await：
  // 一侧请求失败时，另一侧的结果仍照常渲染（对照表中失败侧标注「分析失败」）。
  // 回调内检查 seq，过期响应直接丢弃，避免覆盖更新一轮的结果。
  const curTask = postAnalyze(state).then(
    (rows) => { if (seq === reqSeq) { currentRows = rows; currentErr = null; } },
    (err) => { if (seq === reqSeq) { currentRows = null; currentErr = err.message; } },
  );
  const baseTask = baseline
    ? postAnalyze(baseline).then(
        (rows) => { if (seq === reqSeq) { baselineRows = rows; baselineErr = null; } },
        (err) => { if (seq === reqSeq) { baselineRows = null; baselineErr = err.message; } },
      )
    : Promise.resolve();

  await curTask;
  if (seq !== reqSeq) return;
  if (currentRows) {
    renderResults(currentRows);
    els.sync.textContent = "已同步";
    els.sync.className = "sync-state";
  } else {
    els.sync.textContent = "分析失败：" + currentErr;
    els.sync.className = "sync-state error";
  }

  await baseTask;
  if (seq === reqSeq) renderCompare();
}

// ---------------------------------------------------------------- 结果渲染
const STATUS_TEXT = {
  ok: "通过",
  unconsumed: "未全部消耗",
  shortage: "针数短缺",
  error: "语法错误",
  blocked: "已阻断",
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderSource(row, locate) {
  const src = row.source;
  // 收集需要插入源文本的标记：短缺高亮（区间替换）、语法错误 ▲、
  // 自适应块后面的“实际重复 M 次”徽标（纯插入）、针数变化来源定位高亮。
  const marks = [];
  if (row.status === "shortage" && row.failing_start != null) {
    const [a, b] = [row.failing_start, row.failing_end];
    marks.push({
      start: a, end: b,
      html: `<span class="fail-hl" title="第一个无法执行的指令">${escapeHtml(src.slice(a, b))}</span>`,
    });
  }
  if (row.status === "error" && row.error_pos != null) {
    const p = Math.max(0, Math.min(row.error_pos, src.length));
    marks.push({ start: p, end: p, html: `<span class="caret" title="出错位置">▲</span>` });
  }
  (row.adaptive_blocks || []).forEach((b) => {
    marks.push({
      start: b.end, end: b.end,
      html: `<span class="adaptive-tag" title="自适应重复 *~${b.target_remaining}：`
        + `执行后为后续指令保留 ${b.target_remaining} 针，每轮消耗 ${b.per_pass_consumed} 针、`
        + `产出 ${b.per_pass_produced} 针">实际重复 ${b.actual_repeats} 次</span>`,
    });
  });
  if (locate && locate.start != null) {
    const [a, b] = [locate.start, locate.end];
    marks.push({
      start: a, end: b,
      html: `<span class="locate-hl" title="针数变化来源">${escapeHtml(src.slice(a, b))}</span>`,
    });
  }
  if (marks.length === 0) return escapeHtml(src);
  // 按起点排序后顺序重建；标记区间互不重叠（短缺叶子在另一节点内，
  // 自适应徽标挂在块末尾，▲ 在出错运算符处）。
  marks.sort((a, b) => a.start - b.start || a.end - b.end);
  let html = "";
  let cursor = 0;
  marks.forEach((m) => {
    if (m.start > cursor) html += escapeHtml(src.slice(cursor, m.start));
    html += m.html;
    cursor = Math.max(cursor, m.end);
  });
  if (cursor < src.length) html += escapeHtml(src.slice(cursor));
  return html;
}

function renderResults(rows) {
  els.results.innerHTML = "";
  renderSummary(rows);
  if (rows.length === 0) {
    const d = document.createElement("div");
    d.className = "empty-hint";
    d.textContent = "还没有任何行，点击“添加一行”或“载入示例”开始。";
    els.results.appendChild(d);
    return;
  }

  rows.forEach((row, i) => {
    if (i > 0) {
      const arrow = document.createElement("div");
      arrow.className = "flow-arrow";
      const prev = rows[i - 1];
      const carried = (prev.status === "ok" || prev.status === "unconsumed")
        ? prev.remaining : "—";
      arrow.innerHTML = `↓ 上一行产出 <b>${carried}</b> 针作为本行可用针数`;
      els.results.appendChild(arrow);
    }
    els.results.appendChild(renderCard(row, i));
  });
}

function renderSummary(rows) {
  const counts = { ok: 0, unconsumed: 0, shortage: 0, error: 0, blocked: 0 };
  rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const last = rows[rows.length - 1];
  const finalStitches = last && (last.status === "ok" || last.status === "unconsumed")
    ? last.remaining : null;

  const badges = [];
  badges.push(`行数 <b>${rows.length}</b>`);
  badges.push(`起始 <b>${state.start_stitches}</b> 针`);
  badges.push(`✅ 通过 <b>${counts.ok}</b>`);
  if (counts.unconsumed) badges.push(`⚠️ 未耗尽 <b>${counts.unconsumed}</b>`);
  if (counts.shortage) badges.push(`❌ 短缺 <b>${counts.shortage}</b>`);
  if (counts.error) badges.push(`❌ 语法错误 <b>${counts.error}</b>`);
  if (counts.blocked) badges.push(`🚫 阻断 <b>${counts.blocked}</b>`);
  badges.push(`最终针数 <b>${finalStitches == null ? "—" : finalStitches}</b>`);

  els.summary.innerHTML = badges.map((b) => `<span class="badge">${b}</span>`).join("");
}

function fmtNet(n) {
  return (n > 0 ? "+" : "") + n;
}

// 针数变化来源清单：仅 ok / unconsumed 行生成（stitch_net 不为 null）。
// 点击条目在源文本中高亮对应指令区间，再次点击取消。
function renderStitchChanges(row, sourceEl) {
  const det = document.createElement("details");
  det.className = "stitch-changes";
  det.open = true;

  const expected = row.produced - row.consumed;
  const match = row.stitch_net === expected;
  const sum = document.createElement("summary");
  sum.innerHTML =
    `针数变化来源 · 净变化合计 <b class="${row.stitch_net >= 0 ? "net-pos" : "net-neg"}">`
    + `${fmtNet(row.stitch_net)}</b> `
    + (match
      ? `<span class="sc-check ok-check">✓ 与 产出 ${row.produced} − 消耗 ${row.consumed} 相符</span>`
      : `<span class="sc-check bad-check">✗ 产出 − 消耗 为 ${fmtNet(expected)}，不一致</span>`);
  det.appendChild(sum);

  const entries = row.stitch_changes || [];
  if (entries.length === 0) {
    const note = document.createElement("div");
    note.className = "sc-empty";
    note.textContent = "本行没有加针 / 减针指令，针数无净变化。";
    det.appendChild(note);
    return det;
  }

  const table = document.createElement("table");
  table.className = "sc-table";
  table.innerHTML =
    "<thead><tr><th>指令</th><th>执行次数</th><th>消耗针数</th><th>产出针数</th><th>净变化</th></tr></thead>";
  const tbody = document.createElement("tbody");

  let activeTr = null;
  entries.forEach((e) => {
    const tr = document.createElement("tr");
    tr.className = "sc-entry";
    tr.title = `源文本第 ${e.start + 1}–${e.end} 列，点击定位原文`;
    tr.innerHTML =
      `<td><code class="sc-inst">${escapeHtml(e.instruction)}</code></td>` +
      `<td>${e.executions}</td>` +
      `<td>${e.consumed}</td>` +
      `<td>${e.produced}</td>` +
      `<td class="${e.net >= 0 ? "net-pos" : "net-neg"}">${fmtNet(e.net)}</td>`;
    tr.addEventListener("click", () => {
      if (activeTr === tr) {
        activeTr = null;
        tr.classList.remove("active");
        sourceEl.innerHTML = renderSource(row);
        return;
      }
      if (activeTr) activeTr.classList.remove("active");
      activeTr = tr;
      tr.classList.add("active");
      sourceEl.innerHTML = renderSource(row, { start: e.start, end: e.end });
      sourceEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  const tfoot = document.createElement("tfoot");
  const sumExec = entries.reduce((a, e) => a + e.executions, 0);
  const sumCon = entries.reduce((a, e) => a + e.consumed, 0);
  const sumPro = entries.reduce((a, e) => a + e.produced, 0);
  tfoot.innerHTML =
    `<tr><td>合计</td><td>${sumExec}</td><td>${sumCon}</td><td>${sumPro}</td>`
    + `<td class="${row.stitch_net >= 0 ? "net-pos" : "net-neg"}">${fmtNet(row.stitch_net)}</td></tr>`;
  table.appendChild(tfoot);

  det.appendChild(table);
  return det;
}

function renderCard(row, i) {
  const card = document.createElement("div");
  card.className = `row-card ${row.status}`;

  const head = document.createElement("div");
  head.className = "row-card-head";
  head.innerHTML =
    `<span class="idx">第 ${i + 1} 行</span>` +
    `<span class="status-tag">${STATUS_TEXT[row.status] || row.status}</span>`;
  card.appendChild(head);

  const source = document.createElement("div");
  source.className = "row-source";
  source.innerHTML = renderSource(row) || "<span style='opacity:.5'>（空行）</span>";
  card.appendChild(source);

  if (row.status !== "blocked") {
    const m = document.createElement("div");
    m.className = "metrics";
    const parts = ["<span>可用 <b>" + row.available + "</b></span>"];
    if (row.status === "shortage") {
      parts.push(`<span class="metric-consumed">已消耗 <b>${row.consumed}</b></span>`);
      parts.push(`<span class="metric-short">短缺 <b>${row.shortage}</b></span>`);
    } else if (row.status !== "error") {
      parts.push(`<span class="metric-consumed">消耗 <b>${row.consumed}</b></span>`);
      parts.push(`<span class="metric-produced">产出 <b>${row.produced}</b></span>`);
      parts.push(`<span class="metric-remaining">剩余 <b>${row.remaining}</b></span>`);
      if (row.unconsumed) {
        parts.push(`<span class="metric-unused">未消耗 <b>${row.unconsumed}</b></span>`);
      }
    }
    m.innerHTML = parts.join("");
    card.appendChild(m);
  }

  if (row.stitch_net != null) {
    card.appendChild(renderStitchChanges(row, source));
  }

  if (row.error) {
    const msg = document.createElement("div");
    msg.className = "msg";
    msg.textContent = row.error;
    card.appendChild(msg);
  }

  if (row.expanded_count > 0) {
    const det = document.createElement("details");
    det.className = "expanded";
    det.innerHTML = `<summary>展开指令（共 ${row.expanded_count} 条）</summary>`;
    const list = document.createElement("div");
    list.className = "token-list";
    list.innerHTML = row.expanded_preview
      .map((t) => `<span class="tok">${escapeHtml(t)}</span>`).join("");
    det.appendChild(list);
    if (row.expanded_truncated) {
      const note = document.createElement("div");
      note.className = "trunc-note";
      note.textContent = `仅预览前 ${row.expanded_preview.length} 条，共 ${row.expanded_count} 条。`;
      det.appendChild(note);
    }
    card.appendChild(det);
  }

  return card;
}

// ---------------------------------------------------------------- 方案对照
// 对齐与首个分歧定位的纯逻辑在 compare.js（alignRows / rowEndStitches /
// findFirstDivergence），此处只负责渲染。
const DIFF_TYPE_TEXT = { unchanged: "未变", modified: "修改", added: "新增", deleted: "删除" };

function cmpStatusCell(row, analyzeErr) {
  if (analyzeErr) return `<span class="cmp-fail" title="${escapeHtml(analyzeErr)}">分析失败</span>`;
  if (!row) return '<span class="cmp-absent">—</span>';
  return `<span class="cmp-status ${row.status}">${STATUS_TEXT[row.status] || row.status}</span>`;
}

function cmpEndCell(row, analyzeErr) {
  if (analyzeErr) return '<span class="cmp-absent">—</span>';
  const end = rowEndStitches(row);
  return end == null ? '<span class="cmp-absent">—</span>' : `<b>${end}</b>`;
}

function cmpSideCells(idx, text, results, analyzeErr) {
  const row = results ? results[idx] : null;
  return (
    `<td class="cmp-no">第 ${idx + 1} 行</td>` +
    `<td class="cmp-text">${escapeHtml(text) || '<span class="cmp-absent">（空行）</span>'}</td>` +
    `<td>${cmpStatusCell(row, analyzeErr)}</td>` +
    `<td class="cmp-end">${cmpEndCell(row, analyzeErr)}</td>`
  );
}

function renderCompare() {
  if (!baseline) {
    els.comparePanel.hidden = true;
    return;
  }
  els.comparePanel.hidden = false;

  const items = alignRows(baseline.rows, state.rows);
  const counts = { unchanged: 0, modified: 0, added: 0, deleted: 0 };
  items.forEach((it) => { counts[it.type] += 1; });

  // 首个双方都有行且状态或行末针数不同的位置（缺席行不参与判定）
  const firstDiff = findFirstDivergence(items, baselineRows, currentRows);

  const badges = [];
  badges.push(`基线 起始 <b>${baseline.start_stitches}</b> 针 · <b>${baseline.rows.length}</b> 行`);
  badges.push(`当前 起始 <b>${state.start_stitches}</b> 针 · <b>${state.rows.length}</b> 行`);
  if (baseline.start_stitches !== state.start_stitches) {
    badges.push('<span class="warn-text">⚠️ 起始针数不同</span>');
  }
  badges.push(`未变 <b>${counts.unchanged}</b>`);
  if (counts.modified) badges.push(`修改 <b>${counts.modified}</b>`);
  if (counts.added) badges.push(`新增 <b>${counts.added}</b>`);
  if (counts.deleted) badges.push(`删除 <b>${counts.deleted}</b>`);
  if (currentErr || baselineErr) {
    const which = currentErr && baselineErr ? "两侧" : (currentErr ? "当前侧" : "基线侧");
    badges.push(`<span class="err-text">⚠️ ${which}分析失败，已展示另一侧结果</span>`);
  } else if (firstDiff >= 0) {
    const it = items[firstDiff];
    badges.push(`⚑ 首个分歧：基线第 <b>${it.baseIdx + 1}</b> 行 ↔ 当前第 <b>${it.curIdx + 1}</b> 行`);
  } else {
    badges.push("两版共有行的状态与行末针数一致");
  }
  els.compareSummary.innerHTML = badges.map((b) => `<span class="badge">${b}</span>`).join("");
  els.compareState.textContent = (currentErr || baselineErr) ? "部分分析失败" : "";
  els.compareState.className = "sync-state" + ((currentErr || baselineErr) ? " error" : "");

  const trs = items.map((it, k) => {
    const isFirst = k === firstDiff;
    const typeTag = isFirst
      ? `<span class="cmp-type ${it.type}">⚑ 首个分歧</span>`
      : `<span class="cmp-type ${it.type}">${DIFF_TYPE_TEXT[it.type]}</span>`;
    const baseCells = it.baseIdx != null
      ? cmpSideCells(it.baseIdx, baseline.rows[it.baseIdx], baselineRows, baselineErr)
      : '<td colspan="4" class="cmp-absent">（基线无此行）</td>';
    const curCells = it.curIdx != null
      ? cmpSideCells(it.curIdx, state.rows[it.curIdx], currentRows, currentErr)
      : '<td colspan="4" class="cmp-absent">（当前无此行）</td>';
    return `<tr class="t-${it.type}${isFirst ? " first-diff" : ""}">`
      + `<td>${typeTag}</td>${baseCells}${curCells}</tr>`;
  });

  els.compareTableWrap.innerHTML =
    '<table class="cmp-table"><thead>' +
    '<tr><th rowspan="2">变更</th><th colspan="4">基线</th><th colspan="4">当前</th></tr>' +
    '<tr><th>行</th><th>文本</th><th>状态</th><th>行末针数</th>' +
    '<th>行</th><th>文本</th><th>状态</th><th>行末针数</th></tr>' +
    `</thead><tbody>${trs.join("")}</tbody></table>`;
}

// ---------------------------------------------------------------- 尺码联检
// 分化行定位的纯逻辑在 sizes.js（findSizeDivergenceRow），此处负责尺码编辑、
// 联检请求与行×尺码矩阵渲染。联检为手动触发；结果展示期间方案或尺码再被修改
// 时，矩阵标记为「已过期」，需重新点击「开始联检」。
function markSizesStale() {
  if (!sizesResult || sizesStale) return;
  sizesStale = true;
  els.sizesState.textContent = "方案或尺码已修改，联检结果已过期，请重新联检";
  els.sizesState.className = "sync-state pending";
  els.sizesMatrixWrap.classList.add("stale");
}

function renderSizesEditor() {
  els.sizesEditor.innerHTML = "";
  sizes.forEach((sz, i) => {
    const wrap = document.createElement("div");
    wrap.className = "size-edit";

    const name = document.createElement("input");
    name.type = "text";
    name.value = sz.name;
    name.placeholder = "名称，如 S";
    name.maxLength = 20;
    name.setAttribute("aria-label", `尺码 ${i + 1} 名称`);
    name.addEventListener("input", () => {
      sizes[i].name = name.value;
      persistSizes();
      markSizesStale();
    });

    const start = document.createElement("input");
    start.type = "number";
    start.min = "0";
    start.step = "1";
    start.value = sz.start_stitches;
    start.title = "起始针数";
    start.setAttribute("aria-label", `尺码 ${i + 1} 起始针数`);
    start.addEventListener("input", () => {
      const v = Number(start.value);
      sizes[i].start_stitches = Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
      persistSizes();
      markSizesStale();
    });

    const del = miniBtn("删除", "删除该尺码", () => {
      if (sizes.length <= 2) return;
      sizes.splice(i, 1);
      renderSizesEditor();
      persistSizes();
      markSizesStale();
    });
    del.classList.add("danger");
    del.disabled = sizes.length <= 2;

    wrap.append(name, start, del);
    els.sizesEditor.appendChild(wrap);
  });
  els.btnAddSize.disabled = sizes.length >= 8;
}

els.btnAddSize.addEventListener("click", () => {
  if (sizes.length >= 8) return;
  const last = sizes[sizes.length - 1];
  sizes.push({ name: "", start_stitches: last ? last.start_stitches + 4 : 20 });
  renderSizesEditor();
  persistSizes();
  markSizesStale();
  const inputs = els.sizesEditor.querySelectorAll(".size-edit input[type='text']");
  if (inputs.length) inputs[inputs.length - 1].focus();
});

function validateSizes() {
  if (sizes.length < 2 || sizes.length > 8) return "尺码数量需为 2～8 个";
  const names = sizes.map((s) => s.name.trim());
  if (names.some((n) => !n)) return "尺码名称不能为空";
  if (new Set(names).size !== names.length) return "尺码名称不能重复";
  if (sizes.some((s) => !Number.isInteger(s.start_stitches) || s.start_stitches < 0)) {
    return "各尺码起始针数需为非负整数";
  }
  return null;
}

els.btnRunSizes.addEventListener("click", async () => {
  const invalid = validateSizes();
  if (invalid) {
    els.sizesHint.textContent = invalid;
    els.sizesHint.className = "sizes-hint error";
    return;
  }
  els.sizesHint.textContent = "";
  els.sizesHint.className = "sizes-hint";
  els.sizesState.textContent = "联检中…";
  els.sizesState.className = "sync-state pending";
  const seq = ++sizesReqSeq;
  try {
    const resp = await fetch("/api/sizes/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sizes: sizes.map((s) => ({ name: s.name.trim(), start_stitches: s.start_stitches })),
        rows: state.rows,
      }),
    });
    if (!resp.ok) throw new Error(`服务返回 ${resp.status}`);
    const data = await resp.json();
    if (seq !== sizesReqSeq) return; // 已有更新的联检请求，丢弃过期响应
    sizesResult = { sizes: data.sizes, rowTexts: [...state.rows] };
    sizesErr = null;
    sizesStale = false;
    selectedCell = null;
  } catch (err) {
    if (seq !== sizesReqSeq) return;
    sizesErr = err.message;
  }
  renderSizesMatrix();
});

// 点击矩阵单元格：定位源行（编辑区闪烁）并展示该尺码本行的错误细节。
function flashEditorRow(i) {
  const el = els.editor.querySelector(`.row-edit[data-row-index="${i}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  el.classList.remove("flash");
  void el.offsetWidth; // 重新触发动画
  el.classList.add("flash");
}

function renderSizesMatrix() {
  els.sizesMatrixWrap.classList.toggle("stale", sizesStale || !!(sizesErr && sizesResult));
  els.sizesDetail.innerHTML = "";

  if (sizesErr && !sizesResult) {
    els.sizesSummary.innerHTML = "";
    els.sizesMatrixWrap.innerHTML = "";
    els.sizesState.textContent = "联检失败：" + sizesErr;
    els.sizesState.className = "sync-state error";
    return;
  }
  if (!sizesResult) {
    els.sizesSummary.innerHTML = "";
    els.sizesMatrixWrap.innerHTML =
      '<div class="empty-hint">录入 2～8 个尺码后点击「开始联检」，此处将显示行×尺码矩阵。</div>';
    els.sizesState.textContent = "";
    els.sizesState.className = "sync-state";
    return;
  }

  const szs = sizesResult.sizes;
  const rowTexts = sizesResult.rowTexts;
  const divRow = findSizeDivergenceRow(szs);

  const badges = [];
  badges.push(`尺码 <b>${szs.length}</b> 个`);
  badges.push(`行数 <b>${rowTexts.length}</b>`);
  szs.forEach((sz) => {
    const last = sz.rows[sz.rows.length - 1];
    const end = rowEndStitches(last);
    badges.push(`${escapeHtml(sz.name)} 最终针数 <b>${end == null ? "—" : end}</b>`);
  });
  if (divRow >= 0) {
    badges.push(`<span class="warn-text">⚑ 首个尺码分化：第 ${divRow + 1} 行</span>`);
  } else if (rowTexts.length > 0) {
    badges.push("各尺码逐行状态一致（行末针数差异不算分化）");
  }
  els.sizesSummary.innerHTML = badges.map((b) => `<span class="badge">${b}</span>`).join("");

  els.sizesState.textContent = sizesErr
    ? `本次联检失败：${sizesErr}（以下为上次成功结果）`
    : (sizesStale ? "方案或尺码已修改，联检结果已过期，请重新联检" : "联检完成");
  els.sizesState.className = "sync-state" + (sizesErr ? " error" : (sizesStale ? " pending" : ""));

  if (rowTexts.length === 0) {
    els.sizesMatrixWrap.innerHTML = '<div class="empty-hint">当前方案没有任何行。</div>';
    return;
  }

  let html = '<table class="size-matrix"><thead><tr><th>行</th><th>指令</th>';
  szs.forEach((sz) => {
    html += `<th>${escapeHtml(sz.name)}<span class="size-start">起始 ${sz.start_stitches} 针</span></th>`;
  });
  html += "</tr></thead><tbody>";
  for (let i = 0; i < rowTexts.length; i++) {
    const isDiff = i === divRow;
    html += `<tr${isDiff ? ' class="size-diff"' : ""}>`;
    html += `<td class="cmp-no">第 ${i + 1} 行`
      + (isDiff ? ' <span class="diff-flag">⚑ 首个分化</span>' : "") + "</td>";
    html += `<td class="cmp-text">${escapeHtml(rowTexts[i]) || '<span class="cmp-absent">（空行）</span>'}</td>`;
    szs.forEach((sz, si) => {
      const row = sz.rows[i];
      const avail = row.status === "blocked" ? "—" : row.available;
      const end = rowEndStitches(row);
      const sel = selectedCell && selectedCell.sizeIdx === si && selectedCell.rowIdx === i;
      html += `<td class="size-cell ${row.status}${sel ? " selected" : ""}"`
        + ` data-size="${si}" data-row="${i}" title="点击查看尺码 ${escapeHtml(sz.name)} 本行详情">`
        + `<span class="cmp-status ${row.status}">${STATUS_TEXT[row.status] || row.status}</span>`
        + `<span class="size-nums">可用 <b>${avail}</b> · 行末 <b>${end == null ? "—" : end}</b></span>`
        + "</td>";
    });
    html += "</tr>";
  }
  html += "</tbody></table>";
  els.sizesMatrixWrap.innerHTML = html;

  els.sizesMatrixWrap.querySelectorAll(".size-cell").forEach((td) => {
    td.addEventListener("click", () => {
      selectedCell = { sizeIdx: Number(td.dataset.size), rowIdx: Number(td.dataset.row) };
      els.sizesMatrixWrap.querySelectorAll(".size-cell.selected")
        .forEach((c) => c.classList.remove("selected"));
      td.classList.add("selected");
      renderSizesDetail();
      flashEditorRow(selectedCell.rowIdx);
    });
  });
  renderSizesDetail();
}

// 详情卡：尺码 + 行号 + 该尺码本行的完整审校卡片（源文本高亮、指标、错误信息）。
function renderSizesDetail() {
  els.sizesDetail.innerHTML = "";
  if (!selectedCell || !sizesResult) return;
  const sz = sizesResult.sizes[selectedCell.sizeIdx];
  const row = sz && sz.rows ? sz.rows[selectedCell.rowIdx] : null;
  if (!sz || !row) return;

  const head = document.createElement("div");
  head.className = "sizes-detail-head";
  head.innerHTML = `尺码 <b>${escapeHtml(sz.name)}</b>（起始 ${sz.start_stitches} 针）· `
    + `第 ${selectedCell.rowIdx + 1} 行 · 已在左侧编辑区定位源行`;
  els.sizesDetail.appendChild(head);
  els.sizesDetail.appendChild(renderCard(row, selectedCell.rowIdx));
}

// ---------------------------------------------------------------- 导入导出
els.btnExample.addEventListener("click", () => {
  state = { start_stitches: EXAMPLE.start_stitches, rows: [...EXAMPLE.rows] };
  renderEditor();
  persist();
  scheduleAnalyze();
});

els.btnExport.addEventListener("click", () => {
  const plan = {
    format: "knit-row-review/v1",
    name: "编织方案",
    start_stitches: state.start_stitches,
    rows: state.rows,
    exported_at: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `knit-plan-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

els.btnImport.addEventListener("click", () => els.file.click());

els.file.addEventListener("change", () => {
  const file = els.file.files && els.file.files[0];
  els.file.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const obj = JSON.parse(String(reader.result));
      if (typeof obj.start_stitches !== "number" || !Number.isInteger(obj.start_stitches)
          || obj.start_stitches < 0 || !Array.isArray(obj.rows)
          || !obj.rows.every((r) => typeof r === "string")) {
        throw new Error("缺少 start_stitches（非负整数）或 rows（字符串数组）");
      }
      state = { start_stitches: obj.start_stitches, rows: obj.rows };
      renderEditor();
      persist();
      scheduleAnalyze();
    } catch (err) {
      alert("导入失败：" + err.message);
    }
  };
  reader.readAsText(file);
});

// ---------------------------------------------------------------- 启动
renderEditor();
updateBaselineBar();
renderSizesEditor();
renderSizesMatrix();
scheduleAnalyze();
