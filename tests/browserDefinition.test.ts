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

import {
  BrowserDefinition,
  CHROME_DEFINITION,
  expandEnvVars,
  validateBrowserDefinitionData,
} from '../src/browserDefinition.js';
import type {BrowserDefinitionData} from '../src/browserDefinition.js';
import {
  loadBrowserDefinitionFromFile,
  loadBrowserDefinitions,
  resolveBrowserArg,
  getBrowserDefinitionConfigDir,
} from '../src/browserDefinitionLoader.js';

// --- expandEnvVars ---

describe('expandEnvVars', () => {
  it('expands known env vars', () => {
    const original = process.env['HOME'] ?? process.env['USERPROFILE'];
    assert.ok(original);
    const key = os.platform() === 'win32' ? 'USERPROFILE' : 'HOME';
    assert.strictEqual(expandEnvVars(`\${${key}}/foo`), `${original}/foo`);
  });

  it('replaces unknown env vars with empty string', () => {
    assert.strictEqual(
      expandEnvVars('${UNLIKELY_ENV_VAR_XYZ_12345}/bar'),
      '/bar',
    );
  });

  it('leaves strings without placeholders untouched', () => {
    assert.strictEqual(expandEnvVars('/usr/bin/chrome'), '/usr/bin/chrome');
  });

  it('expands multiple placeholders', () => {
    process.env['_TEST_A'] = 'aaa';
    process.env['_TEST_B'] = 'bbb';
    try {
      assert.strictEqual(
        expandEnvVars('${_TEST_A}/${_TEST_B}'),
        'aaa/bbb',
      );
    } finally {
      delete process.env['_TEST_A'];
      delete process.env['_TEST_B'];
    }
  });
});

// --- validateBrowserDefinitionData ---

describe('validateBrowserDefinitionData', () => {
  it('accepts a valid definition', () => {
    const data = validateBrowserDefinitionData({
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'test',
      displayName: 'Test Browser',
      urlSchemePrefix: 'test',
      profileDirPrefix: 'test',
    });
    assert.strictEqual(data.name, 'test');
  });

  it('rejects missing version', () => {
    assert.throws(
      () =>
        validateBrowserDefinitionData({
          name: 'test',
          displayName: 'Test',
          urlSchemePrefix: 'test',
          profileDirPrefix: 'test',
        }),
      /Missing or invalid.*browserDefinition\/version/,
    );
  });

  it('rejects unsupported version', () => {
    assert.throws(
      () =>
        validateBrowserDefinitionData({
          'chrome-devtools-mcp/browserDefinition/version': '2.0',
          name: 'test',
          displayName: 'Test',
          urlSchemePrefix: 'test',
          profileDirPrefix: 'test',
        }),
      /Unsupported browser definition version "2.0"/,
    );
  });

  it('rejects missing required fields', () => {
    for (const field of ['name', 'displayName', 'urlSchemePrefix', 'profileDirPrefix']) {
      const obj: Record<string, unknown> = {
        'chrome-devtools-mcp/browserDefinition/version': '1.0',
        name: 'test',
        displayName: 'Test',
        urlSchemePrefix: 'test',
        profileDirPrefix: 'test',
      };
      delete obj[field];
      assert.throws(
        () => validateBrowserDefinitionData(obj),
        new RegExp(`Missing or invalid "${field}"`),
      );
    }
  });

  it('includes source path in error message', () => {
    assert.throws(
      () => validateBrowserDefinitionData({}, '/path/to/file.json'),
      /In \/path\/to\/file\.json:/,
    );
  });
});

// --- BrowserDefinition class methods ---

