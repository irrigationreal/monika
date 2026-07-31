import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { removeAcknowledgedResultWithCustody, trustedDeliveryAcknowledgement, writeSubagentDeliveryAck } from '../src/subagent-lifecycle.mjs';

test('delivery acknowledgement publication never replaces a concurrent conflict', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-ack-race-'));
  try {
    const lifecycleRoot = path.join(root, 'lifecycle'); const resultsRoot = path.join(root, 'results'); const operatorRoot = path.join(root, 'operator'); const asyncDir = path.join(lifecycleRoot, 'race');
    await mkdir(asyncDir, { recursive: true }); await mkdir(resultsRoot); await mkdir(operatorRoot); const resultFile = path.join(resultsRoot, 'race.json'); await writeFile(resultFile, '{}');
    const conflicting = { version: 1, kind: 'completion-delivery', runId: 'race', runKey: 'top:race', resultSha256: 'f'.repeat(64), resultSize: 2, proofKind: 'other', proofReference: 'other', acknowledgedAt: 1 };
    await assert.rejects(() => writeSubagentDeliveryAck({ lifecycleRoot, asyncDir, resultsRoot, operatorRoot, runId: 'race', proofKind: 'notification', proofReference: 'message-1',
      beforePublish: () => writeFile(path.join(asyncDir, 'delivery-ack.json'), JSON.stringify(conflicting)) }), /conflicting delivery acknowledgement/);
    assert.deepEqual(JSON.parse(await readFile(path.join(asyncDir, 'delivery-ack.json'), 'utf8')), conflicting);
    assert.equal(await readFile(resultFile, 'utf8'), '{}');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a durable ledger intent reconstructs the exact acknowledgement after publication failure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-ledger-retry-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lifecycleRoot = path.join(root, 'lifecycle'); const resultsRoot = path.join(root, 'results'); const operatorRoot = path.join(root, 'operator'); const asyncDir = path.join(lifecycleRoot, 'run');
  await mkdir(asyncDir, { recursive: true }); await mkdir(resultsRoot); await mkdir(operatorRoot); const resultFile = path.join(resultsRoot, 'run.json'); await writeFile(resultFile, '{}');
  await assert.rejects(() => writeSubagentDeliveryAck({ lifecycleRoot, asyncDir, resultsRoot, operatorRoot, runId: 'run', proofKind: 'canonical-message-provenance', proofReference: 'entry:message', beforePublish: () => { throw new Error('publish failed'); } }), /publish failed/);
  await assert.rejects(() => access(path.join(asyncDir, 'delivery-ack.json'))); assert.equal(await readFile(resultFile, 'utf8'), '{}');
  const retried = await writeSubagentDeliveryAck({ lifecycleRoot, asyncDir, resultsRoot, operatorRoot, runId: 'run', proofKind: 'canonical-message-provenance', proofReference: 'entry:message' });
  const ackBytes = await readFile(path.join(asyncDir, 'delivery-ack.json'));
  assert.equal(await trustedDeliveryAcknowledgement(operatorRoot, retried.ack, ackBytes), true);
});

test('central acknowledgement audit failure preserves the pending result', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-ledger-failure-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lifecycleRoot = path.join(root, 'lifecycle'); const resultsRoot = path.join(root, 'results'); const operatorRoot = path.join(root, 'operator'); const asyncDir = path.join(lifecycleRoot, 'run');
  await mkdir(asyncDir, { recursive: true }); await mkdir(resultsRoot); await mkdir(operatorRoot); await mkdir(path.join(operatorRoot, 'delivery-acknowledgements.jsonl'));
  const resultFile = path.join(resultsRoot, 'run.json'); await writeFile(resultFile, '{}');
  await assert.rejects(() => writeSubagentDeliveryAck({ lifecycleRoot, asyncDir, resultsRoot, operatorRoot, runId: 'run', proofKind: 'notification', proofReference: 'message-1' }));
  assert.equal(await readFile(resultFile, 'utf8'), '{}'); await assert.rejects(() => access(path.join(asyncDir, 'delivery-ack.json')));
});

test('custody rename restores a swapped newer result instead of deleting it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-custody-swap-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'result.json'); const displaced = path.join(root, 'old.json');
  await writeFile(source, 'old');
  const ack = { resultSha256: 'cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4', resultSize: 3 };
  await assert.rejects(() => removeAcknowledgedResultWithCustody(source, ack, { beforeCustody: async () => {
    await rename(source, displaced); await writeFile(source, 'new-generation');
  } }), /source restored/);
  assert.equal(await readFile(source, 'utf8'), 'new-generation'); assert.equal(await readFile(displaced, 'utf8'), 'old');
  assert.equal((await readdir(root)).some((name) => name.includes('.custody.')), false);
});

test('a matching custody file left by interruption is recovered without requiring the source pathname', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-custody-recover-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'result.json'); await writeFile(source, 'old');
  const ack = { resultSha256: 'cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4', resultSize: 3 };
  await assert.rejects(() => removeAcknowledgedResultWithCustody(source, ack, { afterCapture: () => { throw new Error('crash'); } }), /crash/);
  await assert.rejects(() => access(source));
  const custodyName = (await readdir(root)).find((name) => name.includes('.custody.')); assert.ok(custodyName);
  assert.deepEqual(await removeAcknowledgedResultWithCustody(source, ack), { removed: true, custody: path.join(root, custodyName), recovered: true });
  assert.equal((await readdir(root)).some((name) => name.includes('.custody.')), false);
});

test('mismatched custody is retained when a new source generation appears', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-custody-retain-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'result.json'); await writeFile(source, 'mismatch');
  const ack = { resultSha256: 'cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4', resultSize: 3 };
  await assert.rejects(() => removeAcknowledgedResultWithCustody(source, ack, { afterCapture: () => writeFile(source, 'new-generation') }), /custody retained/);
  assert.equal(await readFile(source, 'utf8'), 'new-generation');
  const custody = (await readdir(root)).find((name) => name.includes('.custody.')); assert.ok(custody); assert.equal(await readFile(path.join(root, custody), 'utf8'), 'mismatch');
  await access(source);
});
