'use strict';

/* 交接冲突修复预演引擎单元测试：node test/repair.test.js */

const assert = require('assert');
const { previewRepairs, CHANGE } = require('../src/repair');
const { WAREHOUSE } = require('../src/verify');

let seq = 0;
const t = (n) => 1000 + n; // 录入先后用递增 createdAt 表示

function mkData(props, records) {
  return {
    props: props.map((name, i) => ({ id: `p${i}`, name, note: '', createdAt: t(seq++) })),
    records,
  };
}
function rec(propId, minute, from, to) {
  return { id: `r${seq++}`, propId, minute, from, to, note: '', createdAt: t(seq) };
}

let passed = 0;
function test(name, fn) {
  seq = 0;
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 1. 歧义冲突：逐条尝试删除可接续记录，候选给出最终持有人与未归仓状态
test('歧义冲突：逐条删除可接续记录，列出最终持有人与未归仓状态', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'),
  ]);
  const r = previewRepairs(data, 'p0');
  assert.strictEqual(r.propName, '扇');
  assert.strictEqual(r.conflict.type, 'AMBIGUOUS');
  assert.strictEqual(r.conflict.minute, 5);
  assert.strictEqual(r.conflict.holder, '张三');
  assert.strictEqual(r.candidates.length, 2);
  assert.ok(r.candidates.every((c) => c.kind === CHANGE.DELETE));
  // 删除 张三→王五：链为 仓库→张三→赵六，结束未归仓（赵六）
  const c1 = r.candidates.find((c) => c.record.to === '王五');
  assert.strictEqual(c1.holderAfter, '赵六');
  assert.strictEqual(c1.returned, false);
  assert.strictEqual(c1.statusAfter, 'NOT_RETURNED');
  assert.ok(/未归仓/.test(c1.note));
  // 删除 张三→赵六：链为 仓库→张三→王五，结束未归仓（王五）
  const c2 = r.candidates.find((c) => c.record.to === '赵六');
  assert.strictEqual(c2.holderAfter, '王五');
  assert.strictEqual(c2.returned, false);
  assert.deepStrictEqual([r.summary.tried, r.summary.workable], [2, 2]);
  assert.strictEqual(r.message, null);
});

// 2. 歧义冲突：删除后更晚分钟仍冲突的候选被过滤（重放全部记录，仅展示整链无冲突方案）
test('歧义冲突：删除后更晚分钟仍冲突的候选被过滤', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'),
    rec('p0', 9, '王五', WAREHOUSE),
  ]);
  const r = previewRepairs(data, 'p0');
  // 删 张三→王五：第9分 王五→仓库 时持有人为赵六，断链 → 过滤
  // 删 张三→赵六：仓库→张三→王五→仓库，整链归仓
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].record.to, '赵六');
  assert.strictEqual(r.candidates[0].holderAfter, WAREHOUSE);
  assert.strictEqual(r.candidates[0].returned, true);
  assert.strictEqual(r.candidates[0].statusAfter, 'RETURNED');
  assert.deepStrictEqual([r.summary.tried, r.summary.workable], [2, 1]);
});

// 3. 断链冲突：删除不可行时给出「交出者改为冲突前持有人」候选
test('断链冲突：删除候选不可行时给出修改交出者候选', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五'),
    rec('p0', 4, '李四', '钱七'),
    rec('p0', 9, '钱七', WAREHOUSE),
  ]);
  const r = previewRepairs(data, 'p0');
  assert.strictEqual(r.conflict.type, 'BROKEN');
  assert.strictEqual(r.conflict.minute, 4);
  assert.strictEqual(r.conflict.holder, '王五');
  // 删 李四→钱七：第9分 钱七→仓库 时持有人为王五，断链 → 过滤
  // 改交出者 李四→王五：仓库→王五→钱七→仓库，整链归仓
  assert.strictEqual(r.candidates.length, 1);
  const c = r.candidates[0];
  assert.strictEqual(c.kind, CHANGE.EDIT_FROM);
  assert.strictEqual(c.record.from, '李四');
  assert.strictEqual(c.newFrom, '王五');
  assert.strictEqual(c.holderAfter, WAREHOUSE);
  assert.strictEqual(c.returned, true);
  assert.deepStrictEqual([r.summary.tried, r.summary.workable], [2, 1]);
});

