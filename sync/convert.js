// 把电脑版 JSON / CSV 拆成同步单元，再按原字段和原正文还原。
// 初次导入与后续编辑严格分开；冲突默认拒绝导出，避免覆盖用户未选择的版本。
import { canonical, clone, decodeLegacy, encodeLegacy, exactKeys, object, own, put, unitKey } from './canonical.js';
import { emptyState, normalize, unitInfo } from './merge.js';
import { assertDevice, assertVV } from './vv.js';
import { deleteUnit, resolveUnit, updateUnit } from './edit.js';
import { validDay } from './records.js';

const collections = ['projects', 'tasks', 'habits', 'weekNotes', 'reviews', 'countdowns'];
const statusFields = ['done', 'doneAt', 'abandoned', 'abandonedAt', 'abandonReason', 'abandonPrevious', 'abandonHistory', 'trashedAt', 'pinned'];
const collectionKinds = { 'project': 'projects', 'task-content': 'tasks', 'task-status': 'tasks', 'step': 'tasks',
  'habit-definition': 'habits', 'habit-check': 'habits', 'habit-journal': 'habits', 'countdown': 'countdowns',
  'review-meta': 'reviews', 'review-title': 'reviews', 'review-score': 'reviews', 'review-module': 'reviews',
  'week-meta': 'weekNotes', 'week-field': 'weekNotes' };
function without(row, keys) { return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key))); }
function only(row, keys) { return Object.fromEntries(Object.entries(row).filter(([key]) => keys.includes(key))); }
function assertObject(value, label) { if (!object(value)) throw new TypeError(label + ' 必须为对象'); }
function assertArray(value, label) { if (!Array.isArray(value)) throw new TypeError(label + ' 必须为数组'); }
function idOf(row, collection) {
  assertObject(row, collection);
  const id = collection === 'weekNotes' ? row.monday : row.id;
  if (typeof id !== 'string' || !id.length) throw new TypeError(collection + ' 缺少稳定编号');
  return id;
}
function entityFor(key) {
  const path = JSON.parse(key);
  if (path[0] === 'layout') return unitKey('entity', path[1], path[2]);
  if (own(collectionKinds, path[0])) return unitKey('entity', collectionKinds[path[0]], path[1]);
  return null;
}

// 与 ReviewText 使用同样的标题识别，保留原始空白、换行和重复标题。
// 原文切片保留换行；重排或并发追加后，拼接时补齐缺失的段间换行。
export function splitReview(content) {
  if (typeof content !== 'string') throw new TypeError('复盘 content 必须为字符串');
  const headings = [];
  let offset = 0;
  for (const line of content.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const text = line.replace(/\r?\n$/, '').trim();
    if (text.length > 2 && text.startsWith('【') && text.endsWith('】') && text.indexOf('】') === text.length - 1) headings.push({ start: offset, title: text.slice(1, -1).trim() });
    offset += line.length;
  }
  const starts = headings.length && headings[0].start === 0 ? headings : [{ start: 0, title: '' }, ...headings];
  if (!content.length) return [];
  const counts = new Map();
  return starts.map((entry, index) => {
    const occurrence = counts.get(entry.title) || 0;
    counts.set(entry.title, occurrence + 1);
    return { title: entry.title, occurrence: String(occurrence), raw: content.slice(entry.start, starts[index + 1]?.start ?? content.length) };
  });
}