describe('BrowserDefinition.resolveExecutablePath', () => {
  it('returns undefined when no executablePaths defined', () => {
    const def = new BrowserDefinition({
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'test',
      displayName: 'Test',
      urlSchemePrefix: 'test',
      profileDirPrefix: 'test',
    });
    assert.strictEqual(def.resolveExecutablePath('stable'), undefined);
  });

  it('returns undefined when platform has no paths', () => {
    const def = new BrowserDefinition({
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'test',
      displayName: 'Test',
      urlSchemePrefix: 'test',
      profileDirPrefix: 'test',
      executablePaths: {
        fakePlatform: {stable: ['/fake/path']},
      },
    });
    assert.strictEqual(def.resolveExecutablePath('stable'), undefined);
  });

  it('returns undefined when exe does not exist on disk', () => {
    const platform = os.platform();
    const def = new BrowserDefinition({
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'test',
      displayName: 'Test',
      urlSchemePrefix: 'test',
      profileDirPrefix: 'test',
      executablePaths: {
        [platform]: {stable: ['/nonexistent/path/to/browser']},
      },
    });
    assert.strictEqual(def.resolveExecutablePath('stable'), undefined);
  });

  it('finds an existing executable', () => {
    // Use node itself as a known-existing executable.
    const platform = os.platform();
    const def = new BrowserDefinition({
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'test',
      displayName: 'Test',
      urlSchemePrefix: 'test',
      profileDirPrefix: 'test',
      executablePaths: {
        [platform]: {stable: ['/nonexistent', process.execPath]},
      },
    });
    assert.strictEqual(def.resolveExecutablePath('stable'), process.execPath);
  });
});

describe('BrowserDefinition.resolveUserDataDir', () => {
  it('returns undefined when no userDataDirs defined', () => {
    const def = new BrowserDefinition({
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'test',
      displayName: 'Test',
      urlSchemePrefix: 'test',
      profileDirPrefix: 'test',
    });
    assert.strictEqual(def.resolveUserDataDir('stable'), undefined);
  });

  it('returns the dir for the current platform', () => {
    const platform = os.platform();
    const def = new BrowserDefinition({
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'test',
      displayName: 'Test',
      urlSchemePrefix: 'test',
      profileDirPrefix: 'test',
      userDataDirs: {
        [platform]: {stable: '/some/data/dir'},
      },
    });
    assert.strictEqual(def.resolveUserDataDir('stable'), '/some/data/dir');
  });

  it('expands env vars in user data dir', () => {
    process.env['_TEST_DIR'] = '/expanded';
    try {
      const platform = os.platform();
      const def = new BrowserDefinition({
        'chrome-devtools-mcp/browserDefinition/version': '1.0',
        name: 'test',
        displayName: 'Test',
        urlSchemePrefix: 'test',
        profileDirPrefix: 'test',
        userDataDirs: {
          [platform]: {stable: '${_TEST_DIR}/browser/data'},
        },
      });
      assert.strictEqual(
        def.resolveUserDataDir('stable'),
        '/expanded/browser/data',
      );
    } finally {
      delete process.env['_TEST_DIR'];
    }
  });
});

describe('BrowserDefinition.isChannelSupported', () => {
  it('returns true when no unsupportedChannels defined', () => {
    const def = new BrowserDefinition({
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'test',
      displayName: 'Test',
      urlSchemePrefix: 'test',
      profileDirPrefix: 'test',
    });
    assert.strictEqual(def.isChannelSupported('canary'), true);
  });

  it('returns false for unsupported channel on current platform', () => {
    const platform = os.platform();
    const def = new BrowserDefinition({
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'test',
      displayName: 'Test',
      urlSchemePrefix: 'test',
      profileDirPrefix: 'test',
      unsupportedChannels: {
        [platform]: ['canary'],
      },
    });
    assert.strictEqual(def.isChannelSupported('canary'), false);
    assert.strictEqual(def.isChannelSupported('stable'), true);
  });
});

// --- loadBrowserDefinitionFromFile ---

