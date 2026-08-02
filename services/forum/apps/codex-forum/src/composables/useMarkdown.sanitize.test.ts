import { describe, expect, it } from 'vitest';
import { renderBBCode, renderContent } from './useMarkdown';

describe('useMarkdown sanitizer', () => {
  it('strips forbidden tags like script/iframe/svg', () => {
    const html = renderContent([
      '<p>ok</p>',
      '<script>alert(1)</script>',
      '<iframe src="https://example.com"></iframe>',
      '<svg><circle onload="alert(1)"/></svg>',
      '<style>body{background:red}</style>'
    ].join('\n'));

    expect(html).toContain('<p>ok</p>');
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<iframe\b/i);
    expect(html).not.toMatch(/<svg\b/i);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/alert\(1\)/i);
  });

  it('strips dangerous attributes from allowed tags', () => {
    const html = renderContent([
      '<p onclick="alert(1)" style="color:red">hello</p>',
      '<blockquote onmouseover="alert(2)">quote</blockquote>',
      '<a href="javascript:alert(1)" onclick="alert(2)" style="color:red" formaction="/x">link</a>',
      '<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" onerror="alert(1)" style="border:0" />',
      '<a href="https://example.com" xlink:href="javascript:alert(9)">safe</a>'
    ].join('\n'));

    expect(html).toContain('<p>hello</p>');
    expect(html).toContain('<blockquote>quote</blockquote>');

    expect(html).not.toMatch(/\son\w+=/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\ssrcdoc=/i);
    expect(html).not.toMatch(/\sformaction=/i);
    expect(html).not.toMatch(/\sxlink:href=/i);

    // href/src should be sanitized
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).not.toMatch(/src="data:/i);
  });

  it('forces safe anchor attributes and removes extras', () => {
    const html = renderContent('<a href="https://example.com" target="_self" rel="nofollow" ping="https://evil.example">x</a>');

    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toMatch(/\sping=/i);
  });

  it('allows lists and tables but strips styling/handlers', () => {
    const html = renderContent([
      '<ul onclick="alert(1)"><li>one</li><li style="color:red">two</li></ul>',
      '<table style="border:1px solid red"><thead><tr><th onclick="x()">h</th></tr></thead><tbody><tr><td>cell</td></tr></tbody></table>'
    ].join('\n'));

    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<tr>');
    expect(html).toContain('<th>h</th>');
    expect(html).toContain('<td>cell</td>');
    expect(html).not.toMatch(/\son\w+=/i);
    expect(html).not.toMatch(/\sstyle=/i);
  });

  it('renders markdown tables correctly', () => {
    const html = renderContent([
      '| Name | Value |',
      '| --- | --- |',
      '| Alpha | 1 |',
      '| Beta | 2 |'
    ].join('\n'));

    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<th>Value</th>');
    expect(html).toContain('<td>Alpha</td>');
    expect(html).toContain('<td>1</td>');
  });

  it('does not expand retired filesystem-path attachment markup', () => {
    const markdown = renderContent('[[attach:/workspace/private/output.txt|name=output.txt]]', { topicId: 'public-topic' });
    const bbcode = renderBBCode('[[attach:/workspace/private/output.txt|name=output.txt]]', { topicId: 'public-topic' });

    expect(markdown).not.toContain('/api/robot-attachments');
    expect(bbcode).not.toContain('/api/robot-attachments');
    expect(markdown).toContain('attach:/workspace/private/output.txt');
    expect(bbcode).toContain('attach:/workspace/private/output.txt');
  });

  it('sanitizes bbcode output through the same allowlist', () => {
    const html = renderBBCode('[URL=javascript:alert(1)]x[/URL]\n[IMG]data:text/html;base64,AAAA[/IMG]');
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).not.toMatch(/src="data:/i);
  });

  it('does not render HTML inside inline code spans', () => {
    const html = renderContent('`<img src="https://example.com/x.png" onerror="alert(1)">`');
    expect(html).toContain('<code>');
    expect(html).toContain('&lt;img');
    expect(html).not.toMatch(/<img\b/i);
  });

  it('does not render HTML inside fenced markdown code blocks', () => {
    const html = renderContent([
      '```',
      '<b>bold</b>',
      '<img src="https://example.com/x.png">',
      '```'
    ].join('\n'));

    expect(html).toContain('<pre');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).toContain('&lt;img');
    expect(html).not.toMatch(/<b>bold<\/b>/i);
    expect(html).not.toMatch(/<img\b/i);
  });

  it('does not render HTML inside bbcode [code] blocks', () => {
    const html = renderContent('[code]<img src="https://example.com/x.png"></img>[/code]');
    expect(html).toContain('<pre');
    expect(html).toContain('&lt;img');
    expect(html).not.toMatch(/<img\b/i);
  });

  it('treats user-supplied <code>/<pre> contents as literal when they contain HTML tags', () => {
    const html = renderContent('<code><b>bold</b></code>');
    expect(html).toContain('<code>&lt;b&gt;bold&lt;/b&gt;</code>');
    expect(html).not.toMatch(/<b>bold<\/b>/i);
  });

  it('treats <pre> as fully literal if it contains non-code elements', () => {
    const html = renderContent('<pre><code>hi</code><img src="https://example.com/x.png"></pre>');
    expect(html).toContain('<pre>');
    expect(html).toContain('&lt;img');
    expect(html).not.toMatch(/<img\b/i);
  });

  it('does not render HTML when inline code spans are mixed with markdown and HTML', () => {
    const html = renderContent('Before `<img src="https://example.com/x.png">` after <b>bold</b>.');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<b>bold</b>');
    expect(html).not.toMatch(/<img\b/i);
  });

  it('renders ligatures outside code spans/blocks', () => {
    const html = renderContent('a -- b ... (c) (r) (tm) <- -> <-> => <= >= != 1/2 1/3 1/4 3/4');
    expect(html).toContain('a — b … © ® ™ ← → ↔ ⇒ ≤ ≥ ≠ ½ ⅓ ¼ ¾');
  });

  it('does not render ligatures inside inline code spans', () => {
    const html = renderContent('`-- ... (tm) <- -> <-> => <= >= != 1/2 3/4`');
    expect(html).toContain('-- ... (tm) &lt;- -&gt; &lt;-&gt; =&gt; &lt;= &gt;= != 1/2 3/4');
    expect(html).not.toContain('—');
    expect(html).not.toContain('…');
    expect(html).not.toContain('™');
  });

  it('does not render ligatures inside fenced code blocks', () => {
    const html = renderContent(['```', '-- ... (tm) <- -> <-> => <= >= != 1/2 3/4', '```'].join('\n'));
    expect(html).toContain('-- ... (tm) &lt;- -&gt; &lt;-&gt; =&gt; &lt;= &gt;= != 1/2 3/4');
    expect(html).not.toContain('—');
    expect(html).not.toContain('…');
    expect(html).not.toContain('™');
  });

  it('preserves code block toolbar, semantic content class, and copy button', () => {
    const html = renderContent(['```js', 'console.log("hi")', '```'].join('\n'));
    expect(html).toContain('class="vb-code-block"');
    expect(html).toContain('class="vb-code-toolbar"');
    expect(html).toContain('class="vb-code-content language-javascript"');
    expect(html).toContain('class="vb-code-copy"');
    expect(html).toContain('>Copy<');
  });

  it('lets a longer outer fence contain shorter backtick fences literally', () => {
    const html = renderContent(['````markdown', '```js', 'console.log("inside")', '```', '````'].join('\n'));
    expect(html.match(/class="vb-code-block"/g)).toHaveLength(1);
    expect(html).toContain('```js');
    expect(html).toContain('console.log(&quot;inside&quot;)');
  });

  it('supports tilde fences and closing runs longer than their opener', () => {
    const tildeHtml = renderContent(['~~~markdown', '```js', 'inside', '```', '~~~~'].join('\n'));
    expect(tildeHtml.match(/class="vb-code-block"/g)).toHaveLength(1);
    expect(tildeHtml).toContain('```js');

    const backtickHtml = renderContent(['```text', 'inside', '`````'].join('\n'));
    expect(backtickHtml.match(/class="vb-code-block"/g)).toHaveLength(1);
    expect(backtickHtml).toContain('inside');
  });

  it('does not greedily combine adjacent fenced blocks or require blank boundary lines', () => {
    const html = renderContent([
      '```text',
      'first',
      '```',
      'between',
      '```text',
      'second',
      '```'
    ].join('\n'));
    expect(html.match(/class="vb-code-block"/g)).toHaveLength(2);
    expect(html).toContain('<p>between</p>');
    expect(html).not.toMatch(/<p>\s*<div class="vb-code-block"/);
  });

  it('keeps immediate prose outside the restored block element', () => {
    const html = renderContent(['```text', 'code', '```', 'after'].join('\n'));
    expect(html).toContain('</div>\n<p>after</p>');
    expect(html).not.toMatch(/<p>\s*<div class="vb-code-block"/);
  });

  it('keeps BBCode code tags literal inside Markdown fences', () => {
    const html = renderContent(['```text', '[code]literal[/code]', '```'].join('\n'));
    expect(html.match(/class="vb-code-block"/g)).toHaveLength(1);
    expect(html).toContain('[code]literal[/code]');
    expect(html).not.toContain('VBCODEBLOCKPLACEHOLDER');
  });

  it('does not pair a BBCode opener inside a fence with a closer outside it', () => {
    const html = renderContent(['```text', '[code]literal', '```', 'after[/code]'].join('\n'));
    expect(html.match(/class="vb-code-block"/g)).toHaveLength(1);
    expect(html).toContain('[code]literal');
    expect(html).toContain('<p>after[/code]</p>');
  });

  it('keeps Markdown fence syntax literal inside BBCode code blocks', () => {
    const html = renderContent(['[code]', '```text', 'literal', '```', '[/code]', 'after'].join('\n'));
    expect(html.match(/class="vb-code-block"/g)).toHaveLength(1);
    expect(html).toContain('```text');
    expect(html).toContain('<p>after</p>');
  });

  it('keeps fence-like lines literal until a compatible outer closer arrives', () => {
    const html = renderContent(['`````markdown', '````', 'still inside', '~~~', '`````'].join('\n'));
    expect(html.match(/class="vb-code-block"/g)).toHaveLength(1);
    expect(html).toContain('````');
    expect(html).toContain('~~~');
    expect(html).toContain('still inside');
  });

  it('renders unclosed streamed fences provisionally through the current end of input', () => {
    const source = ['```html', '<img src="https://example.com/x.png" onerror="alert(1)">', '```'].join('\n');
    const openingCompleteAt = source.indexOf('\n') + 1;

    for (let end = openingCompleteAt; end <= source.length; end += 1) {
      const html = renderContent(source.slice(0, end));
      expect(html).toContain('class="vb-code-block"');
      expect(html).not.toMatch(/<img\b/i);
    }
  });

  it('supports indented CRLF fences without changing their literal content', () => {
    const html = renderContent('  ````text\r\n  ```\r\n  value\r\n  ```\r\n  ````');
    expect(html.match(/class="vb-code-block"/g)).toHaveLength(1);
    expect(html).toContain('  ```\r\n  value\r\n  ```');
  });

  it('keeps an indented fenced block inside its Markdown list item', () => {
    const html = renderContent(['- before', '', '  ```text', '  code', '  ```', '', '  after'].join('\n'));
    expect(html.match(/class="vb-code-block"/g)).toHaveLength(1);
    expect(html).toContain('<li>');
    expect(html).toContain('before');
    expect(html).toContain('after');
    expect(html).not.toMatch(/<p>\s*<div class="vb-code-block"/);
  });
});
