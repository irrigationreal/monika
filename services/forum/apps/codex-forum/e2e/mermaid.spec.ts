import { expect, test } from '@playwright/test';

async function mountMarkdownFixture(page: import('@playwright/test').Page, body: string): Promise<void> {
  await page.goto('/');
  await page.evaluate(async (markdownBody) => {
    const loadModule = new Function('path', 'return import(path)') as (
      path: string
    ) => Promise<Record<string, unknown>>;
    const markdownModule = await loadModule('/src/composables/useMarkdown.ts');
    const enhancementModule = await loadModule('/src/lib/mermaidEnhancement.ts');
    const renderContent = markdownModule['renderContent'] as (text: string) => string;
    const directive = enhancementModule['enhanceMermaidDirective'] as {
      mounted(element: HTMLElement): void;
    };

    const root = document.createElement('div');
    root.id = 'mermaid-e2e-root';
    root.className = 'vb-rendered-content';
    root.innerHTML = renderContent(markdownBody);
    document.body.replaceChildren(root);
    directive.mounted(root);
  }, body);
}

function mermaidFence(source: string): string {
  return ['```mermaid', source, '```'].join('\n');
}

test('renders a themed diagram in a permissionless sandbox and exports sanitized SVG', async ({ page }) => {
  await mountMarkdownFixture(
    page,
    mermaidFence(
      [
        'flowchart LR',
        '  accTitle: Forum pipeline',
        '  accDescr: A request travels from the forum to Agentd and Pi.',
        '  Forum --> Agentd --> Pi',
      ].join('\n')
    )
  );

  const block = page.locator('.vb-mermaid-block');
  await expect(block).toHaveAttribute('data-mermaid-state', 'rendered', { timeout: 20_000 });
  const frame = block.locator('.vb-mermaid-render iframe');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(frame).toHaveAttribute('title', 'Forum pipeline');
  await expect(frame).toHaveAttribute('src', /^data:text\/html;charset=UTF-8;base64,/);
  await expect(block.getByRole('button', { name: 'Open full size' })).toBeEnabled();
  await expect(block.getByRole('button', { name: 'Download SVG' })).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await block.getByRole('button', { name: 'Download SVG' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('mermaid-diagram.svg');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const svg = Buffer.concat(chunks).toString('utf8');
  expect(svg).toContain('<svg');
  expect(svg).toContain('Forum pipeline');
  expect(svg).not.toMatch(/<script|<foreignObject|\son\w+=|javascript:/i);
});

test('keeps unsafe per-diagram initialization as escaped source', async ({ page }) => {
  await mountMarkdownFixture(page, mermaidFence('%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\nA --> B'));
  const block = page.locator('.vb-mermaid-block');
  await expect(block).toHaveAttribute('data-mermaid-state', 'rejected');
  await expect(block.locator('.vb-mermaid-status')).toContainText('initialization directives are disabled');
  await expect(block.locator('.vb-mermaid-source')).toHaveAttribute('open', '');
  await expect(block.locator('iframe')).toHaveCount(0);
});

test('renders identical diagrams independently and rerenders them for website theme changes', async ({ page }) => {
  const source = 'sequenceDiagram\n  Browser->>Forum: Render safely\n  Forum-->>Browser: Sandboxed SVG';
  await mountMarkdownFixture(page, [mermaidFence(source), 'between', mermaidFence(source)].join('\n\n'));

  const blocks = page.locator('.vb-mermaid-block');
  await expect(blocks).toHaveCount(2);
  await expect(blocks.nth(0)).toHaveAttribute('data-mermaid-state', 'rendered', { timeout: 20_000 });
  await expect(blocks.nth(1)).toHaveAttribute('data-mermaid-state', 'rendered', { timeout: 20_000 });
  const firstSource = await blocks.nth(0).locator('iframe').getAttribute('src');

  await page.evaluate(async () => {
    const loadModule = new Function('path', 'return import(path)') as (
      path: string
    ) => Promise<Record<string, unknown>>;
    const themeModule = await loadModule('/src/composables/useTheme.ts');
    const useTheme = themeModule['useTheme'] as () => { setTheme(theme: string): void };
    useTheme().setTheme('classic-light');
  });

  await expect
    .poll(async () => blocks.nth(0).locator('iframe').getAttribute('src'), { timeout: 20_000 })
    .not.toBe(firstSource);
  await expect(blocks.nth(1)).toHaveAttribute('data-mermaid-state', 'rendered');
});

test('renders representative built-in grammar families from lazy-loaded Mermaid chunks', async ({ page }) => {
  const sources = [
    'sequenceDiagram\n  Browser->>Forum: Render',
    'classDiagram\n  Animal <|-- Duck',
    'stateDiagram-v2\n  [*] --> Ready',
    'erDiagram\n  USER ||--o{ POST : writes',
    'mindmap\n  root((Forum))\n    Mermaid',
    'journey\n  title Diagram journey\n  section Render\n    Parse source: 5: Browser',
    'architecture-beta\n  group api(cloud)[API]\n  service web(server)[Web] in api',
  ];
  await mountMarkdownFixture(page, sources.map(mermaidFence).join('\n\n'));

  const blocks = page.locator('.vb-mermaid-block');
  await expect(blocks).toHaveCount(sources.length);
  for (let index = 0; index < sources.length; index += 1) {
    await expect(blocks.nth(index)).toHaveAttribute('data-mermaid-state', 'rendered', { timeout: 40_000 });
  }
});

test('does not allow architecture parsing to pollute the host Object prototype', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    delete (Object.prototype as Record<string, unknown>)['mermaidPolluted'];
  });
  const payload = [
    'architecture-beta',
    ' group mermaidPolluted(cloud)[Real]',
    ' service a(server)[A] in __proto__',
    ' service b(server)[B] in mermaidPolluted',
    ' a:R -- L:b',
  ].join('\n');
  await mountMarkdownFixture(page, mermaidFence(payload));

  await expect
    .poll(async () => page.locator('.vb-mermaid-block').getAttribute('data-mermaid-state'), { timeout: 20_000 })
    .toMatch(/^(rendered|error)$/);
  await expect
    .poll(async () => page.evaluate(() => (Object.prototype as Record<string, unknown>)['mermaidPolluted']))
    .toBeUndefined();
});
