"use strict";

/* 尺码联检纯逻辑（app/static/sizes.js）的 Node 单元测试。
 * 运行：node tests/test_sizes.js
 */

const assert = require("node:assert/strict");
const { findSizeDivergenceRow } = require("../app/static/sizes.js");

// 构造一个尺码的逐行结果：statuses 为状态数组，行末针数另行指定
const mkSize = (statuses, ends) => ({
  rows: statuses.map((status, i) => ({
    status,
    remaining: ends && ends[i] != null ? ends[i] : 0,
  })),
});

// ---------------------------------------------------------------- 无分化
// 空输入 / 空行
assert.equal(findSizeDivergenceRow([]), -1);
assert.equal(findSizeDivergenceRow([mkSize([]), mkSize([])]), -1);

// 状态全同：仅行末针数不同（起始针数差异所致）不算分化
assert.equal(
  findSizeDivergenceRow([
    mkSize(["ok", "ok"], [20, 16]),
    mkSize(["ok", "ok"], [24, 20]),
    mkSize(["ok", "ok"], [28, 24]),
  ]),
  -1,
);

// 状态全同（含未全部消耗 / 短缺 / 语法错误同时出现在各尺码同一行）不算分化
assert.equal(
  findSizeDivergenceRow([
    mkSize(["unconsumed", "shortage", "blocked"]),
    mkSize(["unconsumed", "shortage", "blocked"]),
  ]),
  -1,
);

// ---------------------------------------------------------------- 有分化
// 同一行未阻断尺码状态不同 -> 首个分化行
assert.equal(
  findSizeDivergenceRow([
    mkSize(["ok", "ok", "shortage", "blocked"]),
    mkSize(["ok", "ok", "ok", "ok"]),
  ]),
  2,
);

// 多个分化行时只取首个
assert.equal(
  findSizeDivergenceRow([
    mkSize(["ok", "shortage", "blocked", "error", "blocked"]),
    mkSize(["ok", "ok", "ok", "ok", "ok"]),
  ]),
  1,
);

// 语法错误与其余状态的差异也算分化（如自适应推导在某尺码失败）
assert.equal(
  findSizeDivergenceRow([
    mkSize(["error", "blocked"]),
    mkSize(["ok", "ok"]),
  ]),
  0,
);

// ---------------------------------------------------------------- 阻断不参与判定
// 一个尺码在某行已阻断，其余未阻断尺码状态一致 -> 无分化
assert.equal(
  findSizeDivergenceRow([
    mkSize(["shortage", "blocked", "blocked"]),
    mkSize(["shortage", "ok", "ok"]),
  ]),
  -1,
);

// 阻断尺码之外，其余未阻断尺码状态不同 -> 仍算分化
assert.equal(
  findSizeDivergenceRow([
    mkSize(["ok", "blocked", "blocked"]),
    mkSize(["ok", "ok", "unconsumed"]),
    mkSize(["ok", "ok", "ok"]),
  ]),
  2,
);

// 全部尺码在同一行都被阻断 -> 无未阻断尺码，不算分化
assert.equal(
  findSizeDivergenceRow([
    mkSize(["error", "blocked"]),
    mkSize(["error", "blocked"]),
  ]),
  -1,
);

// 某行只剩一个未阻断尺码 -> 无从比较，不算分化
assert.equal(
  findSizeDivergenceRow([
    mkSize(["ok", "blocked", "blocked"]),
    mkSize(["ok", "shortage", "blocked"]),
  ]),
  -1,
);

// 行数不一致（防御性）：缺失行按无结果跳过
assert.equal(
  findSizeDivergenceRow([
    mkSize(["ok", "ok"]),
    mkSize(["ok"]),
  ]),
  -1,
);

console.log("sizes.js 全部用例通过");
