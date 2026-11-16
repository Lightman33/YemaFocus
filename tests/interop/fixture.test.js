import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonical } from '../../sync/canonical.js';
import { generateFixture, fixtureDirectory, assertExport } from './make-fixture.js';

test('JS引擎确定性仓库及期望值与已交付夹具一致', async () => {
  const { repo, expected } = await generateFixture();
  const stored = await readFile(new URL('js-repo.json', fixtureDirectory), 'utf8');
  const storedExpected = await readFile(new URL('js-expected.json', fixtureDirectory), 'utf8');
  assertExport(JSON.parse(stored));
  assert.equal(stored, canonical(repo)); assert.equal(storedExpected, canonical(expected));
  assert.equal(expected.conflicts, 1); assert.deepEqual(expected.details.map(d => d.device), ['retired-js']);
  assert.ok(stored.length < 300_000);
});
