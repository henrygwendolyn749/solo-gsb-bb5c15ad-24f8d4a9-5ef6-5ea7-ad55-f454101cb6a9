"use strict";

/* 尺码联检纯逻辑：首个尺码分化行定位。
 * 本文件不依赖 DOM，既被前端页面引用，也可在 Node 中直接 require 做单元测试。
 *
 * 分化判定：同一行中，未被阻断（status !== "blocked"）的尺码出现两种及以上
 * 不同状态时，该行即为尺码分化行。仅比较状态——起始针数不同造成的行末针数
 * 差异本身不算分化；已阻断的尺码不参与该行的判定。
 */

/**
 * 首个尺码分化行的下标（0 基）；没有则返回 -1。
 * @param {Array<{rows: Array<{status: string}>}>} sizesResults
 *   各尺码的逐行审校结果（元素为 { rows: RowResult[] }，与 /api/sizes/analyze
 *   响应中 sizes 数组的元素结构一致）。
 * @returns {number} 首个分化行下标；无分化或输入为空时返回 -1。
 */
function findSizeDivergenceRow(sizesResults) {
  if (!Array.isArray(sizesResults) || sizesResults.length === 0) return -1;
  const rowCount = Math.max(...sizesResults.map((s) => (s && s.rows ? s.rows.length : 0)));
  for (let i = 0; i < rowCount; i++) {
    const seen = new Set();
    for (const sz of sizesResults) {
      const row = sz && sz.rows ? sz.rows[i] : null;
      if (!row || row.status === "blocked") continue;
      seen.add(row.status);
      if (seen.size > 1) return i;
    }
  }
  return -1;
}

// Node 环境下导出，便于单元测试；浏览器中作为全局函数使用。
if (typeof module !== "undefined" && module.exports) {
  module.exports = { findSizeDivergenceRow };
}