export function plannerToState(planner, device, updatedAt = 0) {
  assertDevice(device); assertObject(planner, 'planner');
  const state = emptyState(), layout = { arrays: {}, deleted: own(planner, 'deleted') };
  function add(path, value, legacy = null) {
    const key = unitKey(...path), stamp = { updatedAt };
    if (legacy !== null && own(legacy, 'updated')) stamp.legacyUpdated = encodeLegacy(legacy.updated);
    // 首次导入不知道缺省字段的编辑时间，不能用导入时刻伪造它。
    if (path[0] === 'entity' && !own(stamp, 'legacyUpdated')) stamp.updatedAt = 0;
    if (own(state.units, key)) throw new TypeError('重复单元编号：' + key);
    const vv = { [device]: 1 };
    put(state.units, key, { versions: [{ vv, deleted: false, value: encodeLegacy(value), sources: [{ vv: { ...vv }, stamp }] }] });
  }
  for (const [key, value] of Object.entries(planner)) if (!collections.includes(key) && key !== 'deleted') add(['root', key], value);
  if (layout.deleted) {
    assertObject(planner.deleted, 'deleted');
    for (const [id, timestamp] of Object.entries(planner.deleted)) add(['legacy-deleted', id], timestamp);
  }
  for (const collection of collections) {
    if (!own(planner, collection)) continue;
    assertArray(planner[collection], collection);
    layout.arrays[collection] = true;
    const ids = new Set();
    for (const row of planner[collection]) {
      const id = idOf(row, collection);
      if (ids.has(id)) throw new TypeError(collection + ' 有重复编号：' + id);
      ids.add(id);
      add(['entity', collection, id], true, row);
      if (collection === 'projects') add(['project', id], without(row, ['updated']));
      if (collection === 'countdowns') add(['countdown', id], without(row, ['updated']));
      if (collection === 'tasks') {
        add(['task-content', id], without(row, [...statusFields, 'steps', 'updated']));
        add(['task-status', id], only(row, statusFields));
        const taskLayout = {};
        if (own(row, 'steps')) {
          assertArray(row.steps, 'steps'); taskLayout.steps = [];
          for (const step of row.steps) {
            const stepId = idOf(step, 'steps');
            taskLayout.steps.push(stepId);
            add(['step', id, stepId], step);
          }
        }
        add(['layout', collection, id], taskLayout);
      }
      if (collection === 'habits') {
        add(['habit-definition', id], without(row, ['checks', 'checkEdits', 'journal', 'updated']));
        const habitLayout = { checks: own(row, 'checks'), checkEdits: own(row, 'checkEdits'), journal: own(row, 'journal') };
        const checks = own(row, 'checks') ? row.checks : [];
        const checkEdits = own(row, 'checkEdits') ? row.checkEdits : {};
        assertArray(checks, 'checks'); assertObject(checkEdits, 'checkEdits');
        if (new Set(checks).size !== checks.length) throw new TypeError('checks 有重复日期');
        for (const day of new Set([...checks, ...Object.keys(checkEdits)])) {
          if (!validDay(day)) throw new TypeError('打卡日期格式错误');
          add(['habit-check', id, day], checks.includes(day));
          if (own(checkEdits, day)) state.units[unitKey('habit-check', id, day)].versions[0].sources[0].stamp.legacyCheckEdit = encodeLegacy(checkEdits[day]);
          else state.units[unitKey('habit-check', id, day)].versions[0].sources[0].stamp.updatedAt = 0;
        }
        if (habitLayout.journal) {
          assertObject(row.journal, 'journal');
          for (const [day, entry] of Object.entries(row.journal)) add(['habit-journal', id, day], entry);
        }
        add(['layout', collection, id], habitLayout);
      }
      if (collection === 'reviews') {
        add(['review-meta', id], without(row, ['title', 'score', 'content', 'updated']));
        for (const field of ['title', 'score']) if (own(row, field)) add(['review-' + field, id], row[field]);
        const reviewLayout = {};
        if (own(row, 'content')) {
          reviewLayout.content = [];
          for (const part of splitReview(row.content)) {
            const path = ['review-module', id, part.title, part.occurrence];
            reviewLayout.content.push(unitKey(...path));
            add(path, { title: part.title, raw: part.raw });
          }
        }
        add(['layout', collection, id], reviewLayout);
      }
      if (collection === 'weekNotes') {
        add(['week-meta', id], without(row, ['good', 'improve', 'next', 'updated']));
        for (const field of ['good', 'improve', 'next']) if (own(row, field)) add(['week-field', id, field], row[field]);
      }
    }
  }
  add(['planner-layout'], layout);
  return normalize(state);
}

