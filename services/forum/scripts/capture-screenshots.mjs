import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(new URL('../apps/codex-forum/', import.meta.url));
const { chromium } = require('playwright');

const BASE_URL = 'https://forum.irrigate.cc';
const OUTPUT_DIR = path.resolve('docs/screenshots');
const VIEWPORT = { width: 1440, height: 900 };
const NAV_TIMEOUT_MS = 30_000;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TARGET_TOPIC_ID = 'e0feafb9-69ea-4d5c-8aa3-bbfb3e6159cc';

const demoConversation = [
  {
    name: 'neon',
    title: 'Admin',
    avatar: avatarDataUrl('N', ['#4f46e5', '#06b6d4']),
    html:
      `<p><strong>Pitch:</strong> “vBulletin, but every thread is a robot session.”</p>` +
      `<p>When you start a thread, the robot replies as the robot user. Every reply is the next turn.</p>` +
      `<ul class="vb-list">` +
      `<li><strong>Posts = chat messages</strong> (turns in the session)</li>` +
      `<li><strong>Forums = folders</strong> (optionally with a per-forum pre-prompt)</li>` +
      `<li><strong>API-first</strong> (automations can read/post topics)</li>` +
      `</ul>`
  },
  {
    name: 'Robot',
    title: 'Robot Responder',
    avatar: avatarDataUrl('C', ['#0f172a', '#1f2937']),
    html:
      `<p>Understood. I’ll make the README unmistakable and practical:</p>` +
      `<ul class="vb-list">` +
      `<li><strong>Threads = sessions</strong> (durable state + history)</li>` +
      `<li><strong>Posts = turns</strong> (human ↔ robot ↔ tools)</li>` +
      `<li><strong>Forums = workspaces</strong> (folders + optional pre-prompt defaults)</li>` +
      `</ul>` +
      `<p>Example automation (read forums):</p>` +
      `<pre class="vb-code"><code>curl -H \"Authorization: Bearer $API_KEY\" \\\n  \"https://forum.irrigate.cc/api/forums\"</code></pre>`
  }
];

