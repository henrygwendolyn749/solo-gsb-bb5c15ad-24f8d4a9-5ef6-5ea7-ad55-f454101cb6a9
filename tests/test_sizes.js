"use strict";

/* 尺码联检纯逻辑（app/static/sizes.js）的 Node 单元测试。
 * 运行：node tests/test_sizes.js
 */

const assert = require("node:assert/strict");
const { findFirstSizeDivergence } = require("../app/static/sizes.js");

const ok = (remaining) => ({ status: "ok", remaining });
const unc = (remaining) => ({ status: "unconsumed", remaining });
const shortage = { status: "shortage", remaining: 0 };
const error = { status: "error", remaining: 0 };
const blocked = { status: "blocked", remaining: 0 };

// ---------------------------------------------------------------- 无分化
// 全部尺码状态一致
assert.equal(findFirstSizeDivergence([[ok(20), ok(20)], [ok(24), ok(24)]]), -1);

// 行末针数不同但状态相同：起始针数造成的针数差异本身不算分化
assert.equal(findFirstSizeDivergence([[ok(20)], [ok(24)], [ok(30)]]), -1);

// 行数为空
assert.equal(findFirstSizeDivergence([[], []]), -1);

// 尺码不足 2 个 / 入参非法
assert.equal(findFirstSizeDivergence([[ok(1)]]), -1);
assert.equal(findFirstSizeDivergence([]), -1);
assert.equal(findFirstSizeDivergence(null), -1);

// ---------------------------------------------------------------- 分化定位
// 同一行未阻断尺码状态不同（ok vs 未全部消耗）
assert.equal(findFirstSizeDivergence([[ok(20), ok(20)], [ok(24), unc(24)]]), 1);

// 首个分化行取最靠前的一行
assert.equal(
  findFirstSizeDivergence([
    [ok(1), shortage, blocked, blocked],
    [ok(1), ok(2), unc(3), ok(4)],
  ]),
  1,
);

// 第 1 行即分化
assert.equal(findFirstSizeDivergence([[shortage], [ok(2)]]), 0);

// 短缺 vs 语法错误：两者都未阻断但状态不同，也算分化
assert.equal(findFirstSizeDivergence([[ok(1), shortage], [ok(1), error]]), 1);

// ---------------------------------------------------------------- 阻断行不参与判定
// 某尺码语法错误只阻断自己：error 行分化，其后 blocked 行不再参与
assert.equal(
  findFirstSizeDivergence([
    [ok(1), error, blocked, blocked],
    [ok(1), ok(2), ok(3), ok(4)],
  ]),
  1,
);

// 单侧阻断后只剩一个未阻断尺码，不再出现分化
assert.equal(
  findFirstSizeDivergence([
    [ok(1), shortage, blocked, blocked],
    [ok(1), ok(2), ok(3), ok(4)],
  ]),
  1, // 分化仅发生在第 2 行（shortage vs ok），之后 S 已阻断
);

// 全部尺码在同一行都阻断：没有未阻断尺码，不算分化
assert.equal(findFirstSizeDivergence([[ok(1), blocked], [ok(1), blocked]]), -1);

// 一个尺码阻断、其余未阻断尺码之间状态不同 → 仍算分化
assert.equal(
  findFirstSizeDivergence([
    [ok(1), blocked],
    [ok(1), ok(2)],
    [ok(1), unc(2)],
  ]),
  1,
);

console.log("sizes.js 全部用例通过");