function order(ids, preferred) {
  const available = new Set(ids), listed = new Set(preferred);
  return [...preferred.filter(id => available.has(id)), ...ids.filter(id => !listed.has(id)).sort()];
}
// 仅用于投影显示；合并核心仍按原规则保留全部来源。
function latestStamp(candidate) {
  return [...(candidate?.sources || [])].sort((a, b) => b.stamp.updatedAt - a.stamp.updatedAt
    || (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0))[0]?.stamp || {};
}
function legacyTime(stamp, field) {
  if (own(stamp, field)) return decodeLegacy(stamp[field]);
  if (!(stamp.updatedAt > 0)) return undefined;
  if (stamp.updatedAt > 253402300799999) throw new TypeError('显示时间超出电脑版 UTC 日期范围');
  return utcText(stamp.updatedAt);
}
// UTC 毫秒 → 电脑版 Json.Utc 的格式 yyyy-MM-ddTHH:mm:ss.fffZ。
// 纯整数运算（公历换算），不使用 Date：同步模块不读时钟，也不依赖运行环境的时区。
function utcText(ms) {
  const pad = (n, width) => String(n).padStart(width, '0');
  const days = Math.floor(ms / 86400000), rest = ms - days * 86400000;
  // 以 0000-03-01 为起点的天数换算（400 年一个周期，共 146097 天）。
  const z = days + 719468, era = Math.floor(z / 146097), doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153), day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9, year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return pad(year, 4) + '-' + pad(month, 2) + '-' + pad(day, 2) + 'T' + pad(Math.floor(rest / 3600000), 2) + ':'
    + pad(Math.floor(rest / 60000) % 60, 2) + ':' + pad(Math.floor(rest / 1000) % 60, 2) + '.' + pad(rest % 1000, 3) + 'Z';
}
function timeField(stamp, field) { return only(stamp, [field]); }
function plannerText(planner) {
  const result = { ...planner };
  for (const collection of collections) if (own(result, collection)) {
    result[collection] = [...result[collection]].sort((a, b) => {
      const x = idOf(a, collection), y = idOf(b, collection); return x < y ? -1 : x > y ? 1 : 0;
    });
    if (collection === 'habits') result[collection] = result[collection].map(row => own(row, 'checks') ? { ...row, checks: [...row.checks].sort() } : row);
  }
  return canonical(encodeLegacy(result));
}
// 首次投影仍验证所有单元；常见的单版本、单来源已无需做集合归并及整库规范文本复制。
// 多来源/多版本交回合并核心，显示顺序、冲突和来源规则保持同一个实现。
function projectionUnits(state) {
  if (!exactKeys(state, ['schema', 'units', 'archives']) || state.schema !== 1 || !object(state.units) || !object(state.archives)) throw new TypeError('不支持的状态结构');
  normalize({ schema: state.schema, units: {}, archives: state.archives });
  const units = {};
  for (const key of Object.keys(state.units).sort()) {
    let path;
    try { path = JSON.parse(key); } catch { throw new TypeError('单元键不是规范数组文本'); }
    const unit = state.units[key];
    if (!Array.isArray(path) || !path.length || path.some(p => typeof p !== 'string') || canonical(path) !== key) throw new TypeError('单元键不是规范字符串数组');
    if (unit?.versions?.length !== 1 || unit.versions[0]?.sources?.length !== 1) {
      put(units, key, normalize({ schema: 1, units: { [key]: unit }, archives: {} }).units[key]); continue;
    }
    const version = unit.versions[0], source = version.sources[0];
    if (!exactKeys(unit, ['versions']) || !Array.isArray(unit.versions) || !exactKeys(version, ['vv', 'deleted', 'value', 'sources']) ||
        typeof version.deleted !== 'boolean' || !Array.isArray(version.sources) || !exactKeys(source, ['vv', 'stamp'])) throw new TypeError('并存版本格式错误');
    assertVV(version.vv); assertVV(source.vv);
    if (canonical(version.vv) !== canonical(source.vv)) throw new TypeError('合成向量与来源不符');
    canonical(version.value);
    if (version.deleted && version.value !== null) throw new TypeError('墓碑的 value 必须为 null');
    if (!object(source.stamp) || !Number.isSafeInteger(source.stamp.updatedAt) || source.stamp.updatedAt < 0) throw new TypeError('stamp.updatedAt 必须为非负 UTC 毫秒');
    canonical(source.stamp);
    put(units, key, unit);
  }
  return units;
}
export function stateToPlanner(state, { allowConflicts = false } = {}) {
  const units = projectionUnits(state);
  const index = new Map(), byOwner = new Map(), cache = new Map();
  for (const key of Object.keys(units)) {
    const path = JSON.parse(key);
    if (!index.has(path[0])) index.set(path[0], []);
    const entry = { key, path };
    index.get(path[0]).push(entry);
    if (!byOwner.has(path[0])) byOwner.set(path[0], new Map());
    const owners = byOwner.get(path[0]);
    if (!owners.has(path[1])) owners.set(path[1], []);
    owners.get(path[1]).push(entry);
  }
  function info(key) {
    // normalize 已完整校验并归并全部来源；显示时直接读取其规范候选，避免逐单元再归并/复制。
    const versions = own(units, key) ? units[key].versions : [];
    return { preferred: versions.find(v => !v.deleted) || versions[0] || null, conflict: versions.length > 1 };
  }
  function read(key) {
    if (cache.has(key)) return decodeLegacy(cache.get(key));
    const details = info(key);
    const kind = JSON.parse(key)[0];
    if (details.conflict && !allowConflicts && kind !== 'layout' && kind !== 'planner-layout') throw new TypeError('尚有未解决的冲突：' + key);
    if (!details.preferred || details.preferred.deleted) return undefined;
    cache.set(key, details.preferred.value);
    return decodeLegacy(details.preferred.value);
  }
  function rowValue(path) {
    const key = unitKey(...path), row = read(key);
    if (row === undefined) return {};
    assertObject(row, '字段单元');
    return row;
  }
  function paths(kind, id) {
    return id === undefined ? index.get(kind) || [] : byOwner.get(kind)?.get(id) || [];
  }
  const layout = read(unitKey('planner-layout')) || { arrays: {}, deleted: false }, result = {};
  for (const { key, path } of paths('root')) {
    const value = read(key); if (value !== undefined) put(result, path[1], value);
  }
  if (layout.deleted || paths('legacy-deleted').some(({ key }) => read(key) !== undefined)) {
    result.deleted = {};
    for (const { key, path } of paths('legacy-deleted')) {
      const value = read(key); if (value !== undefined) put(result.deleted, path[1], value);
    }
  }
  for (const collection of collections) {
    const ids = paths('entity').filter(({ path }) => path[1] === collection).filter(({ key }) => read(key) !== undefined).map(({ path }) => path[2]);
    if (!own(layout.arrays, collection) && !ids.length) continue;
    result[collection] = [];
    for (const id of ids.sort()) {
      const local = read(unitKey('layout', collection, id)) || {};
      let row;
      if (collection === 'projects') row = rowValue(['project', id]);
      if (collection === 'countdowns') row = rowValue(['countdown', id]);
      if (collection === 'tasks') {
        row = { ...rowValue(['task-content', id]), ...rowValue(['task-status', id]) };
        const steps = paths('step', id).filter(({ key }) => read(key) !== undefined);
        if (own(local, 'steps') || steps.length) row.steps = order(steps.map(({ path }) => path[2]), local.steps || []).map(stepId => ({ ...rowValue(['step', id, stepId]), id: stepId }));
      }
      if (collection === 'habits') {
        row = rowValue(['habit-definition', id]);
        const checks = [], edits = {}, journal = {};
        for (const { key, path } of paths('habit-check', id)) {
          const checked = read(key); if (checked === undefined) continue;
          if (checked) checks.push(path[2]);
          const time = legacyTime(latestStamp(info(key).preferred), 'legacyCheckEdit');
          if (time !== undefined) put(edits, path[2], time);
        }
        for (const { key, path } of paths('habit-journal', id)) {
          const entry = read(key); if (entry !== undefined) put(journal, path[2], entry);
        }
        if (local.checks || checks.length) row.checks = checks.sort();
        if (local.checkEdits || Object.keys(edits).length) row.checkEdits = edits;
        if (local.journal || Object.keys(journal).length) row.journal = journal;
      }
      if (collection === 'reviews') {
        row = rowValue(['review-meta', id]);
        for (const field of ['title', 'score']) {
          const value = read(unitKey('review-' + field, id)); if (value !== undefined) put(row, field, value);
        }
        const keys = paths('review-module', id).filter(({ key }) => read(key) !== undefined).map(({ key }) => key);
        if (own(local, 'content') || keys.length) row.content = order(keys, local.content || []).map(key => read(key).raw).filter(raw => raw.length).reduce((text, raw) => text + (text.length && !text.endsWith('\n') ? '\n' : '') + raw, '');
      }
      if (collection === 'weekNotes') {
        row = rowValue(['week-meta', id]);
        for (const { key, path } of paths('week-field', id)) {
          const value = read(key); if (value !== undefined) put(row, path[2], value);
        }
      }
      put(row, collection === 'weekNotes' ? 'monday' : 'id', id);
      // 实体时间只属于存在单元；不采信子单元内的显示字段。
      delete row.updated;
      const time = legacyTime(latestStamp(info(unitKey('entity', collection, id)).preferred), 'legacyUpdated');
      if (time !== undefined) put(row, 'updated', time);
      result[collection].push(row);
    }
  }
  return result;
}

