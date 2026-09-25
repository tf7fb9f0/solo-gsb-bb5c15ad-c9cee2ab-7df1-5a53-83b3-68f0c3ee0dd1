'use strict';

/**
 * 交接冲突修复预演引擎（只读，生成即时结果，不改写交接记录）。
 *
 * 针对一件交接链冲突的道具，围绕**首个冲突分钟**枚举**单条记录改动**候选：
 *
 * - 多条可接续（歧义）：逐条尝试**删除**可接续记录；
 * - 断链：对当分钟剩余记录逐条尝试**删除**，或把**交出者改为冲突前持有人**
 *   （不得与该记录的接收者相同，此类改动直接跳过）。
 *
 * 每个候选都按核验引擎的「同分钟唯一链」规则**重放该道具全部记录**
 * （含冲突分钟之后的记录），只有整链无冲突的候选才作为可行方案列出，
 * 并给出改动记录、修复后最终持有人与是否归仓；全部候选重放后仍冲突时，
 * 明确提示没有可行的单条修复方案。
 *
 * 预演只读：不改写任何交接记录，结果供人工核实后在记录表中自行编辑。
 */

const { WAREHOUSE, CONFLICT, STATUS, sortRecords, replayPropRecords } = require('./verify');

/** 单条改动方式 */
const CHANGE = {
  DELETE: 'DELETE',       // 删除该记录
  EDIT_FROM: 'EDIT_FROM', // 把交出者改为冲突前持有人
};

function recordRef(r) {
  return { id: r.id, minute: r.minute, from: r.from, to: r.to, note: r.note || '' };
}

function conflictTypeText(type) {
  return type === CONFLICT.AMBIGUOUS
    ? '多条可接续记录（交接链不唯一）'
    : '剩余记录无法接续（断链）';
}

/**
 * 围绕首个冲突分钟枚举单条记录改动候选。
 * @param {object} conflict 核验引擎返回的首个冲突（含 type/minute/holder/recordRefs）
 * @returns {Array<{kind: string, record: object, newFrom?: string}>}
 */
function enumerateChanges(conflict) {
  const refs = conflict.recordRefs || [];
  const changes = [];

  if (conflict.type === CONFLICT.AMBIGUOUS) {
    // 歧义：逐条尝试删除可接续记录
    for (const r of refs) {
      changes.push({ kind: CHANGE.DELETE, record: r });
    }
    return changes;
  }

  // 断链：对当分钟剩余记录逐条尝试删除，或把交出者改为冲突前持有人
  for (const r of refs) {
    changes.push({ kind: CHANGE.DELETE, record: r });
    // 交出者改为冲突前持有人时不得与接收者相同（与单条记录校验规则一致）
    if (r.to !== conflict.holder) {
      changes.push({ kind: CHANGE.EDIT_FROM, record: r, newFrom: conflict.holder });
    }
  }
  return changes;
}

/** 在该道具的记录集上应用单条改动（返回新数组，不改写原记录） */
function applyChange(records, change) {
  if (change.kind === CHANGE.DELETE) {
    return records.filter((r) => r.id !== change.record.id);
  }
  // 修改交出者：保留原记录其余字段与录入时间（与「修改记录」接口行为一致）
  return records.map((r) => (r.id === change.record.id ? { ...r, from: change.newFrom } : r));
}

function changeText(change) {
  if (change.kind === CHANGE.DELETE) return '删除该记录';
  return `交出者「${change.record.from}」改为「${change.newFrom}」`;
}

/**
 * 对一件道具执行冲突修复预演。
 * @param {{props: Array, records: Array}} data 当前数据（只读）
 * @param {string} propId 道具 id
 * @returns {object|null} 道具不存在时返回 null
 */
function previewRepairs(data, propId) {
  const props = data.props || [];
  const records = data.records || [];
  const prop = props.find((p) => p.id === propId);
  if (!prop) return null;

  const propRecords = sortRecords(records.filter((r) => r.propId === prop.id));
  const replay = replayPropRecords(propRecords);

  const base = { propId: prop.id, propName: prop.name, warehouse: WAREHOUSE };

  // 当前交接链无冲突：无需修复
  if (replay.ok) {
    return {
      ...base,
      conflict: null,
      candidates: [],
      summary: { tried: 0, workable: 0 },
      message: `道具「${prop.name}」当前交接链可完整重放，没有冲突，无需修复。`,
    };
  }

  const conflict = replay.conflict;
  const typeText = conflictTypeText(conflict.type);
  const changes = enumerateChanges(conflict);
  const candidates = [];

  for (const change of changes) {
    const modified = applyChange(propRecords, change);
    // 每个候选都按同分钟唯一链规则重放该道具全部记录（含冲突分钟之后）
    const reReplay = replayPropRecords(sortRecords(modified));
    if (!reReplay.ok) continue; // 仅保留整链无冲突的方案

    const returned = reReplay.holder === WAREHOUSE;
    candidates.push({
      kind: change.kind,
      record: recordRef(change.record),
      newFrom: change.kind === CHANGE.EDIT_FROM ? change.newFrom : null,
      changeText: changeText(change),
      holderAfter: reReplay.holder,
      returned,
      statusAfter: returned ? STATUS.RETURNED : STATUS.NOT_RETURNED,
      replayedCount: reReplay.chain.length,
      totalAfter: modified.length,
      note: returned
        ? `按此改动后整链可完整重放（${reReplay.chain.length} 条记录），道具最终归仓。`
        : `按此改动后整链可完整重放（${reReplay.chain.length} 条记录），` +
          `但演出结束仍由「${reReplay.holder}」持有，未归仓。`,
    });
  }

  return {
    ...base,
    conflict: {
      type: conflict.type,
      typeText,
      minute: conflict.minute,
      holder: conflict.holder,
      reason: conflict.reason,
      records: conflict.records,
      recordRefs: (conflict.recordRefs || []).map(recordRef),
    },
    candidates,
    summary: { tried: changes.length, workable: candidates.length },
    message: candidates.length === 0
      ? `围绕首个冲突（第${conflict.minute}分钟，${typeText}）共尝试 ${changes.length} 种单条记录改动，` +
        '重放该道具全部记录后交接链仍存在冲突：没有可行的单条修复方案。' +
        '请定位原记录人工核实，考虑多条记录联动调整（可结合批量交接预演）。'
      : null,
  };
}

module.exports = { CHANGE, previewRepairs };
