import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './db';
import { ForumStore, type CreateAttachmentInput } from './store';

/**
 * Comprehensive unit tests for attachment and reaction systems in ForumStore.
 * Uses in-memory SQLite for isolation and speed.
 */

describe('ForumStore - Attachments', () => {
  let db: Database.Database;
  let store: ForumStore;

  // Test fixtures
  let forumId: string;
  let topicId: string;
  let postId: string;
  let identityId: string;

  beforeEach(() => {
    // Create fresh in-memory database for each test
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);

    // Create test fixtures
    const identity = store.createIdentity('Test User', 'human');
    identityId = identity.id;

    const forum = store.createForum('Test Forum', 'A forum for testing');
    forumId = forum.id;

    const { topic, post } = store.createTopic({
      forumId,
      title: 'Test Topic',
      body: 'This is a test topic body.',
      authorId: identityId,
    });
    topicId = topic.id;
    postId = post.id;
  });

  afterEach(() => {
    db.close();
  });

  describe('createAttachment()', () => {
    it('should create an attachment with all correct fields', () => {
      const input: CreateAttachmentInput = {
        postId,
        filename: 'test-image.png',
        mimeType: 'image/png',
        sizeBytes: 12345,
        storagePath: '/uploads/2024/01/test-image.png',
      };

      const attachment = store.createAttachment(input);

      expect(attachment).toBeDefined();
      expect(attachment.id).toBeTypeOf('string');
      expect(attachment.id.length).toBeGreaterThan(0);
      expect(attachment.post_id).toBe(postId);
      expect(attachment.filename).toBe('test-image.png');
      expect(attachment.mime_type).toBe('image/png');
      expect(attachment.size_bytes).toBe(12345);
      expect(attachment.storage_path).toBe('/uploads/2024/01/test-image.png');
      expect(attachment.created_at).toBeTypeOf('string');
      // Verify created_at is a valid ISO date
      expect(() => new Date(attachment.created_at)).not.toThrow();
    });

    it('should generate unique IDs for each attachment', () => {
      const input: CreateAttachmentInput = {
        postId,
        filename: 'file.txt',
        mimeType: 'text/plain',
        sizeBytes: 100,
        storagePath: '/uploads/file.txt',
      };

      const attachment1 = store.createAttachment(input);
      const attachment2 = store.createAttachment(input);

      expect(attachment1.id).not.toBe(attachment2.id);
    });

    it('should handle different MIME types', () => {
      const mimeTypes = [
        'image/png',
        'image/jpeg',
        'application/pdf',
        'text/plain',
        'application/octet-stream',
        'video/mp4',
      ];

      for (const mimeType of mimeTypes) {
        const attachment = store.createAttachment({
          postId,
          filename: `file.${mimeType.split('/')[1]}`,
          mimeType,
          sizeBytes: 1000,
          storagePath: `/uploads/file.${mimeType.split('/')[1]}`,
        });

        expect(attachment.mime_type).toBe(mimeType);
      }
    });

    it('should handle zero-size files', () => {
      const attachment = store.createAttachment({
        postId,
        filename: 'empty.txt',
        mimeType: 'text/plain',
        sizeBytes: 0,
        storagePath: '/uploads/empty.txt',
      });

      expect(attachment.size_bytes).toBe(0);
    });

    it('should handle large file sizes', () => {
      const largeSize = 5 * 1024 * 1024 * 1024; // 5GB
      const attachment = store.createAttachment({
        postId,
        filename: 'large-file.zip',
        mimeType: 'application/zip',
        sizeBytes: largeSize,
        storagePath: '/uploads/large-file.zip',
      });

      expect(attachment.size_bytes).toBe(largeSize);
    });

    it('should handle filenames with special characters', () => {
      const specialFilenames = [
        'file with spaces.txt',
        'file-with-dashes.txt',
        'file_with_underscores.txt',
        'file.multiple.dots.txt',
        'UPPERCASE.TXT',
        'unicode-文件.txt',
      ];

      for (const filename of specialFilenames) {
        const attachment = store.createAttachment({
          postId,
          filename,
          mimeType: 'text/plain',
          sizeBytes: 100,
          storagePath: `/uploads/${filename}`,
        });

        expect(attachment.filename).toBe(filename);
      }
    });
  });

  describe('getAttachment()', () => {
    it('should retrieve an attachment by ID', () => {
      const created = store.createAttachment({
        postId,
        filename: 'retrieve-test.txt',
        mimeType: 'text/plain',
        sizeBytes: 500,
        storagePath: '/uploads/retrieve-test.txt',
      });

      const retrieved = store.getAttachment(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.post_id).toBe(created.post_id);
      expect(retrieved!.filename).toBe(created.filename);
      expect(retrieved!.mime_type).toBe(created.mime_type);
      expect(retrieved!.size_bytes).toBe(created.size_bytes);
      expect(retrieved!.storage_path).toBe(created.storage_path);
      expect(retrieved!.created_at).toBe(created.created_at);
    });

    it('should return null for non-existent attachment ID', () => {
      const result = store.getAttachment('non-existent-id');
      expect(result).toBeNull();
    });

    it('should return null for empty string ID', () => {
      const result = store.getAttachment('');
      expect(result).toBeNull();
    });
  });

  describe('listAttachmentsByPost()', () => {
    it('should return all attachments for a post', () => {
      // Create multiple attachments
      store.createAttachment({
        postId,
        filename: 'file1.txt',
        mimeType: 'text/plain',
        sizeBytes: 100,
        storagePath: '/uploads/file1.txt',
      });
      store.createAttachment({
        postId,
        filename: 'file2.png',
        mimeType: 'image/png',
        sizeBytes: 200,
        storagePath: '/uploads/file2.png',
      });
      store.createAttachment({
        postId,
        filename: 'file3.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 300,
        storagePath: '/uploads/file3.pdf',
      });

      const attachments = store.listAttachmentsByPost(postId);

      expect(attachments).toHaveLength(3);
      expect(attachments.map((a) => a.filename)).toContain('file1.txt');
      expect(attachments.map((a) => a.filename)).toContain('file2.png');
      expect(attachments.map((a) => a.filename)).toContain('file3.pdf');
    });

    it('should return attachments ordered by created_at ascending', () => {
      const attachment1 = store.createAttachment({
        postId,
        filename: 'first.txt',
        mimeType: 'text/plain',
        sizeBytes: 100,
        storagePath: '/uploads/first.txt',
      });
      const attachment2 = store.createAttachment({
        postId,
        filename: 'second.txt',
        mimeType: 'text/plain',
        sizeBytes: 100,
        storagePath: '/uploads/second.txt',
      });
      const attachment3 = store.createAttachment({
        postId,
        filename: 'third.txt',
        mimeType: 'text/plain',
        sizeBytes: 100,
        storagePath: '/uploads/third.txt',
      });

      const attachments = store.listAttachmentsByPost(postId);

      // Should be ordered by creation time (first created comes first)
      expect(attachments[0].id).toBe(attachment1.id);
      expect(attachments[1].id).toBe(attachment2.id);
      expect(attachments[2].id).toBe(attachment3.id);
    });

    it('should return empty array for post with no attachments', () => {
      const attachments = store.listAttachmentsByPost(postId);
      expect(attachments).toEqual([]);
    });

    it('should return empty array for non-existent post ID', () => {
      const attachments = store.listAttachmentsByPost('non-existent-post-id');
      expect(attachments).toEqual([]);
    });

    it('should only return attachments for the specified post', () => {
      // Create another post
      const otherPost = store.createPost({
        topicId,
        body: 'Another post',
        authorId: identityId,
      });

      // Create attachments for both posts
      store.createAttachment({
        postId,
        filename: 'post1-file.txt',
        mimeType: 'text/plain',
        sizeBytes: 100,
        storagePath: '/uploads/post1-file.txt',
      });
      store.createAttachment({
        postId: otherPost.id,
        filename: 'post2-file.txt',
        mimeType: 'text/plain',
        sizeBytes: 100,
        storagePath: '/uploads/post2-file.txt',
      });

      const post1Attachments = store.listAttachmentsByPost(postId);
      const post2Attachments = store.listAttachmentsByPost(otherPost.id);

      expect(post1Attachments).toHaveLength(1);
      expect(post1Attachments[0].filename).toBe('post1-file.txt');

      expect(post2Attachments).toHaveLength(1);
      expect(post2Attachments[0].filename).toBe('post2-file.txt');
    });
  });

  describe('deleteAttachment()', () => {
    it('should remove the attachment record', () => {
      const attachment = store.createAttachment({
        postId,
        filename: 'to-delete.txt',
        mimeType: 'text/plain',
        sizeBytes: 100,
        storagePath: '/uploads/to-delete.txt',
      });

      // Verify attachment exists
      expect(store.getAttachment(attachment.id)).not.toBeNull();

      // Delete the attachment
      store.deleteAttachment(attachment.id);

      // Verify attachment is gone
      expect(store.getAttachment(attachment.id)).toBeNull();
    });

    it('should not throw when deleting non-existent attachment', () => {
      expect(() => store.deleteAttachment('non-existent-id')).not.toThrow();
    });

    it('should only delete the specified attachment', () => {
      const attachment1 = store.createAttachment({
        postId,
        filename: 'keep-this.txt',
        mimeType: 'text/plain',
        sizeBytes: 100,
        storagePath: '/uploads/keep-this.txt',
      });
      const attachment2 = store.createAttachment({
        postId,
        filename: 'delete-this.txt',
        mimeType: 'text/plain',
        sizeBytes: 100,
        storagePath: '/uploads/delete-this.txt',
      });

      store.deleteAttachment(attachment2.id);

      expect(store.getAttachment(attachment1.id)).not.toBeNull();
      expect(store.getAttachment(attachment2.id)).toBeNull();
    });

    it('should remove attachment from list results', () => {
      const attachment = store.createAttachment({
        postId,
        filename: 'listed-then-deleted.txt',
        mimeType: 'text/plain',
        sizeBytes: 100,
        storagePath: '/uploads/listed-then-deleted.txt',
      });

      // Verify it's in the list
      let attachments = store.listAttachmentsByPost(postId);
      expect(attachments).toHaveLength(1);

      // Delete it
      store.deleteAttachment(attachment.id);

      // Verify it's no longer in the list
      attachments = store.listAttachmentsByPost(postId);
      expect(attachments).toHaveLength(0);
    });
  });
});