// 对比编辑前后的电脑版投影，只为确实改变的单元增加计数。
// 删除整个实体只删除存在单元，保留内容；每次子单元编辑同时触及存在单元。
export function applyPlannerChanges(state, before, after, device, updatedAt = 0) {
  if (plannerText(stateToPlanner(state)) !== plannerText(before)) throw new TypeError('编辑前数据不是当前投影；请保留原编辑状态，再与新到的状态合并');
  const previous = plannerToState(before, device, updatedAt), next = plannerToState(after, device, updatedAt);
  let result = normalize(state);
  const touched = new Set();
  const keys = [...new Set([...Object.keys(previous.units), ...Object.keys(next.units)])].sort();
  for (const key of keys) {
    const path = JSON.parse(key), a = previous.units[key]?.versions[0], b = next.units[key]?.versions[0];
    if (path[0] === 'entity') continue;
    const owner = entityFor(key);
    // 整体删除由存在单元负责，不能提前删掉其内容和未知字段。
    if (owner && !own(next.units, owner)) continue;
    // updated 等显示时间变化不应令两个业务单元同时产生修改。
    if (a && b && canonical(a.value) === canonical(b.value)
      && (path[0] !== 'habit-check' || canonical(timeField(a.sources[0].stamp, 'legacyCheckEdit')) === canonical(timeField(b.sources[0].stamp, 'legacyCheckEdit')))) continue;
    if (!a && !b) continue;
    const auxiliary = path[0] === 'layout' || path[0] === 'planner-layout';
    if (b && auxiliary && unitInfo(result.units[key]).conflict) result = resolveUnit(result, key, device, b.value, b.sources[0].stamp);
    else result = b ? updateUnit(result, key, device, b.value, b.sources[0].stamp) : deleteUnit(result, key, device, { updatedAt });
    if (owner) touched.add(owner);
  }
  for (const key of keys.filter(key => JSON.parse(key)[0] === 'entity')) {
    const had = own(previous.units, key), has = own(next.units, key);
    const aStamp = previous.units[key]?.versions[0].sources[0].stamp || {}, bStamp = next.units[key]?.versions[0].sources[0].stamp || {};
    if (has && (!had || touched.has(key) || canonical(timeField(aStamp, 'legacyUpdated')) !== canonical(timeField(bStamp, 'legacyUpdated'))))
      result = updateUnit(result, key, device, true, { ...bStamp, updatedAt });
    if (had && !has) result = deleteUnit(result, key, device, { updatedAt });
  }
  return result;
}

