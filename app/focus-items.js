import { unitInfo } from '../sync/merge.js';
import { unitKey } from '../sync/canonical.js';
import { normalizeTask } from './review-model.js';

export const FOCUS_ITEMS = 'focus-items';
export const focusItemsKey = device => unitKey(FOCUS_ITEMS, device);

// 只取最近一次发布的那份清单（Claude v3.0）：电脑关闭再开启同步会换设备号，
// 旧设备号的清单留在仓库里；若取并集，电脑上删掉的事项会永远留在手机上。
export function readFocusItems(state) {
  let latest = null, latestAt = -1;
  const prefix = '["' + FOCUS_ITEMS + '",';
  for (const key of Object.keys(state?.units || {}).filter(key => key.startsWith(prefix)).sort()) {
    const [, device, ...rest] = JSON.parse(key);
    if (!device || rest.length) continue;
    const list = unitInfo(state.units[key]).preferred;
    if (!list || list.deleted || !Array.isArray(list.value) || !list.value.every(item => typeof item === 'string')) continue;
    const at = Math.max(-1, ...(list.sources || []).map(s => Number(s?.stamp?.updatedAt) || 0));
    if (at >= latestAt) { latest = list.value; latestAt = at; }
  }
  if (!latest) return null;
  const items = new Set();
  for (const raw of latest) {
    const item = normalizeTask(raw);
    if (item) items.add(item);
  }
  return [...items];
}
