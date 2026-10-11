import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_IMAGE_CONTEXT_POLICY, imageContextPolicyFromEnv, projectImageContext } from '../config/extensions/image-context-core.mjs';

const image = (data) => ({ type: 'image', data, mimeType: 'image/png' });
const user = (content, timestamp = 1) => ({ role: 'user', content, timestamp });
const result = (id, content) => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content, details: { original: true }, timestamp: 2 });
const policy = { enabled: true, maxImages: 2, maxBase64Bytes: 8 };
const count = (messages) => messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'image');

function freeze(value) {
	if (value && typeof value === 'object') { Object.freeze(value); for (const v of Object.values(value)) freeze(v); }
	return value;
}

test('retains newest images within count and byte budgets; preserves transcript and pairing', () => {
	const messages = freeze([
		user('inspect'),
		{ role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'read', arguments: { path: '/tmp/ref.png' } }] },
		result('a', [{ type: 'text', text: 'original note' }, image('aaaa')]),
		result('b', [image('bbbb')]), result('c', [image('cccc')]),
	]);
	const before = JSON.stringify(messages);
	const projected = projectImageContext(messages, policy);
	assert.deepEqual(count(projected.messages).map(b => b.data), ['bbbb', 'cccc']);
	assert.equal(projected.stats.omittedImages, 1);
	assert.equal(projected.messages[2].toolCallId, 'a');
	assert.equal(projected.messages[2].details, messages[2].details);
	assert.equal(projected.messages[2].content[0].text, 'original note');
	assert.match(projected.messages[2].content[1].text, /sourcePath.*\/tmp\/ref.png/);
	assert.match(projected.messages[2].content[1].text, /not a visual summary/);
	assert.equal(JSON.stringify(messages), before);
	assert.deepEqual(projectImageContext(messages, policy), projected);
	assert.deepEqual(projectImageContext(projected.messages, policy).messages, projected.messages);
});

test('byte budget is independent of count and uses UTF-8 byte size', () => {
	const projected = projectImageContext([user('x'), result('a', [image('aaaa')]), result('b', [image('ééé')])], policy);
	assert.equal(projected.stats.retainedBase64Bytes, 6);
	assert.equal(count(projected.messages).length, 1);
});

test('explicit newest-user images are protected, even when over budget', () => {
	const messages = [user([image('old')]), result('a', [image('tool')]), user([image('0123456789'), image('abcd')], 3)];
	const projected = projectImageContext(messages, policy);
	assert.deepEqual(count(projected.messages).map(b => b.data), ['0123456789', 'abcd']);
	assert.equal(projected.stats.protectedInputOverBudget, true);
	assert.equal(projected.stats.omittedImages, 2);
});

test('new user text makes former user images eligible; custom attachments are bounded', () => {
	const projected = projectImageContext([user([image('aaaa')]), { role: 'custom', content: [image('bbbb')] }, user('next'), result('c', [image('cccc')])], policy);
	assert.deepEqual(count(projected.messages).map(b => b.data), ['bbbb', 'cccc']);
});

test('fresh re-read wins over old images within a long user turn', () => {
	const messages = [user('inspect'), ...['a', 'b', 'c', 'd', 'e'].map(id => result(id, [image(id.repeat(4))]))];
	assert.deepEqual(count(projectImageContext(messages, policy).messages).map(b => b.data), ['dddd', 'eeee']);
});

test('oversized tool image is explicitly omitted without claiming it can be recovered', () => {
	const projected = projectImageContext([user('x'), result('browser', [image('123456789')])], policy);
	assert.equal(count(projected.messages).length, 0);
	assert.match(projected.messages[1].content[0].text, /ask the user/);
	assert.match(projected.messages[1].content[0].text, /smaller copy/);
});

test('branch/resume policy derives solely from supplied active context, not cached state', () => {
	const branchA = [user('a'), result('a', [image('aaaa')]), result('b', [image('bbbb')]), result('c', [image('cccc')])];
	const branchB = [user('b'), result('d', [image('dddd')])];
	projectImageContext(branchA, policy);
	assert.deepEqual(count(projectImageContext(branchB, policy).messages).map(b => b.data), ['dddd']);
});

