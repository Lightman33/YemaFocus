// 界面读取、编辑同步数据的唯一入口；事务成功后才发布新的投影。
// snapshot() 保留 planner/conflicts/today/timeZone/focus/demo/editToken 等字段；
// 新增 settings（所有setting单元）及 records（[{id,day,columns}]，首次读取才计算）。
// 返回独立可写的懒副本，改它不会改缓存；editToken 仍是不透明观察凭据。
// change(说明,同步修改函数,原选项) 用写入路径找实体；只比较被访问且修改的集合行，
// 不扫描未改集合的正文。远端 refresh/其他页面版本变化可全量投影。
// attachEngine 与来源共用store：封套模式调用commit(state,keys)，原始示例模式仍update。
// resolve/subscribe 原用法不变，第一次读取仍调用snapshot。
import { applyPlannerChanges } from '../sync/convert.js';
import { stateToPlanner, readEntity as convertReadEntity, applyEntityChange, goalCollections, goalUnitKinds, legacyGoalProjection, goalRowId } from './goal-sync.js';
import { merge, unitInfo, branchKey, emptyState } from '../sync/merge.js';
import { resolveUnit, updateUnit } from '../sync/edit.js';
import { canonical, encodeLegacy, decodeLegacy, unitKey } from '../sync/canonical.js';
import { copy, repeating, REPEAT_READONLY } from './task-model.js';
import { StoreError } from './store.js';
import { bucketOf } from '../sync/pack.js';
import { recordKey } from './focus-records.js';
import { FOCUS_ITEMS, readFocusItems } from './focus-items.js';

export class DataError extends StoreError {
  constructor(message) { super('data'); this.message = message; this.name = 'DataError'; }
}
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
export const WINDOWS_ZONES = {
  'China Standard Time': 'Asia/Shanghai', 'Taipei Standard Time': 'Asia/Taipei',
  'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul',
  'Singapore Standard Time': 'Asia/Singapore', 'India Standard Time': 'Asia/Kolkata',
  'GMT Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin',
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'New Zealand Standard Time': 'Pacific/Auckland',
  'UTC': 'UTC'
};
export function softwareZone(state, settings = {}) {
  const info = unitInfo(state?.units[unitKey('setting', 'TimeZone')]);
  const raw = info.preferred && !info.preferred.deleted ? decodeLegacy(info.preferred.value) : '';
  // 没有单元才使用约定缺省；未知 Windows ID 必须明确选映射，不能静默用手机时区。
  if (!raw) return { timeZone: DEFAULT_TIME_ZONE, timeZoneMissing: true, timeZoneUnknown: '' };
  const name = WINDOWS_ZONES[raw] || (raw.includes('/') || raw === 'UTC' ? raw : settings.taskTimeZoneFor === raw ? settings.taskTimeZone : null);
  try {
    if (!name) throw new Error();
    new Intl.DateTimeFormat('zh-CN', { timeZone: name }).format(0);
    return { timeZone: name, timeZoneMissing: false, timeZoneUnknown: WINDOWS_ZONES[raw] || raw.includes('/') || raw === 'UTC' ? '' : raw };
  } catch { return { timeZone: null, timeZoneMissing: false, timeZoneUnknown: raw }; }
}
export function wallTime(now, timeZone) {
  if (!timeZone) throw new DataError('请先在设置里选择软件时区。');
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
}
const same = (a, b) => canonical(encodeLegacy(a)) === canonical(encodeLegacy(b));
const own = (o, key) => Object.hasOwn(o, key);
const auxiliary = key => ['layout', 'planner-layout'].includes(JSON.parse(key)[0]);