export const CSV_HEADER = ['类型', '开始', '结束', '分钟', '事项', '状态', '备注', '关联任务'];
export function parseCsv(text) {
  if (typeof text !== 'string') throw new TypeError('CSV 必须为字符串');
  if (text.startsWith('\ufeff')) text = text.slice(1);
  const rows = []; let row = [], cell = '', quoted = false, afterQuote = false, started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]; started = true;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; afterQuote = true; }
      else cell += c;
    } else if (c === ',') { row.push(cell); cell = ''; afterQuote = false; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = ''; afterQuote = false; started = false;
    } else if (c === '"' && !cell.length && !afterQuote) quoted = true;
    else {
      if (afterQuote || c === '"') throw new TypeError('CSV 引号格式错误');
      cell += c;
    }
  }
  if (quoted) throw new TypeError('CSV 引号未闭合');
  if (started) { row.push(cell); rows.push(row); }
  return rows;
}
export function writeCsv(rows) {
  return rows.map(row => row.map(cell => {
    if (typeof cell !== 'string') throw new TypeError('CSV 列必须为字符串');
    return /[,"\r\n]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell;
  }).join(',')).join('\r\n') + (rows.length ? '\r\n' : '');
}
export function recordRowToValue(columns) {
  if (!Array.isArray(columns) || columns.length < 6 || columns.some(cell => typeof cell !== 'string')) throw new TypeError('记录行至少需要六列字符串');
  const day = columns[1].slice(0, 10);
  if (!validDay(day) || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(columns[1])) throw new TypeError('需要 RecordStore.ToLine 写出的开始时间');
  return { columns: [...columns], day };
}
export function csvToState(text, { device, ids, updatedAt = 0 }) {
  assertDevice(device);
  const rows = parseCsv(text);
  let header = null;
  if (rows[0]?.[0] === '类型') header = rows.shift();
  if (!Array.isArray(ids) || ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id.length)) throw new TypeError('每一行必须提供已持久保存的独立编号，不能按内容去重');
  const state = emptyState();
  const add = (key, value) => put(state.units, key, { versions: [{ vv: { [device]: 1 }, value, deleted: false, sources: [{ vv: { [device]: 1 }, stamp: { updatedAt } }] }] });
  add(unitKey('csv-layout'), { header, ids: [...ids] });
  rows.forEach((row, index) => add(unitKey('record', ids[index]), recordRowToValue(row)));
  return normalize(state);
}
export function stateToCsv(state, { allowConflicts = false, archivesHydrated = false, allowPartial = false } = {}) {
  const normalized = normalize(state);
  if (Object.keys(normalized.archives).length && !archivesHydrated && !allowPartial) throw new TypeError('请先下载并合并全部年度归档；局部查看需要明确 allowPartial');
  const read = key => {
    const info = unitInfo(normalized.units[key]);
    if (info.conflict && !allowConflicts) throw new TypeError('记录有未解决冲突');
    return info.preferred && !info.preferred.deleted ? info.preferred.value : null;
  };
  const layout = read(unitKey('csv-layout')) || { header: CSV_HEADER, ids: [] };
  const ids = Object.keys(normalized.units).map(key => JSON.parse(key)).filter(path => path[0] === 'record').map(path => path[1]);
  const rows = layout.header === null ? [] : [layout.header];
  for (const id of order(ids, layout.ids)) { const value = read(unitKey('record', id)); if (value) rows.push(value.columns); }
  return writeCsv(rows);
}