test('system, assistant signatures and unknown roles are not rewritten', () => {
	const messages = [{ role: 'system', content: 'prompt' }, { role: 'assistant', content: [{ type: 'thinking', thinkingSignature: 'opaque' }] }, { role: 'future', content: [image('123456789')] }];
	assert.equal(projectImageContext(messages, policy).messages, messages);
});

test('disabled and text-only projections are no-ops', () => {
	const messages = [user('x'), result('a', [image('123456789')])];
	assert.equal(projectImageContext(messages, { ...policy, enabled: false }).messages, messages);
	const textOnly = [user('hello')];
	assert.equal(projectImageContext(textOnly).messages, textOnly);
});

test('configuration has documented defaults, overrides, and safe fallback on invalid input', () => {
	assert.deepEqual(imageContextPolicyFromEnv({}).policy, DEFAULT_IMAGE_CONTEXT_POLICY);
	assert.deepEqual(imageContextPolicyFromEnv({ MONIKA_IMAGE_CONTEXT_ENABLED: '0', MONIKA_IMAGE_CONTEXT_MAX_IMAGES: '6', MONIKA_IMAGE_CONTEXT_MAX_BASE64_BYTES: '1024' }).policy, { enabled: false, maxImages: 6, maxBase64Bytes: 1024 });
	for (const value of ['0', '-1', '1.5', 'Infinity', '2e3', '999999999999999999']) {
		const parsed = imageContextPolicyFromEnv({ MONIKA_IMAGE_CONTEXT_MAX_IMAGES: value });
		assert.equal(parsed.policy.maxImages, 4);
		assert.equal(parsed.warnings.length, 1);
	}
	assert.equal(imageContextPolicyFromEnv({ MONIKA_IMAGE_CONTEXT_ENABLED: 'false' }).policy.enabled, true);
});


test('duplicate call IDs resolve each result against nearest preceding call', () => {
 const call = path => ({ role: 'assistant', content: [{ type: 'toolCall', id: 'same', name: 'read', arguments: { path } }] });
 const projected = projectImageContext([user('x'), call('/first.png'), result('same', [image('aaaa')]), call('/second.png'), result('same', [image('bbbb')])], { ...policy, maxImages: 1 });
 assert.match(projected.messages[2].content[0].text, /first.png/);
 assert.doesNotMatch(projected.messages[2].content[0].text, /second.png/);
});

test('legacy file_path remains exact; excessive paths are explicitly non-actionable prefixes', () => {
 for (const length of [1200, 5000]) {
  const path = '/' + 'a'.repeat(length);
  const projected = projectImageContext([user('x'), { role: 'assistant', content: [{ type: 'toolCall', id: 'a', arguments: { file_path: path } }] }, result('a', [image('123456789')])], policy);
  const text = projected.messages[2].content[0].text;
  if (length === 1200) assert.ok(text.includes(JSON.stringify(path)));
  else { assert.match(text, /sourcePathTruncated.*true/); assert.match(text, /not an actionable path/); }
 }
});

test('ten-image large-session regression retains newest four under default budget', () => {
 const sizes = [2957212, 3180680, 2478280, 2575484, 1338148, 1355904, 1314072, 1296884, 1316636, 1301924];
 const messages = [user('inspect'), ...sizes.map((n, i) => result(String(i), [image('A'.repeat(n))])), user('interrupt and reply briefly')];
 const before = JSON.stringify(messages);
 const projected = projectImageContext(messages);
 assert.equal(projected.stats.omittedImages, 6);
 assert.equal(projected.stats.retainedBase64Bytes, 5229516);
 assert.equal(count(projected.messages).length, 4);
 assert.ok(Buffer.byteLength(JSON.stringify(projected.messages)) < 6 * 1024 * 1024);
 assert.equal(JSON.stringify(messages), before);
});
