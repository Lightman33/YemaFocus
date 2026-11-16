import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonical } from '../../sync/canonical.js';
import { unitInfo } from '../../sync/merge.js';
import { hashText } from '../../sync/snapshot.js';
import { harness } from '../pack/helpers.js';
import { loadRepository } from './make-fixture.js';

test('C#发布的仓库可由新JS设备加入且得到相同状态', async t => {
  let repo, expected;
  try {
    repo = JSON.parse(await readFile(new URL('../../../source/tests/bin/interop-cs-repo.json', import.meta.url), 'utf8'));
    expected = JSON.parse(await readFile(new URL('../../../source/tests/bin/interop-cs-expected.json', import.meta.url), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    t.diagnostic('需要先在 Windows 上跑 C# 测试'); t.skip('C#导出文件尚未生成'); return;
  }
  assert.equal(expected.format, 'yema-interop-expected');
  const h = harness(); h.clock.value = expected.now;
  await loadRepository(h.memory, repo);
  const phone = await h.device('new-js-after-cs');
  const result = await phone.engine.join();
  assert.equal(result.ok, true); assert.equal(result.joined, true);
  assert.equal(await hashText(canonical(phone.engine.getState())), expected.joinedStateSha256);
  assert.deepEqual(unitInfo(phone.engine.getState().units[expected.editKey]).preferred.value, expected.editValue);
  assert.equal(Object.values(phone.engine.getState().units).filter(u => unitInfo(u).conflict).length, expected.conflicts);
  assert.equal(result.warning, expected.warning); assert.deepEqual(result.details, expected.details);
  phone.engine.dispose();
});