// 4. 断链冲突：修改交出者不得与接收者相同（该修改候选直接跳过）
test('断链冲突：接收者恰为冲突前持有人时跳过修改交出者候选', () => {
  const data = mkData(['旗'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 3, '李四', '张三'), // 接收者 = 冲突前持有人，交出者改张三会与接收者相同
  ]);
  const r = previewRepairs(data, 'p0');
  assert.strictEqual(r.conflict.type, 'BROKEN');
  // 只剩删除候选：删除后链完整（仓库→张三），张三未归仓
  assert.strictEqual(r.summary.tried, 1);
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].kind, CHANGE.DELETE);
  assert.strictEqual(r.candidates[0].holderAfter, '张三');
  assert.strictEqual(r.candidates[0].statusAfter, 'NOT_RETURNED');
});

// 5. 断链冲突：同分钟多条剩余记录逐条枚举（删除 / 改交出者各逐条尝试）
test('断链冲突：同分钟多条剩余记录逐条枚举，可行者接续成链', () => {
  const data = mkData(['锣'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 3, '李四', '王五'),
    rec('p0', 3, '王五', WAREHOUSE),
  ]);
  const r = previewRepairs(data, 'p0');
  assert.strictEqual(r.conflict.type, 'BROKEN');
  // 当分钟剩余 2 条：删 r2 / 改 r2 / 删 r3 / 改 r3 共 4 种；
  // 仅「李四→王五 的交出者改为张三」可行：张三→王五→仓库 同分钟链式接续
  assert.strictEqual(r.summary.tried, 4);
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].kind, CHANGE.EDIT_FROM);
  assert.strictEqual(r.candidates[0].newFrom, '张三');
  assert.strictEqual(r.candidates[0].holderAfter, WAREHOUSE);
  assert.strictEqual(r.candidates[0].returned, true);
});

// 6. 无可行单条修复：所有候选重放后仍冲突，明确提示
test('无可行单条修复：候选全部重放仍冲突时明确提示', () => {
  const data = mkData(['鼓'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 3, '李四', '王五'),
    rec('p0', 5, '钱七', '赵六'),
  ]);
  const r = previewRepairs(data, 'p0');
  assert.strictEqual(r.conflict.type, 'BROKEN');
  // 删 李四→王五：第5分 钱七→赵六 断链；改交出者为张三：第5分仍断链
  assert.strictEqual(r.candidates.length, 0);
  assert.deepStrictEqual([r.summary.tried, r.summary.workable], [2, 0]);
  assert.ok(/没有可行的单条修复方案/.test(r.message));
});

// 7. 同分钟多条断链剩余记录：单条改动无法同时修复两条断链
test('同分钟两条断链剩余记录：单条改动均无法修复，明确提示', () => {
  const data = mkData(['鼓'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 3, '李四', '王五'),
    rec('p0', 3, '钱七', '孙七'),
  ]);
  const r = previewRepairs(data, 'p0');
  // 删/改任一条，另一条仍在当分钟断链 → 无可行方案
  assert.strictEqual(r.summary.tried, 4);
  assert.strictEqual(r.candidates.length, 0);
  assert.ok(/没有可行的单条修复方案/.test(r.message));
});

// 8. 无冲突道具：无需修复
test('无冲突道具：明确提示无需修复', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 4, '张三', WAREHOUSE),
  ]);
  const r = previewRepairs(data, 'p0');
  assert.strictEqual(r.conflict, null);
  assert.strictEqual(r.candidates.length, 0);
  assert.ok(/无需修复/.test(r.message));
});

// 9. 预演只读：不改写传入数据；道具不存在返回 null
test('预演只读：传入数据不被修改；道具不存在返回 null', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五'),
    rec('p0', 4, '李四', '钱七'),
  ]);
  const snapshot = JSON.stringify(data);
  previewRepairs(data, 'p0');
  assert.strictEqual(JSON.stringify(data), snapshot);
  assert.strictEqual(previewRepairs(data, 'p_不存在'), null);
});

console.log(`\n全部 ${passed} 个修复预演引擎测试通过 ✔`);