function avatarDataUrl(label, [startColor, endColor]) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" role="img" aria-label="${label}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${startColor}"/><stop offset="1" stop-color="${endColor}"/></linearGradient></defs><rect width="96" height="96" rx="18" fill="url(#g)"/><text x="50%" y="56%" text-anchor="middle" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial" font-size="34" font-weight="700" fill="#fff">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

async function decorateTopic(page) {
  await page.addStyleTag({
    content: [
      '.vb-rendered-content pre.vb-code { background: #0b1020 !important; color: #e5e7eb !important; border: 1px solid rgba(255, 255, 255, 0.08) !important; }',
      '.vb-rendered-content pre.vb-code code { color: inherit !important; }',
      '.vb-post-trace { display: none !important; }',
      '.vb-post-attachments { display: none !important; }',
      '.vb-live-activity { display: none !important; }',
      '.vb-admin-panel { display: none !important; }',
      '.vb-controls.vb-controls-bottom { display: none !important; }',
      '.vb-quick-reply { display: none !important; }'
    ].join('\n')
  });

  await page.evaluate((conversation) => {
    const title = document.querySelector('.vb-thread-titlebar h2');
    if (title) title.textContent = 'vBulletin threads as robot sessions';

    const welcomeName = document.querySelector('.vb-welcome-left strong');
    if (welcomeName) welcomeName.textContent = 'neon';

    const breadcrumb = document.querySelector('.vb-breadcrumb');
    if (breadcrumb) {
      const parts = Array.from(breadcrumb.querySelectorAll('.vb-breadcrumb-item'));
      if (parts.length >= 2) {
        const labels = ['Forum Home', 'Robot Sessions', 'README Automations'];
        parts.forEach((item, idx) => {
          const link = item.querySelector('a');
          const target = link ?? item;
          if (labels[idx]) target.textContent = labels[idx];
        });
      }
    }

    document.querySelectorAll('.vb-post').forEach((post) => {
      const text = post.textContent?.toLowerCase() ?? '';
      if (text.includes('you got cut off')) post.remove();
    });

    const posts = Array.from(document.querySelectorAll('.vb-post'));
    posts.forEach((post, idx) => {
      const data = conversation[idx] ?? null;
      if (!data) {
        post.remove();
        return;
      }

      post.querySelectorAll('.vb-user-name').forEach((el) => {
        el.textContent = data.name;
      });
      post.querySelectorAll('.vb-user-title').forEach((el) => {
        el.textContent = data.title;
      });
      post.querySelectorAll('.vb-avatar').forEach((el) => {
        el.setAttribute('src', data.avatar);
      });

      const metaLines = post.querySelectorAll('.vb-user-meta div');
      if (metaLines.length > 0) {
        const lines = [
          idx === 0 ? 'Join Date: Jan 2026' : 'Join Date: Dec 2025',
          idx === 0 ? 'Location: Online' : 'Location: /root/work',
          idx === 0 ? 'Posts: 127' : 'Posts: 2,941'
        ];
        metaLines.forEach((line, lineIdx) => {
          const label = line.querySelector('span');
          if (label) {
            label.textContent = `${lines[lineIdx]?.split(':')[0] ?? 'Meta'}:`;
          }
          const textNode = line.childNodes[line.childNodes.length - 1];
          if (textNode) {
            textNode.textContent = ` ${lines[lineIdx]?.split(':')[1] ?? ''}`;
          }
        });
      }

      post.querySelectorAll('.vb-post-text').forEach((el) => {
        el.innerHTML = data.html;
      });

      const header = post.querySelector('.vb-post-header div');
      if (header) header.textContent = 'Jan 21, 2026';
    });

    const sessionInspector = Array.from(document.querySelectorAll('.vb-robot-state')).find((panel) => {
      const heading = panel.querySelector('.vb-table-header span');
      return (heading?.textContent ?? '').trim() === 'Session Inspector';
    });
    if (sessionInspector) sessionInspector.remove();

    const robotPanel = Array.from(document.querySelectorAll('.vb-robot-state')).find((panel) => {
      const heading = panel.querySelector('.vb-table-header span');
      return (heading?.textContent ?? '').trim() === 'Robot State';
    });
    if (robotPanel) {
      const statusPill = robotPanel.querySelector('.vb-status-pill');
      if (statusPill) statusPill.textContent = 'responding';

      const row = robotPanel.querySelector('.vb-state-row');
      if (row) {
        const cells = Array.from(row.querySelectorAll('div'));
        if (cells[0]) cells[0].innerHTML = '<strong>Status:</strong> responding';
        if (cells[1]) cells[1].innerHTML = '<strong>Last Update:</strong> Jan 21, 2026 3:04 PM';
      }

      const body = robotPanel.querySelector('.vb-robot-body');
      if (body) {
        const maybeModel = Array.from(body.querySelectorAll(':scope > div')).find((el) =>
          (el.textContent ?? '').trim().startsWith('Model:')
        );
        if (maybeModel) maybeModel.innerHTML = '<strong>Model:</strong> gpt-5.2';

        const activity = body.querySelector('.vb-activity');
        if (activity) {
          activity.innerHTML =
            '<strong>Activity:</strong>' +
            '<ol class=\"vb-activity-feed vb-activity-feed--compact\">' +
            '<li class=\"vb-activity-item\">' +
            '<div class=\"vb-activity-icon\">🧠</div>' +
            '<div class=\"vb-activity-content\">' +
            '<div class=\"vb-activity-head\">' +
            '<span class=\"vb-activity-title\">Summarize repo purpose</span>' +
            '<span class=\"vb-activity-pill vb-activity-pill--done\">done</span>' +
            '</div>' +
            '<div class=\"vb-activity-detail\">Thread = session. Posts = turns. Forums = folders with optional pre-prompts.</div>' +
            '</div>' +
            '</li>' +
            '<li class=\"vb-activity-item vb-activity-item--tool\">' +
            '<div class=\"vb-activity-icon\">🛠️</div>' +
            '<div class=\"vb-activity-content\">' +
            '<div class=\"vb-activity-head\">' +
            '<span class=\"vb-activity-title\">Tool: exec_command</span>' +
            '<span class=\"vb-activity-time\">3:04 PM</span>' +
            '</div>' +
            '<div class=\"vb-activity-detail\">pnpm test</div>' +
            '<div class=\"vb-activity-meta\">' +
            '<span class=\"vb-activity-pill vb-activity-pill--done\">ok</span>' +
            '</div>' +
            '</div>' +
            '</li>' +
            '<li class=\"vb-activity-item vb-activity-item--tool\">' +
            '<div class=\"vb-activity-icon\">🔎</div>' +
            '<div class=\"vb-activity-content\">' +
            '<div class=\"vb-activity-head\">' +
            '<span class=\"vb-activity-title\">Tool: web.run</span>' +
            '<span class=\"vb-activity-time\">3:03 PM</span>' +
            '</div>' +
            '<div class=\"vb-activity-detail\">Look up deployment host + API endpoints</div>' +
            '<div class=\"vb-activity-meta\">' +
            '<span class=\"vb-activity-pill vb-activity-pill--done\">done</span>' +
            '</div>' +
            '</div>' +
            '</li>' +
            '</ol>';
        }

        const toolLists = Array.from(body.querySelectorAll('.vb-tool-list'));
        if (toolLists[0]) {
          toolLists[0].innerHTML =
            '<div class=\"vb-tool-title\"><span>Tool Usage</span></div>' +
            '<div class=\"vb-tool-item\">' +
            '<div class=\"vb-tool-toggle\" style=\"cursor: default;\">' +
            '<span><strong>exec_command</strong> · 3:04 PM</span>' +
            '<span>ok</span>' +
            '</div>' +
            '<div class=\"vb-tool-details\">' +
            '<div><strong>Command:</strong> pnpm test</div>' +
            '<div><strong>Output:</strong> 222 tests passed</div>' +
            '</div>' +
            '</div>';
        }
      }
    }
  }, demoConversation);
}

async function renderProductShot(
  browser,
  screenshotPng,
  outputPath,
  options = {}
) {
  const encoded = screenshotPng.toString('base64');
  const viewport = options.viewport ?? { width: 1600, height: 1000 };
  const deviceScaleFactor = options.deviceScaleFactor ?? 2;
  const framePage = await browser.newPage({
    viewport,
    deviceScaleFactor,
    userAgent: USER_AGENT
  });

  await framePage.setContent(
    `<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\" />\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n<title>Codex Forum</title>\n<style>\n  :root {\n    --bg0: #0f172a;\n    --bg1: #1e293b;\n  }\n  html, body { height: 100%; }\n  body {\n    margin: 0;\n    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;\n    background:\n      radial-gradient(900px 600px at 15% 20%, rgba(56, 189, 248, 0.22), transparent 60%),\n      radial-gradient(900px 600px at 85% 10%, rgba(99, 102, 241, 0.22), transparent 55%),\n      linear-gradient(135deg, #f8fafc, #eef2ff);\n  }\n  .wrap {\n    height: 100%;\n    display: grid;\n    place-items: center;\n    padding: 72px;\n    box-sizing: border-box;\n  }\n  .window {\n    width: min(1200px, 100%);\n    border-radius: 22px;\n    overflow: hidden;\n    background: white;\n    border: 1px solid rgba(15, 23, 42, 0.12);\n    box-shadow:\n      0 20px 55px rgba(15, 23, 42, 0.18),\n      0 4px 14px rgba(15, 23, 42, 0.10);\n  }\n  .chrome {\n    display: flex;\n    align-items: center;\n    gap: 14px;\n    padding: 12px 16px;\n    background: linear-gradient(#f8fafc, #e2e8f0);\n    border-bottom: 1px solid rgba(15, 23, 42, 0.12);\n  }\n  .dots {\n    display: flex;\n    gap: 8px;\n  }\n  .dot {\n    width: 12px;\n    height: 12px;\n    border-radius: 9999px;\n  }\n  .dot.red { background: #ff5f57; }\n  .dot.yellow { background: #febc2e; }\n  .dot.green { background: #28c840; }\n  .address {\n    flex: 1;\n    text-align: center;\n    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace;\n    font-size: 12px;\n    color: rgba(15, 23, 42, 0.78);\n    background: rgba(255, 255, 255, 0.75);\n    border: 1px solid rgba(15, 23, 42, 0.12);\n    border-radius: 9999px;\n    padding: 6px 10px;\n    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);\n  }\n  .shot {\n    display: block;\n    width: 100%;\n    height: auto;\n  }\n</style>\n</head>\n<body>\n  <div class=\"wrap\">\n    <div class=\"window\">\n      <div class=\"chrome\">\n        <div class=\"dots\" aria-hidden=\"true\">\n          <span class=\"dot red\"></span>\n          <span class=\"dot yellow\"></span>\n          <span class=\"dot green\"></span>\n        </div>\n        <div class=\"address\">forum.irrigate.cc / Robot Sessions</div>\n      </div>\n      <img class=\"shot\" id=\"shot\" alt=\"Codex Forum screenshot\" src=\"data:image/png;base64,${encoded}\" />\n    </div>\n  </div>\n</body>\n</html>\n`,
    { waitUntil: 'domcontentloaded' }
  );

  await framePage.waitForSelector('#shot');
  await framePage.evaluate(() => new Promise((resolve) => {
    const img = document.getElementById('shot');
    if (!(img instanceof HTMLImageElement)) return resolve(undefined);
    if (img.complete) return resolve(undefined);
    img.addEventListener('load', () => resolve(undefined), { once: true });
    img.addEventListener('error', () => resolve(undefined), { once: true });
  }));

  await framePage.screenshot({ path: outputPath });
  await framePage.close();
}

async function captureInPage(page) {
  await page.waitForSelector('.vb-post', { timeout: 15000 });
  await decorateTopic(page);
  const section = page.locator('.vb-section').first();
  const box = await section.boundingBox();
  if (!box) {
    throw new Error('Failed to locate .vb-section for screenshot.');
  }
  const clip = {
    x: Math.max(0, Math.floor(box.x)),
    y: Math.max(0, Math.floor(box.y)),
    width: Math.max(1, Math.floor(box.width)),
    height: Math.max(1, Math.min(900, Math.floor(box.height)))
  };
  const robotPanel = page.locator('.vb-robot-state').first();
  const robotBox = await robotPanel.boundingBox();
  if (robotBox && robotBox.y + robotBox.height > clip.y) {
    const targetHeight = Math.ceil(robotBox.y + robotBox.height - clip.y + 12);
    clip.height = Math.min(Math.max(1, targetHeight), Math.floor(box.height));
  }
  const screenshotPng = await page.screenshot({ clip, type: 'png' });
  return screenshotPng;
}

async function run() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const screenshotPng = await (async () => {
    const page = await browser.newPage({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      userAgent: USER_AGENT
    });
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    await page.goto(`${BASE_URL}/topics/${TARGET_TOPIC_ID}`, { waitUntil: 'domcontentloaded' });
    const png = await captureInPage(page);
    await page.close();
    return png;
  })();
  await renderProductShot(
    browser,
    screenshotPng,
    path.join(OUTPUT_DIR, 'product-topic-codex.png'),
    { deviceScaleFactor: 2 }
  );
  await renderProductShot(
    browser,
    screenshotPng,
    path.join(OUTPUT_DIR, 'product-topic-codex-1600.png'),
    { deviceScaleFactor: 1 }
  );

  // Optional: capture a taller version including Robot State.
  const tallScreenshot = await (async () => {
    const page = await browser.newPage({
      viewport: { width: VIEWPORT.width, height: 1200 },
      deviceScaleFactor: 2,
      userAgent: USER_AGENT
    });
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    await page.goto(`${BASE_URL}/topics/${TARGET_TOPIC_ID}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.vb-post', { timeout: 15000 });
    await decorateTopic(page);
    const section = page.locator('.vb-section').first();
    const box = await section.boundingBox();
    const robotPanel = page.locator('.vb-robot-state').first();
    const robotBox = await robotPanel.boundingBox();
    if (!box || !robotBox) {
      await page.close();
      return null;
    }
    const clip = {
      x: Math.max(0, Math.floor(box.x)),
      y: Math.max(0, Math.floor(box.y)),
      width: Math.max(1, Math.floor(box.width)),
      height: Math.max(1, Math.floor(robotBox.y + robotBox.height - box.y + 18))
    };
    const png = await page.screenshot({ clip, type: 'png' });
    await page.close();
    return png;
  })();

  if (tallScreenshot) {
    await renderProductShot(
      browser,
      tallScreenshot,
      path.join(OUTPUT_DIR, 'product-topic-codex-tall.png'),
      { viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 2 }
    );
    await renderProductShot(
      browser,
      tallScreenshot,
      path.join(OUTPUT_DIR, 'product-topic-codex-tall-1600.png'),
      { viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 }
    );
  }

  await browser.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
