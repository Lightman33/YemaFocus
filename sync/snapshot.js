// 规范文本、Web Crypto 哈希、快照文件名与内容校验。
// 返回文本和待发布的年度归档给传输层；本模块不联网、不保存文件。
import { canonical, exactKeys, put } from './canonical.js';
import { assertState, merge, normalize } from './merge.js';
import { assertDevice } from './vv.js';
import { partitionRecords, validDay } from './records.js';
export { canonical } from './canonical.js';

export async function sha256(value) {
  const text = canonical(value);
  return hashText(text);
}
export async function hashText(text) {
  // 规范文本全是 ASCII；拒绝把非规范 Unicode 文本当成规范字节串。
  if (typeof text !== 'string' || /[^\x00-\x7f]/.test(text)) throw new TypeError('哈希输入必须是规范 ASCII 文本');
  const bytes = Uint8Array.from(text, character => character.charCodeAt(0));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function fileName(device, sequence, hash, year = null) {
  assertDevice(device);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new TypeError('快照序号或哈希错误');
  if (year !== null && (typeof year !== 'string' || !/^\d{4}$/.test(year) || year === '0000')) throw new TypeError('归档年份错误');
  return device + '--' + sequence + '--' + hash + (year === null ? '' : '--archive-' + year) + '.json';
}
export function parseFileName(name) {
  if (typeof name !== 'string') return null;
  const match = /^([a-z0-9][a-z0-9-]{0,63})--([1-9]\d*)--([0-9a-f]{64})(?:--archive-(\d{4}))?\.json$/.exec(name);
  if (!match) return null;
  const [, device, seq, hash, year] = match, sequence = Number(seq);
  if (!Number.isSafeInteger(sequence) || String(sequence) !== seq || year === '0000') return null;
  return { device, sequence, hash, year: year || null };
}
async function artifact(snapshot) {
  const text = canonical(snapshot), hash = await hashText(text);
  return { snapshot, text, hash, fileName: fileName(snapshot.device, snapshot.sequence, hash, snapshot.year || null) };
}
export async function createSnapshot(state, device, sequence) {
  // 先校验参数，避免无效参数触发归档工作。
  fileName(device, sequence, '0'.repeat(64));
  const { recent, archives, window } = partitionRecords(state), artifacts = [];
  for (const year of Object.keys(archives).sort()) {
    const archiveState = normalize(archives[year]), stateHash = await sha256(archiveState);
    const existing = Object.entries(recent.archives).filter(([, ref]) => ref.device === device && ref.year === year && ref.stateHash === stateHash).sort(([a], [b]) => a < b ? -1 : 1)[0];
    if (existing) continue;
    const item = await artifact({ format: 'yema-sync-archive', schema: 1, device, sequence, year, state: archiveState });
    artifacts.push(item);
    put(recent.archives, item.fileName, { hash: item.hash, stateHash, year, device, sequence });
  }
  const result = await artifact({ format: 'yema-sync', schema: 1, device, sequence, recordWindow: window, state: normalize(recent) });
  return { ...result, archives: artifacts };
}
export async function verifySnapshot(name, text) {
  try {
    const parsed = parseFileName(name);
    if (!parsed || typeof text !== 'string') return { ok: false, reason: '文件名无效' };
    if (await hashText(text) !== parsed.hash) return { ok: false, reason: '哈希不符，忽略并在下次重读' };
    const snapshot = JSON.parse(text);
    if (canonical(snapshot) !== text) return { ok: false, reason: '不是规范文本（含重复键、空白或其他编码）' };
    const archive = parsed.year !== null;
    if (!exactKeys(snapshot, archive ? ['format', 'schema', 'device', 'sequence', 'year', 'state'] : ['format', 'schema', 'device', 'sequence', 'recordWindow', 'state']) || snapshot.schema !== 1 || snapshot.format !== (archive ? 'yema-sync-archive' : 'yema-sync') || snapshot.device !== parsed.device || snapshot.sequence !== parsed.sequence || (archive && snapshot.year !== parsed.year)) return { ok: false, reason: '快照头与文件名不符' };
    assertState(snapshot.state);
    if (archive) {
      if (Object.keys(snapshot.state.archives).length || Object.keys(snapshot.state.units).some(key => {
        const path = JSON.parse(key);
        return path[0] !== 'record' || snapshot.state.units[key].versions.some(version => version.deleted || !validDay(version.value.day) || !version.value.day.startsWith(parsed.year + '-'));
      })) return { ok: false, reason: '年度归档含其他类型的数据' };
    } else {
      const parts = partitionRecords(snapshot.state);
      if (canonical(snapshot.recordWindow) !== canonical(parts.window) || Object.keys(parts.archives).length) return { ok: false, reason: '主快照的明细窗口不符' };
    }
    return { ok: true, snapshot, hash: parsed.hash };
  } catch (error) { return { ok: false, reason: '损坏或不支持的快照：' + error.message }; }
}

// 年度归档不含窗口策略，因此不在此函数内再次计算 90 天分区。
export async function verifyArchive(refName, ref, text) {
  try {
    const parsed = parseFileName(refName), data = JSON.parse(text);
    if (!parsed || !parsed.year || parsed.hash !== ref.hash || parsed.device !== ref.device || parsed.sequence !== ref.sequence || parsed.year !== ref.year || await hashText(text) !== ref.hash || canonical(data) !== text) return { ok: false, reason: '归档名或哈希不符' };
    if (!exactKeys(data, ['format', 'schema', 'device', 'sequence', 'year', 'state']) || data.format !== 'yema-sync-archive' || data.schema !== 1 || data.device !== parsed.device || data.sequence !== parsed.sequence || data.year !== parsed.year) return { ok: false, reason: '归档头不符' };
    assertState(data.state);
    if (await sha256(data.state) !== ref.stateHash || Object.keys(data.state.archives).length) return { ok: false, reason: '归档状态哈希不符' };
    for (const [key, unit] of Object.entries(data.state.units)) {
      if (JSON.parse(key)[0] !== 'record' || unit.versions.some(version => version.deleted || !validDay(version.value.day) || !version.value.day.startsWith(parsed.year + '-'))) return { ok: false, reason: '归档包含其他年份或类型' };
    }
    return { ok: true, snapshot: data };
  } catch (error) { return { ok: false, reason: '归档损坏：' + error.message }; }
}
export function hydrateArchive(state, verifiedArchive) {
  if (!verifiedArchive.ok || verifiedArchive.snapshot.format !== 'yema-sync-archive') throw new TypeError('只能载入校验通过的归档');
  return merge(state, verifiedArchive.snapshot.state);
}