describe('ForumStore - Reactions', () => {
  let db: Database.Database;
  let store: ForumStore;

  // Test fixtures
  let forumId: string;
  let topicId: string;
  let postId: string;
  let identityId: string;
  let identity2Id: string;

  beforeEach(() => {
    // Create fresh in-memory database for each test
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);

    // Create test fixtures
    const identity = store.createIdentity('Test User', 'human');
    identityId = identity.id;

    const identity2 = store.createIdentity('Another User', 'human');
    identity2Id = identity2.id;

    const forum = store.createForum('Test Forum', 'A forum for testing');
    forumId = forum.id;

    const { topic, post } = store.createTopic({
      forumId,
      title: 'Test Topic',
      body: 'This is a test topic body.',
      authorId: identityId,
    });
    topicId = topic.id;
    postId = post.id;
  });

  afterEach(() => {
    db.close();
  });

  describe('addReaction()', () => {
    it('should create a reaction with correct fields', () => {
      const reaction = store.addReaction(postId, identityId, '👍');

      expect(reaction).toBeDefined();
      expect(reaction.id).toBeTypeOf('string');
      expect(reaction.id.length).toBeGreaterThan(0);
      expect(reaction.post_id).toBe(postId);
      expect(reaction.identity_id).toBe(identityId);
      expect(reaction.emoji).toBe('👍');
      expect(reaction.created_at).toBeTypeOf('string');
      expect(() => new Date(reaction.created_at)).not.toThrow();
    });

    it('should be idempotent - same user, same emoji, same post returns existing reaction', () => {
      const reaction1 = store.addReaction(postId, identityId, '👍');
      const reaction2 = store.addReaction(postId, identityId, '👍');

      // Should return the same reaction (same ID)
      expect(reaction1.id).toBe(reaction2.id);
      expect(reaction1.created_at).toBe(reaction2.created_at);

      // Should only have one reaction in the database
      const reactions = store.listReactionsByPost(postId);
      expect(reactions).toHaveLength(1);
    });

    it('should allow same user to add different emojis to same post', () => {
      const reaction1 = store.addReaction(postId, identityId, '👍');
      const reaction2 = store.addReaction(postId, identityId, '❤️');
      const reaction3 = store.addReaction(postId, identityId, '🎉');

      expect(reaction1.id).not.toBe(reaction2.id);
      expect(reaction2.id).not.toBe(reaction3.id);

      const reactions = store.listReactionsByPost(postId);
      expect(reactions).toHaveLength(3);
    });

    it('should allow different users to add same emoji to same post', () => {
      const reaction1 = store.addReaction(postId, identityId, '👍');
      const reaction2 = store.addReaction(postId, identity2Id, '👍');

      expect(reaction1.id).not.toBe(reaction2.id);

      const reactions = store.listReactionsByPost(postId);
      expect(reactions).toHaveLength(2);
    });

    it('should handle various emoji types', () => {
      const emojis = [
        '👍', // simple emoji
        '❤️', // emoji with variation selector
        '🎉', // celebration emoji
        '🚀', // rocket emoji
        '🇺🇸', // flag emoji (two regional indicators)
        '👨‍👩‍👧‍👦', // family emoji (ZWJ sequence)
        '✅', // check mark
        '+1', // text-based reaction
      ];

      for (const emoji of emojis) {
        const reaction = store.addReaction(postId, identityId, emoji);
        expect(reaction.emoji).toBe(emoji);
      }
    });

    it('should allow adding reactions to different posts', () => {
      const post2 = store.createPost({
        topicId,
        body: 'Second post',
        authorId: identityId,
      });

      const reaction1 = store.addReaction(postId, identityId, '👍');
      const reaction2 = store.addReaction(post2.id, identityId, '👍');

      expect(reaction1.post_id).toBe(postId);
      expect(reaction2.post_id).toBe(post2.id);
    });
  });

  describe('removeReaction()', () => {
    it('should remove an existing reaction', () => {
      store.addReaction(postId, identityId, '👍');

      // Verify reaction exists
      let reactions = store.listReactionsByPost(postId);
      expect(reactions).toHaveLength(1);

      // Remove the reaction
      store.removeReaction(postId, identityId, '👍');

      // Verify reaction is gone
      reactions = store.listReactionsByPost(postId);
      expect(reactions).toHaveLength(0);
    });

    it('should not throw when removing non-existent reaction', () => {
      expect(() => store.removeReaction(postId, identityId, '👍')).not.toThrow();
    });

    it('should only remove the specified reaction', () => {
      store.addReaction(postId, identityId, '👍');
      store.addReaction(postId, identityId, '❤️');
      store.addReaction(postId, identity2Id, '👍');

      // Remove only one reaction
      store.removeReaction(postId, identityId, '👍');

      const reactions = store.listReactionsByPost(postId);
      expect(reactions).toHaveLength(2);

      const emojis = reactions.map((r) => `${r.identity_id}:${r.emoji}`);
      expect(emojis).toContain(`${identityId}:❤️`);
      expect(emojis).toContain(`${identity2Id}:👍`);
      expect(emojis).not.toContain(`${identityId}:👍`);
    });

    it('should allow re-adding a reaction after removal', () => {
      const reaction1 = store.addReaction(postId, identityId, '👍');
      store.removeReaction(postId, identityId, '👍');
      const reaction2 = store.addReaction(postId, identityId, '👍');

      // New reaction should have a different ID (new row)
      expect(reaction1.id).not.toBe(reaction2.id);

      const reactions = store.listReactionsByPost(postId);
      expect(reactions).toHaveLength(1);
    });
  });

  describe('listReactionsByPost()', () => {
    it('should return all reactions for a post', () => {
      store.addReaction(postId, identityId, '👍');
      store.addReaction(postId, identityId, '❤️');
      store.addReaction(postId, identity2Id, '👍');

      const reactions = store.listReactionsByPost(postId);

      expect(reactions).toHaveLength(3);
    });

    it('should return reactions ordered by created_at ascending', () => {
      const reaction1 = store.addReaction(postId, identityId, '👍');
      const reaction2 = store.addReaction(postId, identityId, '❤️');
      const reaction3 = store.addReaction(postId, identity2Id, '🎉');

      const reactions = store.listReactionsByPost(postId);

      expect(reactions[0].id).toBe(reaction1.id);
      expect(reactions[1].id).toBe(reaction2.id);
      expect(reactions[2].id).toBe(reaction3.id);
    });

    it('should return empty array for post with no reactions', () => {
      const reactions = store.listReactionsByPost(postId);
      expect(reactions).toEqual([]);
    });

    it('should return empty array for non-existent post ID', () => {
      const reactions = store.listReactionsByPost('non-existent-post-id');
      expect(reactions).toEqual([]);
    });

    it('should only return reactions for the specified post', () => {
      const post2 = store.createPost({
        topicId,
        body: 'Another post',
        authorId: identityId,
      });

      store.addReaction(postId, identityId, '👍');
      store.addReaction(post2.id, identityId, '❤️');

      const post1Reactions = store.listReactionsByPost(postId);
      const post2Reactions = store.listReactionsByPost(post2.id);

      expect(post1Reactions).toHaveLength(1);
      expect(post1Reactions[0].emoji).toBe('👍');

      expect(post2Reactions).toHaveLength(1);
      expect(post2Reactions[0].emoji).toBe('❤️');
    });
  });

  describe('getReactionCounts()', () => {
    it('should return correct counts grouped by emoji', () => {
      // Add multiple reactions
      store.addReaction(postId, identityId, '👍');
      store.addReaction(postId, identity2Id, '👍');
      store.addReaction(postId, identityId, '❤️');

      const counts = store.getReactionCounts(postId);

      expect(counts).toHaveLength(2);

      const thumbsUp = counts.find((c) => c.emoji === '👍');
      const heart = counts.find((c) => c.emoji === '❤️');

      expect(thumbsUp).toBeDefined();
      expect(thumbsUp!.count).toBe(2);

      expect(heart).toBeDefined();
      expect(heart!.count).toBe(1);
    });

    it('should return empty array for post with no reactions', () => {
      const counts = store.getReactionCounts(postId);
      expect(counts).toEqual([]);
    });

    it('should return empty array for non-existent post ID', () => {
      const counts = store.getReactionCounts('non-existent-post-id');
      expect(counts).toEqual([]);
    });

    it('should handle single reaction correctly', () => {
      store.addReaction(postId, identityId, '👍');

      const counts = store.getReactionCounts(postId);

      expect(counts).toHaveLength(1);
      expect(counts[0].emoji).toBe('👍');
      expect(counts[0].count).toBe(1);
    });

    it('should update counts when reactions are added', () => {
      store.addReaction(postId, identityId, '👍');

      let counts = store.getReactionCounts(postId);
      expect(counts[0].count).toBe(1);

      store.addReaction(postId, identity2Id, '👍');

      counts = store.getReactionCounts(postId);
      expect(counts.find((c) => c.emoji === '👍')!.count).toBe(2);
    });

    it('should update counts when reactions are removed', () => {
      store.addReaction(postId, identityId, '👍');
      store.addReaction(postId, identity2Id, '👍');

      let counts = store.getReactionCounts(postId);
      expect(counts.find((c) => c.emoji === '👍')!.count).toBe(2);

      store.removeReaction(postId, identityId, '👍');

      counts = store.getReactionCounts(postId);
      expect(counts.find((c) => c.emoji === '👍')!.count).toBe(1);
    });

    it('should not include emoji in counts when all reactions of that type are removed', () => {
      store.addReaction(postId, identityId, '👍');
      store.addReaction(postId, identityId, '❤️');

      let counts = store.getReactionCounts(postId);
      expect(counts).toHaveLength(2);

      store.removeReaction(postId, identityId, '👍');

      counts = store.getReactionCounts(postId);
      expect(counts).toHaveLength(1);
      expect(counts[0].emoji).toBe('❤️');
    });
  });

  describe('getReactionCountsForPosts()', () => {
    let post2Id: string;
    let post3Id: string;

    beforeEach(() => {
      const post2 = store.createPost({
        topicId,
        body: 'Second post',
        authorId: identityId,
      });
      post2Id = post2.id;

      const post3 = store.createPost({
        topicId,
        body: 'Third post',
        authorId: identityId,
      });
      post3Id = post3.id;
    });

    it('should return batch results for multiple posts', () => {
      // Add reactions to different posts
      store.addReaction(postId, identityId, '👍');
      store.addReaction(postId, identity2Id, '👍');
      store.addReaction(post2Id, identityId, '❤️');
      store.addReaction(post3Id, identityId, '🎉');
      store.addReaction(post3Id, identity2Id, '🎉');
      store.addReaction(post3Id, identityId, '👍');

      const results = store.getReactionCountsForPosts([postId, post2Id, post3Id]);

      expect(results).toBeInstanceOf(Map);

      // Check post 1 counts
      const post1Counts = results.get(postId);
      expect(post1Counts).toBeDefined();
      expect(post1Counts).toHaveLength(1);
      expect(post1Counts!.find((c) => c.emoji === '👍')!.count).toBe(2);

      // Check post 2 counts
      const post2Counts = results.get(post2Id);
      expect(post2Counts).toBeDefined();
      expect(post2Counts).toHaveLength(1);
      expect(post2Counts!.find((c) => c.emoji === '❤️')!.count).toBe(1);

      // Check post 3 counts
      const post3Counts = results.get(post3Id);
      expect(post3Counts).toBeDefined();
      expect(post3Counts).toHaveLength(2);
      expect(post3Counts!.find((c) => c.emoji === '🎉')!.count).toBe(2);
      expect(post3Counts!.find((c) => c.emoji === '👍')!.count).toBe(1);
    });

    it('should return empty Map for empty array of post IDs', () => {
      const results = store.getReactionCountsForPosts([]);
      expect(results).toBeInstanceOf(Map);
      expect(results.size).toBe(0);
    });

    it('should not include posts with no reactions in the Map', () => {
      store.addReaction(postId, identityId, '👍');
      // post2Id has no reactions

      const results = store.getReactionCountsForPosts([postId, post2Id]);

      expect(results.has(postId)).toBe(true);
      expect(results.has(post2Id)).toBe(false);
    });

    it('should handle single post ID', () => {
      store.addReaction(postId, identityId, '👍');

      const results = store.getReactionCountsForPosts([postId]);

      expect(results.size).toBe(1);
      expect(results.get(postId)).toHaveLength(1);
      expect(results.get(postId)![0].count).toBe(1);
    });

    it('should handle non-existent post IDs gracefully', () => {
      store.addReaction(postId, identityId, '👍');

      const results = store.getReactionCountsForPosts([postId, 'non-existent-id']);

      expect(results.size).toBe(1);
      expect(results.has(postId)).toBe(true);
      expect(results.has('non-existent-id')).toBe(false);
    });

    it('should return consistent results with getReactionCounts for individual posts', () => {
      store.addReaction(postId, identityId, '👍');
      store.addReaction(postId, identity2Id, '👍');
      store.addReaction(postId, identityId, '❤️');

      const batchResults = store.getReactionCountsForPosts([postId]);
      const singleResult = store.getReactionCounts(postId);

      const batchCounts = batchResults.get(postId)!;

      expect(batchCounts).toHaveLength(singleResult.length);

      for (const singleCount of singleResult) {
        const batchCount = batchCounts.find((c) => c.emoji === singleCount.emoji);
        expect(batchCount).toBeDefined();
        expect(batchCount!.count).toBe(singleCount.count);
      }
    });

    it('should handle large number of posts efficiently', () => {
      // Create many posts
      const postIds: string[] = [postId, post2Id, post3Id];
      for (let i = 0; i < 20; i++) {
        const newPost = store.createPost({
          topicId,
          body: `Post ${i}`,
          authorId: identityId,
        });
        postIds.push(newPost.id);
        // Add a reaction to each
        store.addReaction(newPost.id, identityId, '👍');
      }

      const results = store.getReactionCountsForPosts(postIds);

      // Should have 20 posts with reactions (the first 3 have none)
      expect(results.size).toBe(20);
    });
  });
});