// 只在纯文字单元或对象恰好只有一个文字字段不同的情况下提供“两段都留着”。
export function textCombination(candidates) {
  if (candidates.length < 2 || candidates.some(c => c.deleted)) return null;
  const values = candidates.map(c => c.value);
  if (values.every(v => typeof v === 'string')) return values.join('\n\n');
  if (!values.every(v => v && typeof v === 'object' && !Array.isArray(v))) return null;
  const fields = [...new Set(values.flatMap(v => Object.keys(v)))].filter(k => values.some(v => own(v, k) !== own(values[0], k) || !same(v[k] ?? null, values[0][k] ?? null)));
  if (fields.length !== 1 || !['notes', 'text', 'raw', 'good', 'improve', 'next'].includes(fields[0]) || values.some(v => typeof v[fields[0]] !== 'string')) return null;
  return { ...copy(values[0]), [fields[0]]: values.map(v => v[fields[0]]).join('\n\n') };
}
// 同一模块只留一个标题；顺序与冲突卡片中候选的规范顺序相同。
function reviewCombination(candidates, title) {
  if (candidates.some(c => c.deleted || !c.value || c.value.title !== title || typeof c.value.raw !== 'string')) return null;
  const bodies = candidates.map(c => {
    const raw = c.value.raw.replace(/\r\n/g, '\n');
    const body = title ? raw.slice(raw.indexOf('\n') < 0 ? raw.length : raw.indexOf('\n') + 1) : raw;
    return body.replace(/^\n+|\n+$/g, '');
  });
  return { ...copy(candidates[0].value), raw: (title ? '【' + title + '】\n' : '') + bodies.join('\n\n') };
}
export function conflictList(state) {
  if (!state) return [];
  return Object.keys(state.units).sort().flatMap(key => {
    // 合法单版本不可能有冲突；只对多版本单元计算规范候选。
    if (state.units[key]?.versions?.length === 1) return [];
    const info = unitInfo(state.units[key]);
    if (!info.conflict || auxiliary(key)) return [];
    const path = JSON.parse(key);
    if (path[0] === FOCUS_ITEMS) return [];
    const candidates = info.alternatives.map(v => ({ branch: branchKey(v), deleted: v.deleted, value: decodeLegacy(v.value), vv: v.vv }));
    const taskId = path[0] === 'entity' && path[1] === 'tasks' ? path[2] : ['task-content', 'task-status', 'step', 'task-goal'].includes(path[0]) ? path[1] : null;
    const entity = taskId ? unitInfo(state.units[unitKey('entity', 'tasks', taskId)]) : null;
    return [{ key, path, candidates, deleteConflict: info.deleteConflict, both: !goalUnitKinds.includes(path[0]) && textCombination(candidates) !== null,
      taskId, hiddenByDeletion: Boolean(taskId && entity?.preferred?.deleted && !entity.conflict) }];
  });
}
function singleProjection(state) {
  const view = copy(state);
  for (const key of Object.keys(view.units)) {
    const info = unitInfo(view.units[key]);
    if (info.conflict) view.units[key] = { versions: [info.preferred] };
  }
  return view;
}
function plannerEdit(state, before, after, device, now) {
  const view = singleProjection(state);
  const edited = applyPlannerChanges(view, legacyGoalProjection(before), legacyGoalProjection(after), device, now), result = copy(state);
  for (const key of Object.keys(edited.units)) {
    if (view.units[key] && same(view.units[key], edited.units[key])) continue;
    if (unitInfo(state.units[key]).conflict) {
      if (!auxiliary(key)) throw new DataError('这项内容两边都改过，请先选择保留哪一份。');
      const v = unitInfo(edited.units[key]).preferred;
      result.units[key] = resolveUnit(state, key, device, v.value, v.sources[0].stamp, { deleted: v.deleted }).units[key];
    } else result.units[key] = edited.units[key];
  }
  return result;
}
// 只撤回本次真正改变的字段；其他任务/字段随后收到的改动不会被旧整库快照盖掉。
function reverseTasks(planner, before, after) {
  const a = new Map((before.tasks || []).map(t => [t.id, t])), b = new Map((after.tasks || []).map(t => [t.id, t]));
  planner.tasks ||= [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const prev = a.get(id), next = b.get(id), current = planner.tasks.find(t => t.id === id);
    if (prev && next && same(prev, next)) continue;
    if (!prev) {
      if (!current || !same(current, next)) throw new DataError('这项任务已有新改动，请在详情里调整。');
      planner.tasks = planner.tasks.filter(t => t.id !== id); continue;
    }
    if (!next) {
      if (current) throw new DataError('这项任务已有新改动，请在详情里调整。');
      const following = (before.tasks || []).slice((before.tasks || []).findIndex(t => t.id === id) + 1).find(t => planner.tasks.some(c => c.id === t.id));
      const index = following ? planner.tasks.findIndex(t => t.id === following.id) : planner.tasks.length;
      planner.tasks.splice(index, 0, copy(prev)); continue;
    }
    if (!current) throw new DataError('任务已在别处删除，未覆盖新改动。');
    for (const field of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      if (field === 'updated' || (own(prev, field) === own(next, field) && same(prev[field] ?? null, next[field] ?? null))) continue;
      if (own(current, field) !== own(next, field) || !same(current[field] ?? null, next[field] ?? null)) throw new DataError('这项内容已有新改动，请在详情里调整。');
      if (own(prev, field)) current[field] = copy(prev[field]); else delete current[field];
    }
  }
}
function focusStats(state) {
  const result = {};
  for (const key of Object.keys(state?.units || {})) {
    if (JSON.parse(key)[0] !== 'record') continue;
    const v = unitInfo(state.units[key]).preferred;
    if (!v || v.deleted) continue;
    const c = decodeLegacy(v.value).columns || [], id = (c[7] || '').split('|')[0];
    if (!id || c[5] !== '完成' || !['番茄', '正计时'].includes(c[0])) continue;
    const value = result[id] ||= { count: 0, minutes: 0 };
    if (c[0] === '番茄') value.count++;
    const minutes = Number(c[3]); if (Number.isFinite(minutes) && minutes >= 0) value.minutes += minutes;
  }
  return result;
}
// 重放“用户实际改过的字段”，保留同设备其他标签页的新增行与未知字段。
function replayDiff(target, before, after) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (own(before, key) === own(after, key) && same(before[key] ?? null, after[key] ?? null)) continue;
    if (!own(after, key)) { delete target[key]; continue; }
    const a = before[key], b = after[key], current = target[key];
    const rows = value => Array.isArray(value) && value.every(row => row && typeof row === 'object' && typeof row.id === 'string');
    if (rows(a) && rows(b) && rows(current)) {
      for (const prev of a) if (!b.some(row => row.id === prev.id)) target[key] = target[key].filter(row => row.id !== prev.id);
      for (const next of b) {
        const prev = a.find(row => row.id === next.id), row = target[key].find(row => row.id === next.id);
        if (!prev) { if (!row) target[key].push(copy(next)); }
        else if (row) replayDiff(row, prev, next);
        else if (!same(prev, next)) throw new DataError('内容已在另一页删除，请重新查看。');
      }
      if (!same(a.map(row => row.id), b.map(row => row.id))) {
        const rowsById = new Map(target[key].map(row => [row.id, row])), wanted = new Set(b.map(row => row.id));
        target[key] = [...b.filter(row => rowsById.has(row.id)).map(row => rowsById.get(row.id)), ...target[key].filter(row => !wanted.has(row.id))];
      }
    } else if (key === 'checks' && [a || [], b, current].every(v => Array.isArray(v) && v.every(day => typeof day === 'string'))) {
      // 同设备另一个标签页也可打卡；只重放本次增减日期，不能用旧数组盖掉其他日期。
      const removed = new Set((a || []).filter(day => !b.includes(day))), added = b.filter(day => !(a || []).includes(day));
      target[key] = [...new Set([...current.filter(day => !removed.has(day)), ...added])].sort();
    } else if (key === 'checkEdits' && b && current && !Array.isArray(b) && !Array.isArray(current)) replayDiff(current, a || {}, b);
    else if (a && b && current && !Array.isArray(a) && !Array.isArray(b) && typeof a === 'object' && typeof b === 'object' && typeof current === 'object') replayDiff(current, a, b);
    else target[key] = copy(b);
  }
}
// 同设备并发事务必须沿用已落盘的最大计数，不能写出“同一向量不同取值”。
function advanceLocalCounters(edited, base, latest, device) {
  for (const key of Object.keys(edited.units)) {
    if (base.units[key] && same(base.units[key], edited.units[key])) continue;
    let max = 0;
    for (const version of latest.units[key]?.versions || []) max = Math.max(max, version.vv[device] || 0);
    for (const version of edited.units[key].versions) {
      if (!version.sources.some(s => s.vv[device] && (!base.units[key] || !base.units[key].versions.some(b => b.sources.some(x => same(x.vv, s.vv)))))) continue;
      if ((version.vv[device] || 0) <= max) {
        if (!Number.isSafeInteger(max + 1)) throw new DataError('设备计数用尽，请重新连接。');
        version.vv[device] = max + 1;
        for (const source of version.sources) source.vv[device] = max + 1;
      }
    }
  }
}
// 懒副本：只访问的容器生成浅副本，只写入的路径进入最终结果。
// snapshot 每次返回独立可写视图，未访问的大正文不复制；缓存不暴露给调用者。
function draftOf(base) {
  const nodes = new WeakMap();
  function node(value) {
    const target = Array.isArray(value) ? value.slice() : Object.create(Object.prototype, Object.getOwnPropertyDescriptors(value)), children = new Map();
    let dirty = false;
    const proxy = new Proxy(target, {
      get(t, key) {
        const v = Reflect.get(t, key);
        if (key === 'editToken' || !v || typeof v !== 'object') return v;
        if (!children.has(key) || children.get(key).base !== v) children.set(key, node(v));
        return children.get(key).proxy;
      },
      set(t, key, value) { children.delete(key); if (!Object.is(t[key], value) || !own(t, key)) dirty = true; return Reflect.set(t, key, value); },
      deleteProperty(t, key) { children.delete(key); if (own(t, key)) dirty = true; return Reflect.deleteProperty(t, key); }
    });
    const entry = { base: value, proxy, finish() {
      for (const [key, child] of children) { const v = child.finish(); if (v !== child.base) { target[key] = v; dirty = true; } }
      if (!dirty) return value;
      // 数组 sort/splice 可能把另一个懒副本写回；取出其真实最终值。
      for (const key of Object.keys(target)) if (nodes.has(target[key])) target[key] = nodes.get(target[key]).finish();
      return target;
    } };
    nodes.set(proxy, entry); return entry;
  }
  return node(base);
}
// 实体键索引随已知改动继承；转换器只看到单实体，避免每次重建整库实体索引。
const entityIndexes = new WeakMap();
const collectionKinds = { project: 'projects', 'task-content': 'tasks', 'task-status': 'tasks', 'task-goal': 'tasks', step: 'tasks', goal: 'goals', 'goal-year': 'goalYears',
  'goal-plan': 'goalPlans', 'goal-plan-lock': 'goalPlanLocks',
  'habit-definition': 'habits', 'habit-check': 'habits', 'habit-journal': 'habits', countdown: 'countdowns',
  'review-meta': 'reviews', 'review-title': 'reviews', 'review-score': 'reviews', 'review-module': 'reviews', 'week-meta': 'weekNotes', 'week-field': 'weekNotes' };
