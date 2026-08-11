import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from '../db';
import { ForumStore } from '../store';
import { AttachmentHandoffService } from './attachmentHandoffService';

describe('AttachmentHandoffService', () => {
  let db: Database.Database;
  let store: ForumStore;
  let dir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
    dir = mkdtempSync(join(tmpdir(), 'forum-handoff-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function fixture(bytes: Buffer, expectedSha256 = createHash('sha256').update(bytes).digest('hex')) {
    const forum = store.createForum('Forum');
    const human = store.createIdentity('Human', 'human');
    const robot = store.createIdentity('Monika', 'robot');
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'hello', authorId: human.id });
    const session = store.ensureSession({ topicId: topic.id });
    store.upsertPiSessionLink({ piSessionId: 'pi-session', piSessionPath: '/tmp/pi.jsonl', topicId: topic.id, sessionId: session.id });
    const path = join(dir, 'source.bin');
    writeFileSync(path, bytes);
    const pending = store.createPendingAttachment({
      topicId: topic.id, filename: 'source.bin', mimeType: 'application/octet-stream', sizeBytes: bytes.length,
      storagePath: path, sha256: createHash('sha256').update(bytes).digest('hex'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const projection = store.beginAssistantProjection({
      piSessionId: 'pi-session', piMessageId: 'pi-message', utteranceId: 'pi-message', topicId: topic.id,
      sessionId: session.id, body: 'Attached', authorId: robot.id,
      handoffs: [{
        refEntryId: 'ref-entry', sourceKind: 'structured-pending',
        sourceRef: { pendingAttachmentId: pending.id }, expectedSha256, expectedSizeBytes: bytes.length,
      }],
    });
    return { topic, session, robot, pending, projection };
  }

  it('verifies and promotes pending bytes before making the post visible', async () => {
    const { pending, projection } = fixture(Buffer.from('safe bytes'));
    const service = new AttachmentHandoffService(store);
    await service.processProjection(projection.id);

    const finalized = store.getAssistantProjectionById(projection.id)!;
    expect(finalized.status).toBe('projected');
    expect(store.getPost(finalized.post_id!)?.silent).toBe(0);
    expect(store.getPendingAttachment(pending.id)).toBeNull();
    expect(store.listAttachmentsByPost(finalized.post_id!)).toHaveLength(1);
  });

  it('atomically gives one concurrent projection custody and records the loser as a durable conflict', async () => {
    const { topic, session, robot, pending, projection } = fixture(Buffer.from('single owner'));
    const conflicting = store.beginAssistantProjection({
      piSessionId: 'pi-session', piMessageId: 'pi-message-conflict', utteranceId: 'pi-message-conflict',
      topicId: topic.id, sessionId: session.id, body: 'Conflicting attachment', authorId: robot.id,
      handoffs: [{
        refEntryId: 'ref-entry-conflict', sourceKind: 'structured-pending',
        sourceRef: { pendingAttachmentId: pending.id }, expectedSha256: pending.sha256,
        expectedSizeBytes: pending.size_bytes,
      }],
    });
    const first = new AttachmentHandoffService(store);
    const second = new AttachmentHandoffService(store);

    await Promise.all([first.processProjection(projection.id), second.processProjection(conflicting.id)]);

    const states = [
      store.getAssistantProjectionById(projection.id)!,
      store.getAssistantProjectionById(conflicting.id)!,
    ];
    expect(states.map((row) => row.status).sort()).toEqual(['needs_manual_review', 'projected']);
    expect(db.prepare("select count(*) as count from attachment_handoffs where status = 'linked'").get()).toEqual({ count: 1 });
    expect(db.prepare("select count(*) as count from attachment_handoffs where status = 'needs_manual_review'").get()).toEqual({ count: 1 });
    expect(db.prepare('select count(*) as count from pending_attachment_reservations').get()).toEqual({ count: 1 });
    const projected = states.find((row) => row.status === 'projected')!;
    expect(store.listAttachmentsByPost(projected.post_id!)).toHaveLength(1);
    expect(db.prepare("select reason from pi_sync_anomalies where pi_message_id = 'pi-message-conflict'").get())
      .toEqual({ reason: 'attachment-handoff-conflict' });
  });

  it('recovers the owning projection after restart without one conflict aborting startup recovery', async () => {
    const { topic, session, robot, pending, projection } = fixture(Buffer.from('restart custody'));
    const conflicting = store.beginAssistantProjection({
      piSessionId: 'pi-session', piMessageId: 'pi-message-restart-conflict', utteranceId: 'pi-message-restart-conflict',
      topicId: topic.id, sessionId: session.id, body: 'Conflict after restart', authorId: robot.id,
      handoffs: [{
        refEntryId: 'restart-conflict', sourceKind: 'structured-pending',
        sourceRef: { pendingAttachmentId: pending.id }, expectedSha256: pending.sha256,
        expectedSizeBytes: pending.size_bytes,
      }],
    });
    const ownerHandoff = store.listAttachmentHandoffsForProjection(projection.id)[0]!;
    const ownerClaim = store.claimAttachmentHandoff(ownerHandoff.id)!;
    expect(store.completeAttachmentHandoff(ownerClaim.id, ownerClaim.claim_token!, pending)?.status).toBe('linked');
    const conflictHandoff = store.listAttachmentHandoffsForProjection(conflicting.id)[0]!;
    expect(store.claimAttachmentHandoff(conflictHandoff.id)?.status).toBe('needs_manual_review');

    const restarted = new AttachmentHandoffService(store);
    await expect(restarted.recover()).resolves.toBeUndefined();

    expect(store.getAssistantProjectionById(projection.id)?.status).toBe('projected');
    expect(store.getAssistantProjectionById(conflicting.id)?.status).toBe('needs_manual_review');
    expect(db.prepare('select projection_id from pending_attachment_reservations where pending_attachment_id = ?').get(pending.id))
      .toEqual({ projection_id: projection.id });
  });

  it('removes durable pending custody reservations with topic deletion', () => {
    const { topic, projection } = fixture(Buffer.from('delete custody'));
    const handoff = store.listAttachmentHandoffsForProjection(projection.id)[0]!;
    expect(store.claimAttachmentHandoff(handoff.id)?.status).toBe('linking');
    expect(db.prepare('select count(*) as count from pending_attachment_reservations').get()).toEqual({ count: 1 });

    store.deleteTopic(topic.id);

    expect(db.prepare('select count(*) as count from pending_attachment_reservations').get()).toEqual({ count: 0 });
  });

  it('recovers a stale linking lease and finalizes the projection', async () => {
    const { projection } = fixture(Buffer.from('recoverable'));
    const handoff = store.listAttachmentHandoffsForProjection(projection.id)[0]!;
    expect(store.claimAttachmentHandoff(handoff.id)?.status).toBe('linking');
    db.prepare("update attachment_handoffs set updated_at = '2000-01-01T00:00:00.000Z' where id = ?").run(handoff.id);

    const service = new AttachmentHandoffService(store, { leaseMs: 1 });
    await service.recover();
    expect(store.getAssistantProjectionById(projection.id)?.status).toBe('projected');
  });

  it('does not reclaim a long-running in-process attachment handoff after its lease age', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const bytes = Buffer.from('active-handoff');
    const { projection } = fixture(bytes);
    const handoff = store.listAttachmentHandoffsForProjection(projection.id)[0]!;
    db.prepare("update attachment_handoffs set source_kind = 'legacy-artifact', source_ref_json = ? where id = ?")
      .run(JSON.stringify({ path: '/canonical/active.bin', filename: 'active.bin' }), handoff.id);
    const uploadsDir = join(dir, 'active-uploads');
    mkdirSync(uploadsDir);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const resolveArtifact = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return {
        filename: 'active.bin', mimeType: 'application/octet-stream', sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64'),
      };
    });
    const service = new AttachmentHandoffService(store, { leaseMs: 1_000, uploadsDir, resolveArtifact });

    const processing = service.processProjection(projection.id);
    await entered.promise;
    vi.advanceTimersByTime(1_001);
    await service.processDue();

    expect(resolveArtifact).toHaveBeenCalledOnce();
    expect(store.listAttachmentHandoffsForProjection(projection.id)[0]?.status).toBe('linking');

    release.resolve();
    await processing;
    await service.processDue();
    expect(resolveArtifact).toHaveBeenCalledOnce();
    expect(store.getAssistantProjectionById(projection.id)?.status).toBe('projected');
  });

  it('reclaims a completion claim only after its restart lease ages and then drains B before C', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { topic, session, robot, pending, projection: projectionB } = fixture(Buffer.from('leased-B'));
    db.prepare('update assistant_projections set completion_payload_json = ? where id = ?')
      .run(JSON.stringify({ item: 'B' }), projectionB.id);
    const handoffB = store.listAttachmentHandoffsForProjection(projectionB.id)[0]!;
    const claimedHandoff = store.claimAttachmentHandoff(handoffB.id)!;
    store.completeAttachmentHandoff(claimedHandoff.id, claimedHandoff.claim_token!, pending);
    store.finalizeAssistantProjection(projectionB.id);
    expect(store.claimAssistantProjectionCompletion(projectionB.id)?.completion_state).toBe(2);

    const projectionC = store.beginAssistantProjection({
      piSessionId: 'pi-session', piMessageId: 'pi-message-leased-C', utteranceId: 'pi-message-leased-C',
      topicId: topic.id, sessionId: session.id, body: 'Leased C', authorId: robot.id,
      completionPayload: { item: 'C' },
    });
    const delivered: string[] = [];
    const restarted = new AttachmentHandoffService(store, {
      leaseMs: 1_000,
      onProjectionFinalized: async (_projection, payload) => { delivered.push(String(payload['item'])); },
    });

    await restarted.recover();
    expect(store.getAssistantProjectionById(projectionB.id)?.completion_state).toBe(2);
    expect(store.getAssistantProjectionById(projectionC.id)?.completion_state).toBe(1);
    expect(delivered).toEqual([]);

    vi.advanceTimersByTime(1_001);
    await restarted.processDue();
    await restarted.processDue();

    expect(delivered).toEqual(['B', 'C']);
    expect(store.getAssistantProjectionById(projectionB.id)?.completion_state).toBe(0);
    expect(store.getAssistantProjectionById(projectionC.id)?.completion_state).toBe(0);
  });

  it('does not reclaim a long-running in-process completion callback after its lease age', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { topic, session, robot, pending, projection: projectionB } = fixture(Buffer.from('active-B'));
    db.prepare('update assistant_projections set completion_payload_json = ? where id = ?')
      .run(JSON.stringify({ item: 'B' }), projectionB.id);
    const handoffB = store.listAttachmentHandoffsForProjection(projectionB.id)[0]!;
    const claimedHandoff = store.claimAttachmentHandoff(handoffB.id)!;
    store.completeAttachmentHandoff(claimedHandoff.id, claimedHandoff.claim_token!, pending);
    store.finalizeAssistantProjection(projectionB.id);
    const projectionC = store.beginAssistantProjection({
      piSessionId: 'pi-session', piMessageId: 'pi-message-active-C', utteranceId: 'pi-message-active-C',
      topicId: topic.id, sessionId: session.id, body: 'Active C', authorId: robot.id,
      completionPayload: { item: 'C' },
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delivered: string[] = [];
    const service = new AttachmentHandoffService(store, {
      leaseMs: 1_000,
      onProjectionFinalized: async (_projection, payload) => {
        const item = String(payload['item']);
        delivered.push(item);
        if (item === 'B') {
          entered.resolve();
          await release.promise;
        }
      },
    });

    const processing = service.processProjection(projectionB.id);
    await entered.promise;
    vi.advanceTimersByTime(1_001);
    await service.processDue();

    expect(delivered).toEqual(['B']);
    expect(store.getAssistantProjectionById(projectionB.id)?.completion_state).toBe(2);
    expect(store.getAssistantProjectionById(projectionC.id)?.completion_state).toBe(1);

    release.resolve();
    await processing;
    await service.processDue();
    expect(delivered).toEqual(['B', 'C']);
    expect(store.getAssistantProjectionById(projectionB.id)?.completion_state).toBe(0);
    expect(store.getAssistantProjectionById(projectionC.id)?.completion_state).toBe(0);
  });

  it('holds C behind retryable B, then concurrently publishes posts and completion events exactly once as B,C', async () => {
    const bytes = Buffer.from('retryable-B');
    const { topic, session, robot, projection: projectionB } = fixture(bytes);
    db.prepare('update assistant_projections set completion_payload_json = ? where id = ?')
      .run(JSON.stringify({ item: 'B' }), projectionB.id);
    const handoffB = store.listAttachmentHandoffsForProjection(projectionB.id)[0]!;
    db.prepare("update attachment_handoffs set source_kind = 'legacy-artifact', source_ref_json = ? where id = ?")
      .run(JSON.stringify({ path: '/canonical/B.bin', filename: 'B.bin' }), handoffB.id);
    const uploadsDir = join(dir, 'uploads');
    mkdirSync(uploadsDir);
    let resolveAttempts = 0;
    const delivered: string[] = [];
    const service = new AttachmentHandoffService(store, {
      uploadsDir,
      resolveArtifact: async () => {
        resolveAttempts += 1;
        if (resolveAttempts === 1) throw new Error('temporary artifact transport failure');
        return {
          filename: 'B.bin', mimeType: 'application/octet-stream', sizeBytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64'),
        };
      },
      onProjectionFinalized: async (_projection, payload) => { delivered.push(String(payload['item'])); },
    });

    await service.processProjection(projectionB.id);
    expect(store.getAssistantProjectionById(projectionB.id)?.status).toBe('failed');
    const projectionC = store.beginAssistantProjection({
      piSessionId: 'pi-session', piMessageId: 'pi-message-C', utteranceId: 'pi-message-C',
      topicId: topic.id, sessionId: session.id, body: 'Canonical C', authorId: robot.id,
      completionPayload: { item: 'C' },
    });
    // Deliberately invert timestamps: canonical projection order is SQLite
    // insertion rowid, never wall-clock metadata.
    db.prepare("update assistant_projections set created_at = '2999-01-01T00:00:00.000Z' where id = ?").run(projectionB.id);
    db.prepare("update assistant_projections set created_at = '2000-01-01T00:00:00.000Z' where id = ?").run(projectionC.id);
    expect(store.listIncompleteAssistantProjections().map((row) => row.id)).toEqual([projectionB.id, projectionC.id]);
    await service.processProjection(projectionC.id);

    expect(store.getAssistantProjectionById(projectionC.id)?.post_id).toBeNull();
    expect(db.prepare("select body from posts where body in ('Attached', 'Canonical C') order by rowid").all()).toEqual([]);
    expect(delivered).toEqual([]);

    db.prepare('update attachment_handoffs set next_attempt_at = null where id = ?').run(handoffB.id);
    await Promise.all([service.processProjection(projectionC.id), service.processProjection(projectionB.id)]);
    await service.recover();

    expect(db.prepare("select body from posts where body in ('Attached', 'Canonical C') order by rowid").all())
      .toEqual([{ body: 'Attached' }, { body: 'Canonical C' }]);
    expect(delivered).toEqual(['B', 'C']);
    expect(db.prepare("select count(*) as count from posts where body in ('Attached', 'Canonical C')").get())
      .toEqual({ count: 2 });
  });

  it('recovers an all-linked B crash window before C after service restart', async () => {
    const { topic, session, robot, pending, projection: projectionB } = fixture(Buffer.from('restart-order'));
    db.prepare('update assistant_projections set completion_payload_json = ? where id = ?')
      .run(JSON.stringify({ item: 'B' }), projectionB.id);
    const handoffB = store.listAttachmentHandoffsForProjection(projectionB.id)[0]!;
    const claimed = store.claimAttachmentHandoff(handoffB.id)!;
    store.completeAttachmentHandoff(claimed.id, claimed.claim_token!, pending);
    const projectionC = store.beginAssistantProjection({
      piSessionId: 'pi-session', piMessageId: 'pi-message-restart-C', utteranceId: 'pi-message-restart-C',
      topicId: topic.id, sessionId: session.id, body: 'Restart C', authorId: robot.id,
      completionPayload: { item: 'C' },
    });
    expect(projectionC.post_id).toBeNull();

    const delivered: string[] = [];
    const restarted = new AttachmentHandoffService(store, {
      onProjectionFinalized: async (_projection, payload) => { delivered.push(String(payload['item'])); },
    });
    await restarted.recover();

    expect(db.prepare("select body from posts where body in ('Attached', 'Restart C') order by rowid").all())
      .toEqual([{ body: 'Attached' }, { body: 'Restart C' }]);
    expect(delivered).toEqual(['B', 'C']);
  });

  it('treats terminal manual-review B as an anomaly gap that does not deadlock C', async () => {
    const { topic, session, robot, projection: projectionB } = fixture(Buffer.from('terminal-B'), '0'.repeat(64));
    const delivered: string[] = [];
    const service = new AttachmentHandoffService(store, {
      onProjectionFinalized: async (_projection, payload) => { delivered.push(String(payload['item'])); },
    });
    await service.processProjection(projectionB.id);
    expect(store.getAssistantProjectionById(projectionB.id)?.status).toBe('needs_manual_review');

    const projectionC = store.beginAssistantProjection({
      piSessionId: 'pi-session', piMessageId: 'pi-message-after-gap', utteranceId: 'pi-message-after-gap',
      topicId: topic.id, sessionId: session.id, body: 'After terminal gap', authorId: robot.id,
      completionPayload: { item: 'C' },
    });
    await service.processProjection(projectionC.id);

    expect(store.getAssistantProjectionById(projectionB.id)?.post_id).toBeNull();
    expect(store.getAssistantProjectionById(projectionC.id)?.status).toBe('projected');
    expect(store.getPost(projectionC.post_id!)?.body).toBe('After terminal gap');
    expect(delivered).toEqual(['C']);
    expect(db.prepare("select reason from pi_sync_anomalies where pi_message_id = 'pi-message'").get())
      .toEqual({ reason: 'attachment-handoff-terminal' });
  });

  it('finalizes an all-linked crash window and delivers completion semantics once', async () => {
    const { pending, projection } = fixture(Buffer.from('linked-before-crash'));
    db.prepare('update assistant_projections set completion_payload_json = ?, completion_state = 0 where id = ?')
      .run(JSON.stringify({ text: 'Attached' }), projection.id);
    const handoff = store.listAttachmentHandoffsForProjection(projection.id)[0]!;
    const claimed = store.claimAttachmentHandoff(handoff.id)!;
    store.completeAttachmentHandoff(claimed.id, claimed.claim_token!, pending);
    const delivered = vi.fn(async () => {});
    const service = new AttachmentHandoffService(store, { onProjectionFinalized: delivered });

    await service.recover();
    await service.recover();
    expect(store.getAssistantProjectionById(projection.id)?.status).toBe('projected');
    expect(delivered).toHaveBeenCalledOnce();
  });

  it('awaits active completion delivery during shutdown', async () => {
    const { pending, projection } = fixture(Buffer.from('shutdown'));
    db.prepare('update assistant_projections set completion_payload_json = ? where id = ?')
      .run(JSON.stringify({ text: 'shutdown' }), projection.id);
    const handoff = store.listAttachmentHandoffsForProjection(projection.id)[0]!;
    const claimed = store.claimAttachmentHandoff(handoff.id)!;
    store.completeAttachmentHandoff(claimed.id, claimed.claim_token!, pending);
    store.finalizeAssistantProjection(projection.id);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const service = new AttachmentHandoffService(store, {
      intervalMs: 60_000,
      onProjectionFinalized: async () => { entered.resolve(); await release.promise; },
    });
    service.start();
    await entered.promise;
    let stopped = false;
    const stopping = service.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release.resolve();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('routes even locally existing legacy artifact paths through agentd resolution', async () => {
    const forum = store.createForum('Legacy');
    const human = store.createIdentity('Human', 'human');
    const robot = store.createIdentity('Monika', 'robot');
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'hello', authorId: human.id });
    const session = store.ensureSession({ topicId: topic.id });
    const workDir = join(dir, 'work');
    const uploadsDir = join(dir, 'uploads');
    mkdirSync(workDir); mkdirSync(uploadsDir);
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'secret');
    const escape = join(workDir, 'escape.txt');
    symlinkSync(outside, escape);
    const projection = store.beginAssistantProjection({
      piSessionId: 'legacy-pi', piMessageId: 'legacy-message', utteranceId: 'legacy-message', topicId: topic.id,
      sessionId: session.id, body: 'Legacy', authorId: robot.id,
      handoffs: [{ refEntryId: 'legacy-ref', sourceKind: 'legacy-artifact', sourceRef: { path: escape } }],
    });
    const resolveArtifact = vi.fn(async () => { throw new Error('artifact symlinks are not allowed'); });
    await new AttachmentHandoffService(store, { uploadsDir, resolveArtifact }).processProjection(projection.id);
    expect(resolveArtifact).toHaveBeenCalledWith(expect.objectContaining({ path: escape }));
    expect(store.getAssistantProjectionById(projection.id)?.status).toBe('failed');
    expect(readFileSync(outside, 'utf8')).toBe('secret');
  });

  it('retains mismatched source evidence and surfaces a sync anomaly', async () => {
    const { pending, projection } = fixture(Buffer.from('tampered'), '0'.repeat(64));
    const service = new AttachmentHandoffService(store);
    await service.processProjection(projection.id);

    expect(store.getAssistantProjectionById(projection.id)?.status).toBe('needs_manual_review');
    expect(store.getAssistantProjectionById(projection.id)?.post_id).toBeNull();
    expect(store.getPendingAttachment(pending.id)).not.toBeNull();
    db.prepare("update pending_attachments set expires_at = '2000-01-01T00:00:00.000Z' where id = ?").run(pending.id);
    expect(store.deleteExpiredPendingAttachments()).toEqual([]);
    expect(store.getPendingAttachment(pending.id)).not.toBeNull();
    expect(db.prepare("select reason, status from pi_sync_anomalies where pi_message_id = 'pi-message'").get())
      .toEqual({ reason: 'attachment-handoff-terminal', status: 'needs_manual_review' });
  });
});
