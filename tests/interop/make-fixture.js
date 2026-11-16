// 只用固定设备号、固定虚构数据和注入时钟；不联网，不读取正式存储。
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical, unitKey as K } from '../../sync/canonical.js';
import { emptyState, unitInfo } from '../../sync/merge.js';
import { createUnit, updateUnit } from '../../sync/edit.js';
import { hashText } from '../../sync/snapshot.js';
import * as pack from '../../sync/pack.js';
import { harness } from '../pack/helpers.js';

export const fixtureDirectory = new URL('../../../sync-spec/interop/', import.meta.url);
export const encode = text => Uint8Array.from(text, c => c.charCodeAt(0));
const decode = bytes => String.fromCharCode(...bytes);
export function assertExport(repo) {
  if (repo.format !== 'yema-interop-repository' || repo.schema !== 1 || !Array.isArray(repo.files)) throw new Error('互通仓库格式错误');
  const paths = new Set();
  for (const { path, text } of repo.files) {
    if (typeof path !== 'string' || !path.startsWith(pack.ROOT + '/') || paths.has(path) || typeof text !== 'string' || /[^\x00-\x7f]/.test(text)) throw new Error('互通文件重复或非ASCII');
    paths.add(path);
  }
}
export async function exportRepository(memory, devices) {
  const paths = new Set();
  for (const d of await memory.list(pack.ROOT + '/devices')) paths.add(pack.ROOT + '/devices/' + d.name);
  for (const device of devices) {
    for (const entry of await memory.list(pack.ROOT + '/manifests/' + device)) {
      const path = pack.ROOT + '/manifests/' + device + '/' + entry.name;
      paths.add(path);
      const manifest = JSON.parse(decode(await memory.get(path)));
      for (const hash of Object.values(manifest.buckets)) {
        const chunkPath = pack.chunkPath(hash);
        try { await memory.get(chunkPath); paths.add(chunkPath); } catch (e) { if (e.code !== 'notfound') throw e; }
      }
    }
  }
  // list 只返回直接文件，按 256 个合法哈希前缀枚举，包含不再被最新清单引用的旧块。
  for (let n = 0; n < 256; n++) {
    const directory = pack.ROOT + '/chunks/' + n.toString(16).padStart(2, '0');
    try { for (const entry of await memory.list(directory)) paths.add(directory + '/' + entry.name); }
    catch (e) { if (e.code !== 'notfound') throw e; }
  }
  const files = [];
  for (const path of [...paths].sort()) files.push({ path, text: decode(await memory.get(path)) });
  const repo = { format: 'yema-interop-repository', schema: 1, files }; assertExport(repo); return repo;
}
export async function loadRepository(memory, repo) {
  assertExport(repo);
  for (const file of repo.files) await memory.put(file.path, encode(file.text));
}
export async function generateFixture() {
  const h = harness();
  const ids = ['desktop-js', 'phone-js', 'retired-js', 'new-js'];
  const task = K('task-content', 'fiction-task-1'), status = K('task-status', 'fiction-task-1');
  const other = K('task-content', 'fiction-task-2'), note = K('task-content', 'fiction-note');
  let initial = emptyState();
  for (const [key, value] of [
    [K('entity', 'tasks', 'fiction-task-1'), true], [task, { id: 'fiction-task-1', title: '虚构：整理学习卡片', note: '' }],
    [status, { done: false, abandoned: false, abandonReason: '' }],
    [K('entity', 'tasks', 'fiction-task-2'), true], [other, { id: 'fiction-task-2', title: '虚构：画一张植物图' }],
    [K('task-status', 'fiction-task-2'), { done: false, abandoned: false, abandonReason: '' }],
    [note, { id: 'fiction-note', title: '虚构：并发备注', note: '原始虚构备注' }],
    [K('setting', 'TimeZone'), 'China Standard Time']
  ]) initial = createUnit(initial, key, 'desktop-js', value);
  const desktop = await h.device('desktop-js', initial); await desktop.engine.syncNow();
  const phone = await h.device('phone-js'); await phone.engine.join();
  async function change(device, key, value) {
    const state = device.engine.getState();
    await device.engine.commit(Object.hasOwn(state.units, key) ? updateUnit(state, key, device.id, value) : createUnit(state, key, device.id, value), [key]);
  }
  h.clock.advance();
  await change(phone, K('entity', 'tasks', 'fiction-task-3'), true);
  await change(phone, K('task-content', 'fiction-task-3'), { id: 'fiction-task-3', title: '虚构：手机新建叶片观察', note: '' });
  await change(phone, K('task-status', 'fiction-task-3'), { done: false, abandoned: false, abandonReason: '' });
  await change(phone, task, { id: 'fiction-task-1', title: '虚构：整理两组学习卡片', note: '手机修改' });
  await change(phone, status, { done: true, abandoned: false, abandonReason: '' });
  await change(phone, K('review-module', 'day:2026-11-13', '收获', '0'), '虚构复盘：完成植物观察。');
  await change(phone, K('habit-check', 'fiction-walk', '2026-11-13'), true);
  await phone.engine.syncNow(); await desktop.engine.syncNow();
  h.clock.advance();
  await change(desktop, K('task-status', 'fiction-task-2'), { done: false, abandoned: true, abandonReason: '虚构：本周改为阅读' });
  await change(desktop, K('review-module', 'day:2026-11-13', '计划', '0'), '虚构复盘：明天观察叶片。');
  await desktop.engine.syncNow(); await phone.engine.syncNow();
  h.clock.advance();
  await change(desktop, other, { id: 'fiction-task-2', title: '虚构：植物图留待下周' });
  await change(phone, task, { id: 'fiction-task-1', title: '虚构：卡片已经归档', note: '另一任务并发修改' });
  await change(desktop, note, { id: 'fiction-note', title: '虚构：并发备注', note: '电脑写下的虚构备注' });
  await change(phone, note, { id: 'fiction-note', title: '虚构：并发备注', note: '手机写下的虚构备注' });
  await desktop.engine.syncNow(); await phone.engine.syncNow(); h.clock.advance(); await desktop.engine.syncNow();
  // 退役设备保留上一份完整清单，新清单缺一个块。
  const retired = await h.device('retired-js'); await retired.engine.join(); h.clock.advance();
  await change(retired, K('root', 'fiction-retired-only'), '虚构退役设备未完整上传');
  await retired.engine.syncNow(); retired.engine.dispose();
  const entries = await h.memory.list(pack.ROOT + '/manifests/retired-js');
  const latest = entries.map(e => ({ path: pack.ROOT + '/manifests/retired-js/' + e.name, sequence: +e.name.split('--')[0] })).sort((a, b) => b.sequence - a.sequence)[0];
  const manifest = JSON.parse(decode(await h.memory.get(latest.path)));
  await h.memory.remove(pack.chunkPath(manifest.buckets.meta));
  const aResult = await desktop.engine.syncNow(), bResult = await phone.engine.syncNow();
  const newcomer = await h.device('new-js'); const result = await newcomer.engine.join();
  const states = {};
  for (const device of [desktop, phone, retired, newcomer]) states[device.id] = await hashText(canonical(device.engine.getState()));
  const conflicts = Object.values(newcomer.engine.getState().units).filter(u => unitInfo(u).conflict).length;
  if (!result.joined || conflicts !== 1 || !result.warning || canonical(desktop.engine.getState()) !== canonical(phone.engine.getState())) throw new Error('虚构场景没有形成预期的一处冲突和一处警告');
  const repo = await exportRepository(h.memory, ids);
  const expected = { format: 'yema-interop-expected', schema: 1, now: h.clock.now(), states,
    joinedStateSha256: states['new-js'], conflicts, warning: result.warning, details: result.details,
    desktopWarning: aResult.warning, phoneWarning: bResult.warning,
    editKey: other, editValue: { id: 'fiction-task-2', title: '虚构：C# 电脑完成互通修改' } };
  for (const device of [desktop, phone, newcomer]) device.engine.dispose();
  return { repo, expected };
}
export async function writeFixture() {
  const { repo, expected } = await generateFixture(); await mkdir(fixtureDirectory, { recursive: true });
  await writeFile(new URL('js-repo.json', fixtureDirectory), canonical(repo));
  await writeFile(new URL('js-expected.json', fixtureDirectory), canonical(expected));
  console.log('已生成确定性虚构夹具：' + repo.files.length + ' 个仓库文件；' + canonical(repo).length + ' 字节；冲突 ' + expected.conflicts + '；警告设备 ' + expected.details.map(d => d.device).join(','));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))) await writeFixture();
