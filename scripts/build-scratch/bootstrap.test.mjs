import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { SCRATCH_ROOT, resolveScratchRoot, inspectManaged, encodedInvocation, requireScratchOutput } from './bootstrap.mjs';

const run = path.win32.join(SCRATCH_ROOT, 'a'.repeat(32));
const temp = path.win32.join(run, 'temp');
const artifacts = path.win32.join(run, 'artifacts');
const env = { EDENA_SCRATCH_MANAGED: '1', EDENA_SCRATCH_RUN: run, EDENA_SCRATCH_TEMP: temp, EDENA_ARTIFACTS_DIR: artifacts, TEMP: temp, TMP: temp };
const owner = { Schema: 1, RunId: 'a'.repeat(32), Root: SCRATCH_ROOT, Temp: temp, Nonce: 'b'.repeat(32) };
const io = { lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }), realpathSync: p => p, readFileSync: p => p.endsWith('OWNER.json') ? JSON.stringify(owner) : owner.Nonce };
test('managed context validates all paths and owner before reuse', () => {
  assert.deepEqual(inspectManaged(env, io), { run, temp, artifacts });
  for (const patch of [{ TMP: 'C:\\temp' }, { EDENA_SCRATCH_RUN: SCRATCH_ROOT }, { EDENA_ARTIFACTS_DIR: 'E:\\elsewhere' }, { EDENA_SCRATCH_RUN: 'E:\\unowned\\' + 'a'.repeat(32) }]) assert.throws(() => inspectManaged({ ...env, ...patch }, io));
  assert.throws(() => inspectManaged(env, { ...io, realpathSync: () => 'D:\\redirected' }));
  assert.throws(() => inspectManaged(env, { ...io, readFileSync: () => '{}' }));
});
test('PowerShell receives arbitrary arguments as JSON data', () => {
  const input = { wrapper: 'C:\\quoted path\\Run-WithScratch.ps1', executable: 'C:\\node.exe', args: ['a b', 'quote"', '$env:HOME', '`tick`', 'trailing\\', ''], cwd: 'C:\\work', kind: 'build' };
  const text = Buffer.from(encodedInvocation(input), 'base64').toString('utf16le');
  const payload = text.match(/FromBase64String\('([^']+)'\)/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64').toString()), input);
  assert.ok(!text.includes('$env:HOME'));
});
test('outside-root output and relative paths fail closed', () => {
  for (const value of [SCRATCH_ROOT + '-outside', 'out', 'E:relative', '\\\\server\\share']) assert.throws(() => requireScratchOutput(value));
});

test('scratch root uses per-user defaults and accepts an explicit local directory', () => {
  assert.equal(resolveScratchRoot({LOCALAPPDATA:'C:/Users/Example/AppData/Local'}), path.win32.normalize('C:/Users/Example/AppData/Local/KRAB/scratch'));
  assert.equal(resolveScratchRoot({KRAB_SCRATCH_ROOT:'F:/Build Scratch/'}), path.win32.normalize('F:/Build Scratch'));
  for (const v of ['', 'out', 'C:relative', 'C:/', '//server/share', 'C:/x/..', 'C:/x:stream']) assert.throws(() => resolveScratchRoot({KRAB_SCRATCH_ROOT:v}));
  assert.throws(() => resolveScratchRoot({}));
  assert.equal(requireScratchOutput(path.win32.join(SCRATCH_ROOT, 'child')), path.win32.join(SCRATCH_ROOT, 'child'));
  assert.throws(() => requireScratchOutput(SCRATCH_ROOT + '-sibling/child'));
  assert.throws(() => requireScratchOutput(path.win32.join(SCRATCH_ROOT, '..', 'escape')));
});