function ownerOf(key) {
  const p = JSON.parse(key);
  return p[0] === 'entity' ? key : p[0] === 'layout' ? unitKey('entity', p[1], p[2]) : collectionKinds[p[0]] ? unitKey('entity', collectionKinds[p[0]], p[1]) : null;
}
function entityIndex(state) {
  if (!entityIndexes.has(state)) {
    const index = new Map();
    for (const key of Object.keys(state.units)) { const owner = ownerOf(key); if (owner) { if (!index.has(owner)) index.set(owner, []); index.get(owner).push(key); } }
    entityIndexes.set(state, index);
  }
  return entityIndexes.get(state);
}
function inheritIndex(before, after, keys) {
  const index = new Map(entityIndex(before));
  for (const key of keys) {
    const owner = ownerOf(key); if (!owner) continue;
    const items = index.get(owner) || [];
    if (!items.includes(key) && own(after.units, key)) index.set(owner, [...items, key]);
    else if (!own(after.units, key)) index.set(owner, items.filter(k => k !== key));
  }
  entityIndexes.set(after, index);
}
function entityUnitKeys(state, collection, id) { return entityIndex(state).get(unitKey('entity', collection, id)) || []; }
function entitySubset(state, collection, id) {
  const units = {};
  for (const key of [...entityUnitKeys(state, collection, id), unitKey('planner-layout')]) if (own(state.units, key)) units[key] = state.units[key];
  return { schema: 1, units, archives: {} };
}
function readEntity(state, collection, id, options) { return convertReadEntity(entitySubset(state, collection, id), collection, id, options); }
function scopeEntities(state, changes) {
  const units = {};
  for (const change of changes) Object.assign(units, entitySubset(state, change.collection, change.id).units);
  return { schema: 1, units, archives: {} };
}
const observedParts = new WeakMap();
function observedOverlay(base, partial) {
  const previous = observedParts.get(base), root = previous ? previous.root : base;
  const delta = previous ? { ...previous.delta, ...partial.units } : partial.units;
  const units = new Proxy({}, {
    get: (_target, key) => own(delta, key) ? delta[key] : root.units[key],
    ownKeys: () => [...new Set([...Object.keys(root.units), ...Object.keys(delta)])],
    getOwnPropertyDescriptor: (_target, key) => own(delta, key) || own(root.units, key) ? { configurable: true, enumerable: true, writable: false, value: own(delta, key) ? delta[key] : root.units[key] } : undefined
  });
  const result = { ...base, units }; observedParts.set(result, { root, delta }); inheritIndex(base, result, Object.keys(partial.units)); return result;
}
const legacyCollections = ['projects', 'tasks', 'habits', 'weekNotes', 'reviews', 'countdowns'];
const entityCollections = [...legacyCollections, ...Object.keys(goalCollections)];
const rowId = (row, collection) => collection === 'weekNotes' ? row.monday : own(goalCollections, collection) ? goalRowId(row, collection) : row.id;
function entityDiff(before, after) {
  const changes = [];
  for (const collection of entityCollections) {
    if (before[collection] === after[collection]) continue;
    const a = new Map((before[collection] || []).map(row => [rowId(row, collection), row]));
    const b = new Map((after[collection] || []).map(row => [rowId(row, collection), row]));
    if (a.size !== (before[collection] || []).length || b.size !== (after[collection] || []).length) throw new DataError('集合有重复编号。');
    for (const id of new Set([...a.keys(), ...b.keys()])) {
      const x = a.get(id), y = b.get(id);
      if (x === y || (x && y && same(x, y))) continue;
      changes.push({ collection, id, before: x, after: y });
    }
  }
  return changes;
}
function entityEdit(state, change, device, now) {
  // 单实体首选投影，保留所有原分支；只允许显式解决辅助布局冲突。
  const subset = { schema: 1, units: {}, archives: {} };
  for (const key of [...entityUnitKeys(state, change.collection, change.id), unitKey('planner-layout')]) {
    if (!own(state.units, key)) continue;
    const info = unitInfo(state.units[key]);
    subset.units[key] = info.conflict ? { versions: [info.preferred] } : state.units[key];
  }
  const edited = applyEntityChange(subset, change.collection, change.id, change.before, change.after, device, now);
  const result = { ...state, units: { ...state.units } };
  for (const key of edited.keys) {
    if (unitInfo(state.units[key]).conflict) {
      if (!auxiliary(key)) throw new DataError('这项内容两边都改过，请先选择保留哪一份。');
      const v = unitInfo(edited.state.units[key]).preferred;
      const one = { schema: 1, units: { [key]: state.units[key] }, archives: {} };
      result.units[key] = resolveUnit(one, key, device, v.value, v.sources[0].stamp, { deleted: v.deleted }).units[key];
    } else result.units[key] = edited.state.units[key];
  }
  return { state: result, keys: edited.keys };
}
const unwrapped = record => record.state?.format === 'yema-engine-local' ? { ...record, state: record.state.state, envelope: record.state } : record;
function extras(state) {
  const settings = {};
  for (const [key, unit] of Object.entries(state?.units || {})) {
    const path = JSON.parse(key);
    if (path[0] !== 'setting') continue;
    const v = unitInfo(unit).preferred; if (!v || v.deleted) continue;
    const value = decodeLegacy(v.value);
    Object.defineProperty(settings, path[1], { value, enumerable: true, writable: true, configurable: true });
  }
  return { settings };
}
function recordRows(state) {
  return Object.entries(state?.units || {}).flatMap(([key, unit]) => {
    const path = JSON.parse(key); if (path[0] !== 'record') return [];
    const v = unitInfo(unit).preferred; if (!v || v.deleted) return [];
    const value = decodeLegacy(v.value); return [{ id: path[1], day: value.day, columns: value.columns }];
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export class DataSource {
  constructor({ store, now = () => Date.now(), demo = false, tasksFirst = false }) {
    this.tasksFirst = tasksFirst; this.hydrated = !tasksFirst; this.unloaded = []; this.storageVersion = -1; this.loadedDataVersion = -1; this.loadedBuckets = {};
    this.store = store; this.now = now; this.demo = demo; this.record = null; this.listeners = new Set(); this.engine = null; this.tokens = new WeakMap(); this.tokenPlanners = new WeakMap(); this.recordArrays = new WeakMap(); this.cache = null;
  }
  async init() { await this.refresh(); return this; }
  snapshot() {
    const state = this.record?.state, zone = softwareZone(state, this.record?.settings);
    const minute = Math.floor(this.now() / 60000);
    if (this.cache && this.cacheState === state && this.cacheSettings === this.record?.settings && this.cacheMinute === minute) return this.snapshotView();
    const previous = this.cache && this.cacheState === state ? this.cache : null;
    if (state) entityIndex(state);
    this.currentToken = Object.freeze({}); if (state) this.tokens.set(this.currentToken, state);
    this.cacheState = state; this.cacheSettings = this.record?.settings; this.cacheMinute = minute;
    this.cache = { joined: Boolean(state && this.record?.settings.joined === true), planner: previous ? previous.planner : state ? stateToPlanner(state, { allowConflicts: true }) : { tasks: [], projects: [] },
      conflicts: previous ? previous.conflicts : conflictList(state), today: zone.timeZone ? wallTime(this.now(), zone.timeZone).slice(0, 10) : null,
      ...zone, longTermItems: previous ? previous.longTermItems : readFocusItems(state), loading: { tasks: false, reviews: this.unloaded.some(b => b.startsWith('reviews-')), habits: this.unloaded.some(b => b === 'habits' || b.startsWith('habits-')), records: this.unloaded.some(b => b.startsWith('records-')) }, loadingBuckets: [...this.unloaded], demo: this.demo, focus: previous ? previous.focus : focusStats(state), ...(previous ? { settings: previous.settings } : extras(state)) };
    this.tokenPlanners.set(this.currentToken, this.cache.planner);
    return this.snapshotView();
  }
  snapshotView() {
    const state = this.record?.state, view = { ...this.cache, editToken: this.currentToken };
    let rows;
    Object.defineProperty(view, 'records', { enumerable: true, configurable: true,
      get: () => {
        if (rows) return rows;
        if (!state) return rows = [];
        if (!this.recordArrays.has(state)) this.recordArrays.set(state, recordRows(state));
        return rows = this.recordArrays.get(state);
      }, set: value => { rows = value; }
    });
    return draftOf(view).proxy;
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  publish() { for (const listener of this.listeners) { try { listener(this.snapshot()); } catch { /* 一个视图异常不能把成功的事务伪装成失败 */ } } }
  async refresh() {
    for (;;) {
      const meta = await this.store.readMetadata();
      const names = !this.hydrated ? meta.buckets.filter(name => /^(tasks-\d{2}|projects|settings|indexes|meta|other|countdowns)$/.test(name)) : meta.buckets;
      if (this.storageVersion === meta.version && this.unloaded.length === meta.buckets.length - names.length) return this.snapshot();
      if (this.record && meta.dataVersion === this.loadedDataVersion && this.unloaded.length === meta.buckets.length - names.length) {
        this.record = { ...unwrapped(meta.record), state: this.record.state };
        this.storageVersion = meta.version; this.publish(); return this.snapshot();
      }
      try {
        const result = await this.store.readBuckets(names, meta.version), record = unwrapped(meta.record);
        if (record.state?.units) record.state = { ...record.state, units: Object.fromEntries(Object.values(result.buckets).flatMap(Object.entries)) };
        this.record = record; this.storageVersion = meta.version; this.loadedDataVersion = meta.dataVersion; this.loadedBuckets = result.buckets;
        this.unloaded = meta.buckets.filter(name => !names.includes(name)); this.cache = null;
        this.publish(); return this.snapshot();
      } catch (error) { if (error.code !== 'stale') throw error; }
    }
  }
  async ensureLoaded() {
    if (this.hydrated && !this.unloaded.length) return this.snapshot();
    if (!this.loadingPromise) this.loadingPromise = (async () => {
      await this.engine?.ensureLoaded?.();
      this.hydrated = true;
      try { return await this.refresh(); } catch (error) { this.hydrated = false; throw error; }
    })().finally(() => { this.loadingPromise = null; });
    return this.loadingPromise;
  }
  async saveUI(patch) {
    const record = await this.store.updateMetadata(r => { r.settings.taskUI = { ...r.settings.taskUI, ...copy(patch) }; });
    this.record = { ...this.record, settings: record.settings, token: record.token };
  }
  uiState() { return copy(this.record?.settings.taskUI || {}); }
  async selectTimeZone(timeZone) {
    new Intl.DateTimeFormat('zh-CN', { timeZone }).format(0);
    const unit = unitInfo(this.record?.state?.units[unitKey('setting', 'TimeZone')]).preferred;
    const saved = await this.store.updateMetadata(r => {
      r.settings.taskTimeZone = timeZone; r.settings.taskTimeZoneFor = unit && !unit.deleted ? decodeLegacy(unit.value) : '';
    }); this.record = { ...this.record, settings: saved.settings }; this.publish();
  }
  requireJoined() {
    if (!this.snapshot().joined) throw new DataError('先在设置里连接并完成第一次同步');
    if (!this.snapshot().timeZone) throw new DataError('请先在设置里选择软件时区。');
  }
  // 从本机待记会话生成单元。事务重试可能看到别的标签页已经记过这一轮，
  // 也可能发现同内容的另一轮先占了这个序号；两种情况分别判定。
  async saveFocusRecord(session, value) {
    await this.refresh();
    await this.ensureLoaded();
    const device = session.device, stamp = { updatedAt: session.ending.at, focusSession: session.id };
    const ownsSession = settings => settings.joined && settings.deviceId === device &&
      settings.focusTimer?.session?.id === session.id && Boolean(settings.focusTimer.session.ending);
    const recorded = unit => unit?.versions.some(v => v.sources.some(s => s.stamp.focusSession === session.id));
    // 升级前可能已按旧列值保存，随后未能清理会话。重试也要认出这个旧键。
    const legacyRetry = value.columns[4] !== session.subject || value.columns[7] !== session.link;
    if (legacyRetry && Object.values(this.record.state?.units || {}).some(recorded)) return true;
    for (let occurrence = 0; ; occurrence++) {
      const key = await recordKey(value.day, value.columns, occurrence), bucket = bucketOf(key);
      const known = this.record.state?.units[key];
      if (recorded(known)) return true;
      if (known) continue;
      if (this.record.envelope) {
        if (!this.engine?.commitUnits) throw new DataError('同步正在切换，请稍后重试保存番茄记录。');
        let outcome;
        await this.engine.commitUnits(emptyState(), [], { rebase: (latest, { settings }) => {
          const unit = latest.units[key], state = emptyState();
          if (recorded(unit) || legacyRetry && Object.values(latest.units).some(recorded)) outcome = 'saved';
          else if (!ownsSession(settings)) outcome = 'changed';
          else if (unit) outcome = 'occupied';
          else {
            outcome = 'saved';
            return { state: updateUnit(state, key, device, value, stamp), keys: [key] };
          }
          return { state, keys: [] };
        } });
        await this.refresh();
        if (outcome === 'occupied') continue;
        return outcome === 'saved';
      }
      try {
        const meta = await this.store.readMetadata(), { record } = meta;
        if (record.state?.format === 'yema-engine-local') {
          await this.refresh(); occurrence--; continue;
        }
        if (!ownsSession(record.settings)) return false;
        const { buckets } = await this.store.readBuckets([bucket], meta.version);
        const units = { ...buckets[bucket] };
        if (recorded(units[key]) || legacyRetry && Object.values(units).some(recorded)) return true;
        if (units[key]) continue;
        units[key] = updateUnit(emptyState(), key, device, value, stamp).units[key];
        await this.store.writeTransaction({ expectedVersion: meta.version, record, buckets: { [bucket]: units } });
        await this.refresh();
        return true;
      } catch (error) {
        if (error.code !== 'stale') throw error;
        await this.refresh(); occurrence--;
      }
    }
  }
  async change(description, mutator, { undoable = true, baseToken = null } = {}) {
    this.requireJoined();
    if (baseToken && !this.tokens.has(baseToken)) throw new DataError('编辑页面已过期，请重新打开。');
    const device = this.record.settings.deviceId, now = this.now(), observed = baseToken && this.tokens.get(baseToken);
    const base = observed || this.record.state;
    const before = baseToken && this.tokenPlanners.has(baseToken) ? this.tokenPlanners.get(baseToken) : base === this.cacheState ? this.cache.planner : stateToPlanner(base, { allowConflicts: true });
    const draft = draftOf(before), value = mutator(draft.proxy);
    if (value && typeof value.then === 'function') { Promise.resolve(value).catch(() => {}); throw new DataError('修改函数必须同步完成。'); }
    let after = draft.finish(), changes = entityDiff(before, after);
    for (const change of changes) if (change.collection === 'tasks') {
      if (change.before && repeating(change.before)) {
        const { goalId, ...beforeFields } = change.before;
        const { goalId: nextGoal, ...afterFields } = change.after || {};
        if (goalId === nextGoal || !same(beforeFields, afterFields)) throw new DataError(REPEAT_READONLY);
      }
      if (change.after) {
        // 不把缓存中共享的实体就地写坏。
        const row = { ...change.after, updated: new Date(now).toISOString() };
        after = { ...after, tasks: after.tasks.map(t => t.id === change.id ? row : t) }; change.after = row;
      }
    }
    const rootChanged = [...new Set([...Object.keys(before), ...Object.keys(after)])].some(key => !entityCollections.includes(key) && (own(before, key) !== own(after, key) || !same(before[key] ?? null, after[key] ?? null)));
    const layoutChanged = legacyCollections.some(c => own(before, c) !== own(after, c));
    if (!changes.length && !rootChanged && !layoutChanged) return null;
    if (this.unloaded.length && (rootChanged || layoutChanged)) throw new DataError('其他内容正在载入，请等待载入完成后再保存。');
    let editBranch, savedKeys = [], savedChanges = [], concurrent = false, committedGeneration, committedTaskRevision;
    const incremental = (this.engine?.commitUnits || !this.record.envelope) && !rootChanged && !layoutChanged;
    const prepare = (latest, metadata) => {
      if (incremental) latest = scopeEntities(latest, changes);
      if (metadata) {
        if (!metadata.settings.joined || metadata.settings.deviceId !== device) throw new DataError('本机连接状态已改变，请重新打开页面。');
        concurrent = metadata.dataVersion === undefined ? metadata.generation !== this.record.envelope.generation : metadata.dataVersion !== this.loadedDataVersion;
        committedGeneration = metadata.generation + 1; committedTaskRevision = (metadata.settings.taskRevision || 0) + 1;
      }
      const observedScope = observed && (incremental ? scopeEntities(observed, changes) : observed);
      let edited = latest, branchState = observedScope || latest; const allKeys = new Set(); savedChanges = [];
      for (const original of changes) {
        let change = { ...original }, branch = latest;
        if (observed) {
          const keys = change.collection === 'goalPlans' ?
            entityUnitKeys(latest, change.collection, change.id) : entityUnitKeys(base, change.collection, change.id);
          const newRemote = keys.some(key => {
            const seen = {};
            for (const v of base.units[key]?.versions || []) for (const [id, count] of Object.entries(v.vv)) seen[id] = Math.max(seen[id] || 0, count);
            return (latest.units[key]?.versions || []).some(v => Object.entries(v.vv).some(([id, count]) => id !== device && count > (seen[id] || 0)));
          });
          if (newRemote) branch = incremental ? scopeEntities(base, changes) : base;
        }
        if (branch === latest) {
          const current = readEntity(latest, change.collection, change.id, { allowConflicts: true });
          // 同一份本机库只初始化一次年度名称，刷新期间已有的初始化或改名优先。
          if (change.collection === 'goalYears' && !change.before && current) continue;
          if (change.before && change.after && current) {
            const row = copy(same(current, change.before) ? change.after : current);
            if (!same(current, change.before)) replayDiff(row, change.before, change.after);
            change = { ...change, before: current, after: row };
          } else if (change.before && !current && change.after) throw new DataError('内容已在另一页删除，请重新查看。');
          else change.before = current;
        }
        const result = entityEdit(branch, change, device, now);
        // 同设备计数只检查实际改过的单元。
        const subset = { schema: 1, units: Object.fromEntries(result.keys.map(key => [key, result.state.units[key]])), archives: {} };
        const old = { schema: 1, units: Object.fromEntries(result.keys.filter(key => branch.units[key]).map(key => [key, branch.units[key]])), archives: {} };
        advanceLocalCounters(subset, old, latest, device);
        const other = { schema: 1, units: Object.fromEntries(result.keys.filter(key => edited.units[key]).map(key => [key, edited.units[key]])), archives: {} };
        branchState = { ...branchState, units: { ...branchState.units, ...subset.units } };
        const combined = merge(other, subset);
        edited = { ...edited, units: { ...edited.units, ...combined.units } };
        for (const key of result.keys) allKeys.add(key);
        savedChanges.push(change);
      }
      if (rootChanged || layoutChanged) {
        // 根字段/集合是否存在的低频修改沿用原规则，不猜实体接口之外的含义。
        const view = stateToPlanner(edited, { allowConflicts: true }), next = copy(view);
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) if (!entityCollections.includes(key)) {
          if (own(after, key)) next[key] = copy(after[key]); else delete next[key];
        }
        for (const c of legacyCollections) if (own(before, c) !== own(after, c)) { if (own(after, c)) next[c] ||= []; else delete next[c]; }
        const extra = plannerEdit(edited, view, next, device, now);
        for (const key of Object.keys(extra.units)) if (!edited.units[key] || !same(extra.units[key], edited.units[key])) { allKeys.add(key); branchState = { ...branchState, units: { ...branchState.units, [key]: extra.units[key] } }; }
        edited = extra;
      }
      editBranch = incremental ? observedOverlay(observed || this.record.state, branchState) : branchState; savedKeys = [...allKeys]; return { state: edited, keys: savedKeys };
    };
    if (this.engine?.commit && this.record.envelope) {
      const initial = prepare(this.record.state);
      const oldState = this.record.state;
      const state = await (incremental ? this.engine.commitUnits(initial.state, initial.keys, { rebase: prepare }) : this.engine.commit(initial.state, initial.keys, { rebase: prepare }));
      if (!concurrent) inheritIndex(oldState, state, savedKeys);
      this.record = { ...this.record, state, envelope: { ...this.record.envelope, generation: committedGeneration }, settings: { ...this.record.settings, taskRevision: committedTaskRevision } };
      try {
        const meta = await this.store.readMetadata();
        if (meta.record.state?.generation === committedGeneration) {
          this.record = { ...unwrapped(meta.record), state }; this.storageVersion = meta.version; this.loadedDataVersion = meta.dataVersion;
        }
      } catch {
        // 事务已经成功，不能把后续元数据刷新失败误报为“未保存”。下次刷新重新读取。
        this.storageVersion = -1;
      }
    } else {
      // 示例/原始状态也用同一桶事务；其他页面改变业务版本时先重读再重放。
      for (;;) {
        const meta = await this.store.readMetadata(), r = unwrapped(meta.record);
        if (!r.state || r.settings.joined !== true || r.settings.deviceId !== device) throw new DataError('本机连接状态已改变，请重新打开页面。');
        if (meta.record.state.format === 'yema-engine-local') throw new DataError('请先接好同步引擎再修改。');
        let latest = this.record.state, buckets = this.loadedBuckets;
        if (meta.dataVersion !== this.loadedDataVersion) {
          try { const snapshot = await this.store.readBuckets(null, meta.version); buckets = snapshot.buckets; latest = { ...r.state, units: Object.fromEntries(Object.values(buckets).flatMap(Object.entries)) }; }
          catch (error) { if (error.code === 'stale') continue; throw error; }
        }
        concurrent = (r.settings.taskRevision || 0) !== (this.record.settings.taskRevision || 0);
        const prepared = prepare(latest), state = incremental ? { ...latest, units: { ...latest.units, ...prepared.state.units } } : prepared.state;
        if (prepared.keys.some(key => this.unloaded.includes(bucketOf(key)))) throw new DataError('这部分内容正在载入，请等待载入完成后再保存。');
        const writes = {};
        for (const key of prepared.keys) { const name = bucketOf(key); if (!own(writes, name)) writes[name] = { ...buckets[name] }; writes[name][key] = state.units[key]; }
        r.state = state; r.settings.taskRevision = (r.settings.taskRevision || 0) + 1;
        try {
          const saved = await this.store.writeTransaction({ expectedVersion: meta.version, record: r, buckets: writes });
          inheritIndex(latest, state, savedKeys); this.record = { ...saved.record, state };
          this.storageVersion = saved.version; this.loadedDataVersion = saved.dataVersion; this.loadedBuckets = { ...buckets, ...writes }; break;
        } catch (error) { if (error.code !== 'stale') throw error; }
      }
    }
    // 常见本机操作仅替换涉及的实体；远端/别的页面更新时允许全量重算。
    if (!rootChanged && !layoutChanged && !concurrent && this.cache) {
      const planner = { ...this.cache.planner };
      for (const collection of new Set(savedChanges.map(c => c.collection))) {
        const ids = new Set(savedChanges.filter(c => c.collection === collection).map(c => c.id));
        const rows = (planner[collection] || []).filter(row => !ids.has(rowId(row, collection)));
        for (const id of ids) { const row = readEntity(this.record.state, collection, id, { allowConflicts: true }); if (row) rows.push(row); }
        rows.sort((a, b) => rowId(a, collection) < rowId(b, collection) ? -1 : rowId(a, collection) > rowId(b, collection) ? 1 : 0);
        planner[collection] = rows;
      }
      // 冲突只检查涉及实体的单元，保留其余列表。
      const involved = new Set(savedKeys);
      const subset = { schema: 1, units: {}, archives: {} };
      for (const c of savedChanges) for (const key of entityUnitKeys(this.record.state, c.collection, c.id)) { involved.add(key); subset.units[key] = this.record.state.units[key]; }
      this.cache = { ...this.cache, planner, conflicts: [...this.cache.conflicts.filter(c => !involved.has(c.key)), ...conflictList(subset)].sort((a, b) => a.key < b.key ? -1 : 1) };
      if (this.recordArrays.has(this.cacheState)) this.recordArrays.set(this.record.state, this.recordArrays.get(this.cacheState));
      this.cacheState = this.record.state; this.cacheSettings = this.record.settings;
      this.currentToken = Object.freeze({}); this.tokens.set(this.currentToken, this.record.state); this.tokenPlanners.set(this.currentToken, this.cache.planner);
    } else this.cache = null;
    this.publish(); this.notifyEngine(description);
    const editToken = Object.freeze({}); this.tokens.set(editToken, editBranch);
    if (rootChanged || layoutChanged || concurrent) this.tokenPlanners.set(editToken, stateToPlanner(editBranch, { allowConflicts: true }));
    else {
      const projection = { ...before };
      for (const collection of new Set(savedChanges.map(c => c.collection))) {
        const ids = new Set(savedChanges.filter(c => c.collection === collection).map(c => c.id));
        const rows = (projection[collection] || []).filter(row => !ids.has(rowId(row, collection)));
        for (const id of ids) { const row = readEntity(editBranch, collection, id, { allowConflicts: true }); if (row) rows.push(row); }
        projection[collection] = rows.sort((a, b) => rowId(a, collection) < rowId(b, collection) ? -1 : rowId(a, collection) > rowId(b, collection) ? 1 : 0);
      }
      this.tokenPlanners.set(editToken, projection);
    }
    return { description, editToken, undo: undoable ? () => this.change('已撤销：' + description, p => reverseTasks(p, before, after), { undoable: false }) : null };
  }

  // choice: {branch, observed} / {type:'both', observed}。
  // observed 是界面实际展示的冲突；保存时与最新状态合并，后来到达的分支继续保留。
  async resolve(key, choice) {
    this.requireJoined();
    if (choice.observed && !this.tokens.has(choice.observed)) throw new DataError('冲突页面已过期，请重新查看。');
    const observedState = (choice.observed && this.tokens.get(choice.observed)) || this.record.state;
    const path = JSON.parse(key);
    if (path[0] === FOCUS_ITEMS) throw new DataError('长期事项请在电脑上修改。');
    const collection = { 'task-content': 'tasks', 'task-status': 'tasks', 'task-goal': 'tasks', step: 'tasks', project: 'projects', 'review-module': 'reviews', 'review-title': 'reviews', 'week-field': 'weekNotes',
      'habit-definition': 'habits', 'habit-check': 'habits', 'habit-journal': 'habits' }[path[0]];
    if ((collection === 'habits' || path[0] === 'entity' && path[1] === 'habits') && this.snapshot().loading.habits) throw new DataError('习惯正在载入，请稍候再处理冲突。');
    const relevant = [key]; if (collection) relevant.push(unitKey('entity', collection, path[1]));
    const base = copy({ schema: 1, units: Object.fromEntries(relevant.filter(k => observedState.units[k]).map(k => [k, observedState.units[k]])), archives: {} }), info = unitInfo(base.units[key]);
    if (!info.conflict) throw new DataError('这处冲突已改变，请重新查看。');
    let value, deleted = false;
    if (choice.type === 'both') {
      if (goalUnitKinds.includes(path[0])) throw new DataError('请选择要保留的一个版本。');
      const candidates = info.alternatives.map(v => ({ deleted: v.deleted, value: decodeLegacy(v.value) }));
      const unitPath = JSON.parse(key);
      value = unitPath[0] === 'review-module' ? reviewCombination(candidates, unitPath[2]) : textCombination(candidates);
      if (value === null) throw new DataError('这些字段不能直接拼在一起，请分别选择一份。');
      value = encodeLegacy(value);
    } else {
      const chosen = info.alternatives.find(v => branchKey(v) === choice.branch);
      if (!chosen) throw new DataError('所选版本不存在，请重新查看。');
      if (path[0] === 'record' && chosen.deleted) throw new DataError('要删除请在电脑上撤销这条记录。');
      value = chosen.value; deleted = chosen.deleted;
    }
    const now = this.now(), stamp = { updatedAt: now, legacyUpdated: new Date(now).toISOString() }, device = this.record.settings.deviceId;
    if (collection === 'habits' || goalUnitKinds.includes(path[0])) delete stamp.legacyUpdated; // 实体时间只放存在单元。
    if (path[0] === 'habit-check') stamp.legacyCheckEdit = encodeLegacy(new Date(now).toISOString());
    let edited = resolveUnit(base, key, device, value, stamp, { deleted });
    if (collection) {
      const entityKey = unitKey('entity', collection, path[1]);
      const entity = unitInfo(base.units[entityKey]);
      if (entity.conflict) throw new DataError(collection === 'habits' ? '请先确认保留习惯还是删除，再处理打卡或感想冲突。' : '请先确认保留任务还是删除，再处理字段冲突。');
      if (entity.preferred?.deleted) throw new DataError('这项内容已经删除，请重新查看。');
      edited = updateUnit(edited, entityKey, device, true, { updatedAt: now, ...(collection === 'habits' || path[0] === 'task-goal' ? { legacyUpdated: encodeLegacy(new Date(now).toISOString()) } : {}) });
    }
    const touched = Object.keys(edited.units).filter(k => !base.units[k] || !same(base.units[k], edited.units[k]));
    if (this.engine?.commit && this.record.envelope) {
      const incremental = Boolean(this.engine.commitUnits);
      let generation = this.record.envelope.generation, taskRevision = this.record.settings.taskRevision;
      const input = incremental ? edited : observedOverlay(observedState, edited);
      const state = await (incremental ? this.engine.commitUnits.bind(this.engine) : this.engine.commit.bind(this.engine))(input, touched, { rebase: (latest, metadata) => {
        advanceLocalCounters(edited, base, latest, device);
        if (metadata) { generation = metadata.generation + 1; taskRevision = (metadata.settings.taskRevision || 0) + 1; }
        const one = { schema: 1, units: Object.fromEntries(touched.map(k => [k, edited.units[k]])), archives: {} };
        const current = { schema: 1, units: Object.fromEntries(touched.filter(k => latest.units[k]).map(k => [k, latest.units[k]])), archives: {} };
        const combined = merge(current, one);
        return { state: incremental ? combined : observedOverlay(latest, combined), keys: touched };
      } });
      this.record = { ...this.record, state, envelope: { ...this.record.envelope, generation }, settings: { ...this.record.settings, taskRevision } }; this.cache = null;
    } else {
      for (;;) {
        const meta = await this.store.readMetadata(), r = meta.record;
        if (!r.state || !r.settings.joined || r.settings.deviceId !== device) throw new DataError('本机连接状态已改变。');
        const names = [...new Set(touched.map(bucketOf))];
        try {
          const snapshot = await this.store.readBuckets(names, meta.version), latest = { schema: 1, units: Object.fromEntries(Object.values(snapshot.buckets).flatMap(Object.entries)), archives: {} };
          advanceLocalCounters(edited, base, latest, device);
          const current = { schema: 1, units: Object.fromEntries(touched.filter(k => latest.units[k]).map(k => [k, latest.units[k]])), archives: {} };
          const combined = merge(current, edited), writes = {};
          for (const name of names) writes[name] = { ...snapshot.buckets[name] };
          for (const k of touched) writes[bucketOf(k)][k] = combined.units[k];
          r.settings.taskRevision = (r.settings.taskRevision || 0) + 1;
          await this.store.writeTransaction({ expectedVersion: meta.version, record: r, buckets: writes });
          // 处理冲突是低频操作；刷新其他页面可能同时改过的投影。
          await this.refresh(); break;
        } catch (error) { if (error.code !== 'stale') throw error; }
      }
    }
    this.publish(); this.notifyEngine('已处理两边都改过的内容');
  }
  // 接线约定：engine.subscribe 在“已提交本机事务”后通知；localChanged 只是唤醒引擎。
  // 引擎与数据来源必须共享同一个 store，不允许传入未落盘状态覆盖界面。
  attachEngine(engine) {
    this.detachEngine?.(); this.engine = engine;
    this.detachEngine = engine?.subscribe?.(() => { this.refresh().catch(() => {}); });
  }
  notifyEngine(description) {
    try { Promise.resolve(this.engine?.localChanged?.({ description })).catch(() => {}); } catch { /* 已存本机，联网失败不能回滚 */ }
  }
}
export async function createDataSource(options) { return new DataSource(options).init(); }