// 实体级接口：复用原转换规则，但只把一个实体交给原投影/比较函数。
// state 的单元按不可变值使用；返回新顶层及新 units 字典，未改单元共享引用。
const entityIndexes = new WeakMap();
function entityIndex(state) {
  if (entityIndexes.has(state)) return entityIndexes.get(state);
  const index = new Map();
  for (const key of Object.keys(state.units)) {
    const owner = JSON.parse(key)[0] === 'entity' ? key : entityFor(key);
    if (!owner) continue;
    if (!index.has(owner)) index.set(owner, []);
    index.get(owner).push(key);
  }
  entityIndexes.set(state, index); return index;
}
export function entityUnitKeys(state, collection, id) {
  return [...(entityIndex(state).get(unitKey('entity', collection, id)) || [])];
}
function entityState(state, collection, id) {
  if (!collections.includes(collection) || typeof id !== 'string') throw new TypeError('未知实体集合或编号');
  const result = emptyState(), layout = unitKey('planner-layout');
  for (const key of entityUnitKeys(state, collection, id)) put(result.units, key, state.units[key]);
  if (own(state.units, layout)) put(result.units, layout, state.units[layout]);
  return result;
}
export function readEntity(state, collection, id, options = {}) {
  return stateToPlanner(entityState(state, collection, id), options)[collection]?.find(row => idOf(row, collection) === id);
}
// 返回 {state, keys}；keys 可直接交给 engine.commit 的 hint。
// before 必须是当前实体投影；不接受用别的实体编号悄悄搬动数据。
export function applyEntityChange(state, collection, id, before, after, device, updatedAt = 0) {
  const subset = entityState(state, collection, id), previous = stateToPlanner(subset);
  const current = previous[collection]?.find(row => idOf(row, collection) === id);
  const text = row => row === undefined ? 'undefined' : plannerText({ [collection]: [row] });
  if (text(current) !== text(before)) throw new TypeError('编辑前数据不是当前实体投影；请保留原编辑状态');
  for (const row of [before, after]) if (row !== undefined && idOf(row, collection) !== id) throw new TypeError('实体编号不能改变');
  const next = { ...previous };
  if (after !== undefined || own(previous, collection)) next[collection] = after === undefined ? [] : [after];
  const edited = applyPlannerChanges(subset, previous, next, device, updatedAt);
  const keys = Object.keys(edited.units).filter(key => !own(subset.units, key) || canonical(subset.units[key]) !== canonical(edited.units[key]));
  if (!keys.length) return { state, keys };
  const result = { ...state, units: { ...state.units } };
  for (const key of keys) put(result.units, key, edited.units[key]);
  const index = new Map(entityIndex(state)), owner = unitKey('entity', collection, id);
  index.set(owner, [...new Set([...(index.get(owner) || []), ...keys.filter(key => key === owner || entityFor(key) === owner)])]);
  entityIndexes.set(result, index);
  return { state: result, keys };
}
