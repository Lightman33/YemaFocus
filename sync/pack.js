// 分块纯函数：仅使用规范编码、合并校验及 snapshot.js 的 Web Crypto SHA-256。
// create* 返回 {chunk|manifest,text,hash,path}；verify*(path,text) 返回 {ok,...}，失败 reason。
import { canonical, clone, exactKeys, object, put } from './canonical.js';
import { assertState, emptyState } from './merge.js';
import { assertDevice } from './vv.js';
import { hashText } from './snapshot.js';

export const ROOT = 'yema-sync/v1';
const HASH = /^[0-9a-f]{64}$/;
const positive = n => Number.isSafeInteger(n) && n > 0;
function dayMonth(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const y = +day.slice(0, 4), m = +day.slice(5, 7), d = +day.slice(8);
  const days = m === 2 ? (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
  return y > 0 && m >= 1 && m <= 12 && d >= 1 && d <= days ? day.slice(0, 7) : null;
}
function reviewMonth(id) {
  const match = /^(day|week|month|quarter|year):(\d{4}-\d{2}-\d{2})$/.exec(id);
  if (match) return dayMonth(match[2]);
  const custom = /^custom:(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/.exec(id);
  return custom && dayMonth(custom[2]) ? dayMonth(custom[1]) : null;
}
function taskBucket(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
  return 'tasks-' + String(h % 64).padStart(2, '0');
}
export function bucketOf(key) {
  let p;
  try { p = JSON.parse(key); } catch { return 'other'; }
  if (!Array.isArray(p) || !p.length || p.some(x => typeof x !== 'string') || canonical(p) !== key) return 'other';
  const [kind, id, field] = p;
  if ((['task-content', 'task-status'].includes(kind) && p.length === 2) || (kind === 'step' && p.length === 3)) return taskBucket(id);
  if (['entity', 'layout'].includes(kind) && p.length === 3) {
    if (id === 'tasks') return taskBucket(field);
    if (id === 'reviews') return 'reviews-' + (reviewMonth(field) || 'undated');
    if (kind === 'entity' && id === 'weekNotes') return 'reviews-' + (dayMonth(field) || 'undated');
    if (id === 'habits') return 'habits';
    if (kind === 'entity' && ['projects', 'countdowns'].includes(id)) return id;
    return 'other';
  }
  if ((['review-meta', 'review-title', 'review-score'].includes(kind) && p.length === 2) || (kind === 'review-module' && p.length === 4)) return 'reviews-' + (reviewMonth(id) || 'undated');
  if ((kind === 'week-meta' && p.length === 2) || (kind === 'week-field' && p.length === 3)) return 'reviews-' + (dayMonth(id) || 'undated');
  if (['habit-check', 'habit-journal'].includes(kind) && p.length === 3) return 'habits-' + (dayMonth(field) || 'undated');
  if (kind === 'habit-definition' && p.length === 2) return 'habits';
  if (kind === 'project' && p.length === 2) return 'projects';
  if (kind === 'countdown' && p.length === 2) return 'countdowns';
  if (kind === 'record' && p.length === 2) return 'records-' + (id[10] === ':' && dayMonth(id.slice(0, 10)) || 'undated');
  if (kind === 'setting' && p.length === 2) return 'settings';
  if (['planner-layout', 'csv-layout'].includes(kind) && p.length === 1) return 'indexes';
  if (['root', 'legacy-deleted', 'sync-policy'].includes(kind) && p.length === 2) return 'meta';
  return 'other';
}
export function validBucket(bucket) {
  return typeof bucket === 'string' && (/^(habits|projects|countdowns|settings|indexes|meta|other)$/.test(bucket) || /^tasks-(0[0-9]|[1-5][0-9]|6[0-3])$/.test(bucket) || /^(reviews|habits|records)-undated$/.test(bucket) || (() => {
    const m = /^(reviews|habits|records)-(\d{4}-\d{2})$/.exec(bucket);
    return Boolean(m && dayMonth(m[2] + '-01'));
  })());
}
function assertPackState(state) {
  assertState(state);
  if (Object.keys(state.archives).length) throw new TypeError('分块第一版不接受年度归档引用，请先完成显式迁移');
}
function assertChunk(chunk) {
  if (!exactKeys(chunk, ['format', 'schema', 'bucket', 'units']) || chunk.format !== 'yema-chunk' || chunk.schema !== 1 || !validBucket(chunk.bucket) || !object(chunk.units) || !Object.keys(chunk.units).length) throw new TypeError('块结构或桶名错误');
  assertPackState({ schema: 1, units: chunk.units, archives: {} });
  if (Object.keys(chunk.units).some(key => bucketOf(key) !== chunk.bucket)) throw new TypeError('单元放入了错误的桶');
}
export function splitState(state) {
  assertPackState(state);
  const result = {};
  for (const key of Object.keys(state.units).sort()) {
    const bucket = bucketOf(key);
    if (!Object.hasOwn(result, bucket)) put(result, bucket, { format: 'yema-chunk', schema: 1, bucket, units: {} });
    put(result[bucket].units, key, clone(state.units[key]));
  }
  return result;
}
export function joinChunks(chunks) {
  if (!Array.isArray(chunks)) throw new TypeError('块列表必须为数组');
  const state = emptyState();
  const seen = new Set();
  for (const chunk of chunks) {
    assertChunk(chunk);
    if (seen.has(chunk.bucket)) throw new TypeError('同一清单不能重复一个桶');
    seen.add(chunk.bucket);
    for (const [key, unit] of Object.entries(chunk.units)) put(state.units, key, clone(unit));
  }
  assertPackState(state);
  return state;
}
export function chunkPath(hash) {
  if (typeof hash !== 'string' || !HASH.test(hash)) throw new TypeError('块哈希错误');
  return ROOT + '/chunks/' + hash.slice(0, 2) + '/' + hash + '.json';
}
export function parseChunkPath(path) {
  if (typeof path !== 'string') return null;
  const m = /^yema-sync\/v1\/chunks\/([0-9a-f]{2})\/([0-9a-f]{64})\.json$/.exec(path);
  return m && m[1] === m[2].slice(0, 2) ? { hash: m[2] } : null;
}
export function manifestPath(device, sequence, hash) {
  assertDevice(device);
  if (!positive(sequence) || typeof hash !== 'string' || !HASH.test(hash)) throw new TypeError('清单序号或哈希错误');
  return ROOT + '/manifests/' + device + '/' + sequence + '--' + hash + '.json';
}
export function parseManifestPath(path) {
  if (typeof path !== 'string') return null;
  const m = /^yema-sync\/v1\/manifests\/([a-z0-9][a-z0-9-]{0,63})\/([1-9]\d*)--([0-9a-f]{64})\.json$/.exec(path);
  if (!m || !positive(+m[2]) || String(+m[2]) !== m[2]) return null;
  return { device: m[1], sequence: +m[2], hash: m[3] };
}
export function devicePath(device) { assertDevice(device); return ROOT + '/devices/' + device + '.json'; }
export function deviceText(device) { assertDevice(device); return canonical({ format: 'yema-device', schema: 1, device }); }
export function parseDevicePath(path) {
  if (typeof path !== 'string') return null;
  const m = /^yema-sync\/v1\/devices\/([a-z0-9][a-z0-9-]{0,63})\.json$/.exec(path);
  return m ? { device: m[1] } : null;
}
function assertManifest(m) {
  if (!exactKeys(m, ['format', 'schema', 'device', 'sequence', 'buckets', 'seen']) || m.format !== 'yema-manifest' || m.schema !== 1 || !positive(m.sequence) || !object(m.buckets) || !object(m.seen)) throw new TypeError('清单结构错误');
  assertDevice(m.device);
  for (const [bucket, hash] of Object.entries(m.buckets)) if (!validBucket(bucket) || typeof hash !== 'string' || !HASH.test(hash)) throw new TypeError('清单桶表错误');
  for (const [device, sequence] of Object.entries(m.seen)) {
    assertDevice(device);
    if (device === m.device || !positive(sequence)) throw new TypeError('合并确认序号错误');
  }
}
export async function createChunk(chunk) {
  assertChunk(chunk);
  const value = clone(chunk), text = canonical(value), hash = await hashText(text);
  return { chunk: value, text, hash, path: chunkPath(hash) };
}
export async function createManifest(device, sequence, buckets, seen = {}) {
  const manifest = clone({ format: 'yema-manifest', schema: 1, device, sequence, buckets, seen });
  assertManifest(manifest);
  const text = canonical(manifest), hash = await hashText(text);
  return { manifest, text, hash, path: manifestPath(device, sequence, hash) };
}
async function verify(path, text, parser, field, check) {
  try {
    const header = parser(path);
    if (!header) throw new TypeError('路径格式错误');
    if (await hashText(text) !== header.hash) throw new TypeError('哈希不符，请下次重读');
    const value = JSON.parse(text);
    if (canonical(value) !== text) throw new TypeError('不是规范文本，可能有重复字段、空白或错误编码');
    check(value);
    if (field === 'manifest' && (value.device !== header.device || value.sequence !== header.sequence)) throw new TypeError('清单头与路径不符');
    return { ok: true, [field]: value, hash: header.hash, text, path };
  } catch (error) { return { ok: false, reason: error.message }; }
}
export function verifyChunk(path, text) { return verify(path, text, parseChunkPath, 'chunk', assertChunk); }
export function verifyManifest(path, text) { return verify(path, text, parseManifestPath, 'manifest', assertManifest); }
