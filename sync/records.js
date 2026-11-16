// 番茄记录的窗口以状态中明确写入的软件日期为准，不读取本机时间。
// 归档只是分区，不是删除；并发窗口取较早日期以保留更多明细。
import { clone, own, put, unitKey } from './canonical.js';
import { emptyState, normalize, unitInfo } from './merge.js';

export const RECORD_WINDOW_KEY = unitKey('sync-policy', 'record-window');
export function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)), d = Number(day.slice(8, 10));
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= monthDays(y, m);
}
function monthDays(year, month) {
  return month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
}
export function firstRecordDay(asOfDay) {
  if (!validDay(asOfDay)) throw new TypeError('窗口日期须为 yyyy-MM-dd');
  let year = Number(asOfDay.slice(0, 4)), month = Number(asOfDay.slice(5, 7)), day = Number(asOfDay.slice(8, 10));
  for (let i = 0; i < 89; i++) {
    day--;
    if (!day) { month--; if (!month) { month = 12; year--; } day = monthDays(year, month); }
    if (year < 1) return '0001-01-01';
  }
  return String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}
export function recordWindow(state) {
  const info = unitInfo(own(state.units, RECORD_WINDOW_KEY) ? state.units[RECORD_WINDOW_KEY] : null);
  const dates = info.alternatives.filter(version => !version.deleted).map(version => version.value.asOfDay);
  if (!dates.length || dates.some(day => !validDay(day))) throw new TypeError('发布记录前需要明确的 record-window 单元');
  const asOfDay = dates.sort()[0];
  return { asOfDay, firstDay: firstRecordDay(asOfDay) };
}
export function partitionRecords(state) {
  const normalized = normalize(state), recordKeys = Object.keys(normalized.units).filter(key => {
    try { return JSON.parse(key)[0] === 'record'; } catch { return false; }
  });
  const recent = clone(normalized), archives = {};
  const window = recordKeys.length || own(normalized.units, RECORD_WINDOW_KEY) ? recordWindow(normalized) : null;
  for (const key of recordKeys) {
    const versions = normalized.units[key].versions;
    // 墓碑留在主状态；跨年冲突和日期不完整的记录也留在主状态。
    if (versions.some(version => version.deleted || !validDay(version.value.day) || version.value.day >= window.firstDay)) continue;
    const years = [...new Set(versions.map(version => version.value.day.slice(0, 4)))];
    if (years.length !== 1) continue;
    const year = years[0];
    if (!own(archives, year)) put(archives, year, emptyState());
    put(archives[year].units, key, normalized.units[key]);
    delete recent.units[key];
  }
  return { recent, archives, window };
}
// 测试向量和 C# 实现可用此纯函数比较分区，不必访问任何文件。
export function partitionSummary(state) {
  const parts = partitionRecords(state);
  return { window: parts.window, recent: Object.keys(parts.recent.units).sort(),
    archives: Object.fromEntries(Object.keys(parts.archives).sort().map(year => [year, Object.keys(parts.archives[year].units).sort()])) };
}
