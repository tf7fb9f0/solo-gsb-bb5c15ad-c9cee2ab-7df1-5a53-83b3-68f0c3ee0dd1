'use strict';

/* 交接冲突修复预演接口集成测试：node test/repair-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP 全流程。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-repair-api-store.json');
process.env.DATA_FILE = DATA_FILE;

for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
  try { fs.unlinkSync(f); } catch { /* 不存在则忽略 */ }
}

const app = require('../server');

let server;
let base;
let passed = 0;

async function api(url, options = {}) {
  const res = await fetch(`${base}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function main() {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  // 初始演示数据：折扇 p_fan（第5分歧义冲突）、宫灯 p_lantern（第4分断链冲突）、
  // 青龙剑 p_sword（完整归仓链）、御印 p_seal（未归仓，无冲突）
  const state0 = (await api('/api/state')).body;
  assert.ok(state0.props.some((p) => p.id === 'p_fan'));

  // 1. 歧义冲突道具：逐条删除可接续记录，候选整链无冲突并给出未归仓状态
  await test('歧义冲突（折扇）：返回逐条删除候选与最终持有人、未归仓状态', async () => {
    const res = await api('/api/repair/preview?propId=p_fan');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.propName, '折扇');
    assert.strictEqual(res.body.conflict.type, 'AMBIGUOUS');
    assert.strictEqual(res.body.conflict.minute, 5);
    assert.strictEqual(res.body.conflict.holder, '张三');
    assert.strictEqual(res.body.candidates.length, 2);
    assert.ok(res.body.candidates.every((c) => c.kind === 'DELETE'));
    assert.ok(res.body.candidates.every((c) => c.statusAfter === 'NOT_RETURNED' && !c.returned));
    const byTo = new Map(res.body.candidates.map((c) => [c.record.to, c]));
    assert.strictEqual(byTo.get('王五').holderAfter, '赵六'); // 删 张三→王五 后归赵六
    assert.strictEqual(byTo.get('赵六').holderAfter, '王五'); // 删 张三→赵六 后归王五
    assert.deepStrictEqual(
      res.body.candidates.map((c) => c.record.id).sort(),
      ['r_fa2', 'r_fa3']
    );
    assert.deepStrictEqual([res.body.summary.tried, res.body.summary.workable], [2, 2]);
  });

  // 2. 断链冲突道具：删除不可行，给出「交出者改为冲突前持有人」候选且修复后归仓
  await test('断链冲突（宫灯）：返回修改交出者候选，修复后归仓', async () => {
    const res = await api('/api/repair/preview?propId=p_lantern');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.conflict.type, 'BROKEN');
    assert.strictEqual(res.body.conflict.minute, 4);
    assert.strictEqual(res.body.conflict.holder, '王五');
    assert.strictEqual(res.body.candidates.length, 1);
    const c = res.body.candidates[0];
    assert.strictEqual(c.kind, 'EDIT_FROM');
    assert.strictEqual(c.record.id, 'r_la2');
    assert.strictEqual(c.record.from, '李四');
    assert.strictEqual(c.newFrom, '王五');
    assert.strictEqual(c.holderAfter, '仓库');
    assert.strictEqual(c.returned, true);
    assert.strictEqual(c.statusAfter, 'RETURNED');
    assert.deepStrictEqual([res.body.summary.tried, res.body.summary.workable], [2, 1]);
  });

  // 3. 无可行单条修复：候选全部重放仍冲突，明确提示
  await test('无可行单条修复：明确提示且不返回方案', async () => {
    // 为御印补两条断链记录：第9分 钱七→赵六（当前持有人孙七）、第10分 甲→乙
    for (const body of [
      { propId: 'p_seal', minute: 9, from: '钱七', to: '赵六' },
      { propId: 'p_seal', minute: 10, from: '甲', to: '乙' },
    ]) {
      const add = await api('/api/records', { method: 'POST', body: JSON.stringify(body) });
      assert.strictEqual(add.status, 201);
    }
    const res = await api('/api/repair/preview?propId=p_seal');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.conflict.type, 'BROKEN');
    assert.strictEqual(res.body.conflict.minute, 9);
    // 删 钱七→赵六：第10分 甲→乙 断链；改交出者为孙七：第10分仍断链
    assert.strictEqual(res.body.candidates.length, 0);
    assert.ok(/没有可行的单条修复方案/.test(res.body.message));
  });

  // 4. 无冲突道具：明确提示无需修复
  await test('无冲突道具（青龙剑）：提示无需修复', async () => {
    const res = await api('/api/repair/preview?propId=p_sword');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.conflict, null);
    assert.strictEqual(res.body.candidates.length, 0);
    assert.ok(/无需修复/.test(res.body.message));
  });

  // 5. 参数校验：缺 propId -> 400；道具不存在 -> 404
  await test('参数校验：缺道具 400，道具不存在 404', async () => {
    const missing = await api('/api/repair/preview');
    assert.strictEqual(missing.status, 400);
    const notFound = await api('/api/repair/preview?propId=p_不存在');
    assert.strictEqual(notFound.status, 404);
  });

  // 6. 预演只读：多次调用前后数据版本与记录数不变
  await test('预演只读：数据版本与记录数不变', async () => {
    const before = (await api('/api/state')).body;
    for (const propId of ['p_fan', 'p_lantern', 'p_seal', 'p_sword']) {
      const res = await api(`/api/repair/preview?propId=${propId}`);
      assert.strictEqual(res.status, 200);
    }
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, before.rev);
    assert.strictEqual(after.records.length, before.records.length);
  });

  server.close();
  for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个修复预演接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
