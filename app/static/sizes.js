"use strict";

/* 尺码联检纯逻辑：首个尺码分化行定位。
 * 本文件不依赖 DOM，既被前端页面引用，也可在 Node 中直接 require 做单元测试。
 *
 * 分化判定规则：
 * - 每个尺码以各自起始针数独立审校同一份行指令；
 * - 某尺码「已阻断」（blocked，因前面行出错而无法确定针数）的行不参与判定；
 * - 同一行上，未阻断的尺码出现两种及以上不同状态时，该行即尺码分化行；
 * - 起始针数不同造成的行末针数差异本身不算分化（只比较状态，不比较针数）。
 */

/**
 * 首个尺码分化行下标（0 基）；没有则返回 -1。
 * @param {Array<Array<object>>} perSizeRows 每个尺码的逐行审校结果（与行指令一一对应）
 * @returns {number}
 */
function findFirstSizeDivergence(perSizeRows) {
  if (!Array.isArray(perSizeRows) || perSizeRows.length < 2) return -1;
  let rowCount = 0;
  perSizeRows.forEach((rows) => {
    if (Array.isArray(rows)) rowCount = Math.max(rowCount, rows.length);
  });
  for (let i = 0; i < rowCount; i++) {
    const seen = new Set();
    for (const rows of perSizeRows) {
      const row = Array.isArray(rows) ? rows[i] : null;
      if (!row || row.status === "blocked") continue; // 已阻断的尺码不参与判定
      seen.add(row.status);
      if (seen.size > 1) return i;
    }
  }
  return -1;
}

// Node 环境下导出，便于单元测试；浏览器中作为全局函数使用。
if (typeof module !== "undefined" && module.exports) {
  module.exports = { findFirstSizeDivergence };
}
