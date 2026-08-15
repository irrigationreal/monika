import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import type { ForumStore } from '../store';

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export class FileStorageMaintenance {
  private running = false;
  constructor(
    private readonly store: ForumStore,
    private readonly uploadsRoot: string,
    private readonly userFilesDir: string = uploadsRoot,
    private readonly chunkTempDir?: string,
    private readonly pendingAttachmentsDir?: string
  ) {}

  private isManagedPath(path: string): boolean {
    const root = resolve(this.uploadsRoot);
    const candidate = resolve(path);
    return candidate.startsWith(`${root}${sep}`);
  }

  async run(now: Date = new Date()): Promise<{ expired: number; collected: number; staleTemps: number }> {
    if (this.running) return { expired: 0, collected: 0, staleTemps: 0 };
    this.running = true;
    try {
      const nowIso = now.toISOString();
      const expired = this.store.expireUserFiles(nowIso);
      this.store.deleteExpiredPendingAttachments(nowIso);
      for (const blob of this.store.listReadyBlobs(50)) {
        if (!this.isManagedPath(blob.storage_path) || !existsSync(blob.storage_path))
          this.store.markBlobMissing(blob.id);
        else this.store.touchReadyBlob(blob.id, nowIso);
      }
      for (const blob of this.store.listUnverifiedBlobs(10)) {
        if (!this.isManagedPath(blob.storage_path) || !existsSync(blob.storage_path)) {
          this.store.markBlobMissing(blob.id);
          continue;
        }
        try {
          this.store.verifyBlob(blob.id, await hashFile(blob.storage_path), statSync(blob.storage_path).size);
        } catch (error) {
          console.warn('[files] legacy verification deferred', blob.id, error instanceof Error ? error.message : error);
        }
      }
      this.store.markUnreferencedBlobsForGc();
      let collected = 0;
      for (const blob of this.store.listGcPendingBlobs(50)) {
        try {
          // Claiming rechecks references and durably queues the path before
          // releasing blob metadata. The deletion queue below owns unlink
          // retries, including after a process restart.
          this.store.claimBlobForGc(blob.id);
        } catch (error) {
          console.warn('[files] blob GC claim deferred', blob.id, error instanceof Error ? error.message : error);
        }
      }
      for (const queued of this.store.listQueuedFileDeletions(50)) {
        try {
          if (!this.isManagedPath(queued.storage_path))
            throw new Error('queued path is outside the managed upload root');
          if (
            this.store.hasBlobAtStoragePath(queued.storage_path) ||
            this.store.hasPendingAttachmentAtStoragePath(queued.storage_path)
          ) {
            this.store.completeQueuedFileDeletion(queued.storage_path);
            continue;
          }
          if (existsSync(queued.storage_path)) unlinkSync(queued.storage_path);
          this.store.completeQueuedFileDeletion(queued.storage_path);
          collected += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.store.failQueuedFileDeletion(queued.storage_path, message);
          console.warn('[files] queued cleanup deferred', queued.storage_path, message);
        }
      }
      let staleTemps = 0;
      const sweepUnclaimedFiles = (directory: string, acceptsPending = false): void => {
        if (!existsSync(directory)) return;
        for (const name of readdirSync(directory)) {
          const path = join(directory, name);
          try {
            const stat = lstatSync(path);
            if (!stat.isFile()) continue;
            const staging = name.startsWith('.staging-');
            if (
              !staging &&
              (this.store.hasBlobAtStoragePath(path) ||
                (acceptsPending && this.store.hasPendingAttachmentAtStoragePath(path)))
            )
              continue;
            if (now.getTime() - stat.mtimeMs > 60 * 60_000) {
              unlinkSync(path);
              staleTemps += 1;
            }
          } catch {
            /* A concurrent upload or cleanup owns it now. */
          }
        }
      };
      // Post uploads are top-level files; standalone uploads live in their
      // dedicated subdirectory. Restrict orphan sweeping to these two roots.
      sweepUnclaimedFiles(this.uploadsRoot);
      if (resolve(this.userFilesDir) !== resolve(this.uploadsRoot)) sweepUnclaimedFiles(this.userFilesDir);
      if (this.pendingAttachmentsDir) sweepUnclaimedFiles(this.pendingAttachmentsDir, true);
      if (this.chunkTempDir && existsSync(this.chunkTempDir)) {
        for (const name of readdirSync(this.chunkTempDir)) {
          const path = join(this.chunkTempDir, name);
          try {
            if (now.getTime() - statSync(path).mtimeMs > 60 * 60_000) {
              rmSync(path, { recursive: true, force: true });
              staleTemps += 1;
            }
          } catch {
            /* A concurrent chunk upload owns it now. */
          }
        }
      }
      return { expired, collected, staleTemps };
    } finally {
      this.running = false;
    }
  }
}