describe('loadBrowserDefinitionFromFile', () => {
  it('loads a valid JSON definition file', () => {
    const tmpDir = os.tmpdir();
    const filePath = path.join(
      tmpDir,
      `test-browser-def-${crypto.randomUUID()}.json`,
    );
    const data: BrowserDefinitionData = {
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'testbrowser',
      displayName: 'Test Browser',
      urlSchemePrefix: 'testbrowser',
      profileDirPrefix: 'testbrowser',
    };
    fs.writeFileSync(filePath, JSON.stringify(data));
    try {
      const def = loadBrowserDefinitionFromFile(filePath);
      assert.strictEqual(def.name, 'testbrowser');
      assert.strictEqual(def.displayName, 'Test Browser');
      assert.ok(def instanceof BrowserDefinition);
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it('expands env vars in loaded file', () => {
    process.env['_TEST_BROWSER_PATH'] = '/opt/test';
    const tmpDir = os.tmpdir();
    const filePath = path.join(
      tmpDir,
      `test-browser-env-${crypto.randomUUID()}.json`,
    );
    const platform = os.platform();
    const data = {
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'envtest',
      displayName: 'Env Test',
      urlSchemePrefix: 'envtest',
      profileDirPrefix: 'envtest',
      executablePaths: {
        [platform]: {stable: ['${_TEST_BROWSER_PATH}/browser']},
      },
    };
    fs.writeFileSync(filePath, JSON.stringify(data));
    try {
      const def = loadBrowserDefinitionFromFile(filePath);
      const paths = def.executablePaths?.[platform]?.stable;
      assert.ok(paths);
      assert.strictEqual(paths[0], '/opt/test/browser');
    } finally {
      fs.unlinkSync(filePath);
      delete process.env['_TEST_BROWSER_PATH'];
    }
  });

  it('throws for invalid JSON definition', () => {
    const tmpDir = os.tmpdir();
    const filePath = path.join(
      tmpDir,
      `test-browser-invalid-${crypto.randomUUID()}.json`,
    );
    fs.writeFileSync(filePath, JSON.stringify({foo: 'bar'}));
    try {
      assert.throws(
        () => loadBrowserDefinitionFromFile(filePath),
        /Missing or invalid/,
      );
    } finally {
      fs.unlinkSync(filePath);
    }
  });
});

// --- loadBrowserDefinitions ---

describe('loadBrowserDefinitions', () => {
  it('always includes built-in Chrome definition', () => {
    const defs = loadBrowserDefinitions();
    assert.ok(defs.has('chrome'));
    assert.strictEqual(defs.get('chrome')!.displayName, 'Chrome');
  });

  it('returns the config dir for the current platform', () => {
    const dir = getBrowserDefinitionConfigDir();
    assert.ok(typeof dir === 'string');
    assert.ok(dir.length > 0);
    if (os.platform() === 'win32') {
      assert.ok(dir.includes('.chrome-devtools-mcp'));
    } else {
      assert.ok(dir.includes('.config/chrome-devtools-mcp/browsers'));
    }
  });
});

// --- resolveBrowserArg ---

describe('resolveBrowserArg', () => {
  it('resolves "chrome" to built-in Chrome definition', () => {
    const defs = new Map<string, BrowserDefinition>();
    defs.set('chrome', CHROME_DEFINITION);
    const result = resolveBrowserArg('chrome', defs);
    assert.strictEqual(result.name, 'chrome');
    assert.strictEqual(result, CHROME_DEFINITION);
  });

  it('resolves "default" to Chrome when no other definitions exist', () => {
    const defs = new Map<string, BrowserDefinition>();
    defs.set('chrome', CHROME_DEFINITION);
    const result = resolveBrowserArg('default', defs);
    assert.strictEqual(result.name, 'chrome');
  });

  it('resolves a named definition', () => {
    const customDef = new BrowserDefinition({
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'custom',
      displayName: 'Custom',
      urlSchemePrefix: 'custom',
      profileDirPrefix: 'custom',
    });
    const defs = new Map<string, BrowserDefinition>();
    defs.set('chrome', CHROME_DEFINITION);
    defs.set('custom', customDef);
    const result = resolveBrowserArg('custom', defs);
    assert.strictEqual(result.name, 'custom');
  });

  it('resolves a JSON file path', () => {
    const tmpDir = os.tmpdir();
    const filePath = path.join(
      tmpDir,
      `test-resolve-arg-${crypto.randomUUID()}.json`,
    );
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        'chrome-devtools-mcp/browserDefinition/version': '1.0',
        name: 'fromfile',
        displayName: 'From File',
        urlSchemePrefix: 'fromfile',
        profileDirPrefix: 'fromfile',
      }),
    );
    try {
      const defs = new Map<string, BrowserDefinition>();
      defs.set('chrome', CHROME_DEFINITION);
      const result = resolveBrowserArg(filePath, defs);
      assert.strictEqual(result.name, 'fromfile');
      assert.strictEqual(result.displayName, 'From File');
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it('throws for unknown browser name', () => {
    const defs = new Map<string, BrowserDefinition>();
    defs.set('chrome', CHROME_DEFINITION);
    assert.throws(
      () => resolveBrowserArg('nonexistent', defs),
      /Unknown browser "nonexistent"/,
    );
  });
});
