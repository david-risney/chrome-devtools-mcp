/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {executablePath} from 'puppeteer';

import {launch} from '../src/browser.js';
import {loadBrowserDefinitionFromFile} from '../src/browserDefinitionLoader.js';
import type {ToolDefinition} from '../src/tools/ToolDefinition';

describe('e2e', () => {
  async function withClient(
    cb: (client: Client) => Promise<void>,
    extraArgs: string[] = [],
    {skipDefaults = false}: {skipDefaults?: boolean} = {},
  ) {
    const defaultArgs = skipDefaults
      ? ['build/src/bin/chrome-devtools-mcp.js', '--headless']
      : [
          'build/src/bin/chrome-devtools-mcp.js',
          '--headless',
          '--isolated',
          '--executable-path',
          executablePath(),
        ];
    const transport = new StdioClientTransport({
      command: 'node',
      args: [
        ...defaultArgs,
        ...extraArgs,
      ],
    });
    const client = new Client(
      {
        name: 'e2e-test',
        version: '1.0.0',
      },
      {
        capabilities: {},
      },
    );

    try {
      await client.connect(transport);
      await cb(client);
    } finally {
      await client.close();
    }
  }
  it('calls a tool', async t => {
    await withClient(async client => {
      const result = await client.callTool({
        name: 'list_pages',
        arguments: {},
      });
      t.assert.snapshot?.(JSON.stringify(result.content));
    });
  });

  it('calls a tool multiple times', async t => {
    await withClient(async client => {
      let result = await client.callTool({
        name: 'list_pages',
        arguments: {},
      });
      result = await client.callTool({
        name: 'list_pages',
        arguments: {},
      });
      t.assert.snapshot?.(JSON.stringify(result.content));
    });
  });

  it('has all tools', async () => {
    await withClient(async client => {
      const {tools} = await client.listTools();
      const exposedNames = tools.map(t => t.name).sort();
      const files = fs.readdirSync('build/src/tools');
      const definedNames = [];
      for (const file of files) {
        if (
          file === 'ToolDefinition.js' ||
          file === 'tools.js' ||
          file === 'slim'
        ) {
          continue;
        }
        const fileTools = await import(`../src/tools/${file}`);
        for (const maybeTool of Object.values<unknown>(fileTools)) {
          if (typeof maybeTool === 'function') {
            const tool = (maybeTool as (val: boolean) => ToolDefinition)(false);
            if (tool && typeof tool === 'object' && 'name' in tool) {
              if (tool.annotations?.conditions) {
                continue;
              }
              definedNames.push(tool.name);
            }
            continue;
          }
          if (
            typeof maybeTool === 'object' &&
            maybeTool !== null &&
            'name' in maybeTool
          ) {
            const tool = maybeTool as ToolDefinition;
            if (tool.annotations?.conditions) {
              continue;
            }
            definedNames.push(tool.name);
          }
        }
      }
      definedNames.sort();
      assert.deepStrictEqual(exposedNames, definedNames);
    });
  });

  it('has experimental extensions tools', async () => {
    await withClient(
      async client => {
        const {tools} = await client.listTools();
        const clickAt = tools.find(t => t.name === 'install_extension');
        assert.ok(clickAt);
      },
      ['--category-extensions'],
    );
  });

  it('has experimental vision tools', async () => {
    await withClient(
      async client => {
        const {tools} = await client.listTools();
        const clickAt = tools.find(t => t.name === 'click_at');
        assert.ok(clickAt);
      },
      ['--experimental-vision'],
    );
  });

  it('has experimental interop tools', async () => {
    await withClient(
      async client => {
        const {tools} = await client.listTools();
        const getTabId = tools.find(t => t.name === 'get_tab_id');
        assert.ok(getTabId);
      },
      ['--experimental-interop-tools'],
    );
  });

  it('works with --browser argument', async () => {
    await withClient(
      async client => {
        const result = await client.callTool({
          name: 'list_pages',
          arguments: {},
        });
        assert.ok(result.content);
      },
      ['--browser', 'chrome'],
    );
  });

  it('works with --browser pointing to a JSON definition file', async () => {
    const edgeJsonPath = path.resolve('tests/fixtures/edge.json');
    const def = loadBrowserDefinitionFromFile(edgeJsonPath);
    if (!def.resolveExecutablePath('stable')) {
      return; // Edge not installed — skip
    }

    await withClient(
      async client => {
        const result = await client.callTool({
          name: 'list_pages',
          arguments: {},
        });
        assert.ok(result.content);
      },
      ['--browser', edgeJsonPath],
    );
  });

  it('works with --browser JSON definition and --auto-connect', async () => {
    const edgeJsonPath = path.resolve('tests/fixtures/edge.json');
    const def = loadBrowserDefinitionFromFile(edgeJsonPath);
    const edgePath = def.resolveExecutablePath('stable');
    if (!edgePath) {
      return; // Edge not installed — skip
    }

    // Create a temp user data dir for an isolated Edge instance.
    const userDataDir = path.join(
      os.tmpdir(),
      `edge-autoconnect-e2e-${crypto.randomUUID()}`,
    );

    // Build a test-specific JSON definition with the temp userDataDir baked in,
    // so --auto-connect resolves the data dir entirely from the JSON.
    const platform = os.platform();
    const testDefData = {
      ...def.data,
      userDataDirs: {
        [platform]: {stable: userDataDir},
      },
    };
    const testJsonPath = path.join(
      os.tmpdir(),
      `edge-autoconnect-def-${crypto.randomUUID()}.json`,
    );
    fs.writeFileSync(testJsonPath, JSON.stringify(testDefData));

    let edgeBrowser;
    try {
      edgeBrowser = await launch({
        headless: true,
        isolated: false,
        userDataDir,
        executablePath: edgePath,
        devtools: false,
        chromeArgs: ['--remote-debugging-port=0'],
      });
    } catch {
      fs.unlinkSync(testJsonPath);
      return; // Edge found but not launchable — skip
    }
    try {
      await withClient(
        async client => {
          const result = await client.callTool({
            name: 'list_pages',
            arguments: {},
          });
          assert.ok(result.content);
        },
        [
          '--browser',
          testJsonPath,
          '--auto-connect',
        ],
        {skipDefaults: true},
      );
    } finally {
      await edgeBrowser.close();
      fs.unlinkSync(testJsonPath);
    }
  });
});
