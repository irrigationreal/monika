import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createAgentSessionServices,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

test('trusted forum workspaces load project instructions and resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monika-agentd-trust-'));
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');

  try {
    await mkdir(join(cwd, '.pi', 'prompts'), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(cwd, 'AGENTS.md'), '# Forum workspace instructions\n');
    await writeFile(join(cwd, '.pi', 'prompts', 'workspace.md'), '# Workspace prompt\n');
    await writeFile(join(agentDir, 'settings.json'), '{}\n');

    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager });

    assert.equal(services.settingsManager.isProjectTrusted(), true);
    assert.deepEqual(
      services.resourceLoader.getAgentsFiles().agentsFiles.map(({ path }) => path),
      [join(cwd, 'AGENTS.md')],
    );
    assert.deepEqual(
      services.resourceLoader.getPrompts().prompts.map(({ name }) => name),
      ['workspace'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
