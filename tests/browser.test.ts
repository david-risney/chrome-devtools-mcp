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

import {executablePath} from 'puppeteer';

import {
  BrowserDefinition,
  detectDisplay,
  ensureBrowserConnected,
  launch,
  CHROME_DEFINITION,
} from '../src/browser.js';

describe('browser', () => {
  it('detects display does not crash', () => {
    detectDisplay();
  });

  it('cannot launch multiple times with the same profile', async () => {
    const tmpDir = os.tmpdir();
    const folderPath = path.join(tmpDir, `temp-folder-${crypto.randomUUID()}`);
    const browser1 = await launch({
      headless: true,
      isolated: false,
      userDataDir: folderPath,
      executablePath: executablePath(),
      devtools: false,
    });
    try {
      try {
        const browser2 = await launch({
          headless: true,
          isolated: false,
          userDataDir: folderPath,
          executablePath: executablePath(),
          devtools: false,
        });
        await browser2.close();
        assert.fail('not reached');
      } catch (err) {
        assert.strictEqual(
          err.message,
          `The browser is already running for ${folderPath}. Use --isolated to run multiple browser instances.`,
        );
      }
    } finally {
      await browser1.close();
    }
  });

  it('launches with the initial viewport', async () => {
    const tmpDir = os.tmpdir();
    const folderPath = path.join(tmpDir, `temp-folder-${crypto.randomUUID()}`);
    const browser = await launch({
      headless: true,
      isolated: false,
      userDataDir: folderPath,
      executablePath: executablePath(),
      viewport: {
        width: 1501,
        height: 801,
      },
      devtools: false,
    });
    try {
      const [page] = await browser.pages();
      const result = await page.evaluate(() => {
        return {width: window.innerWidth, height: window.innerHeight};
      });
      assert.deepStrictEqual(result, {
        width: 1501,
        height: 801,
      });
    } finally {
      await browser.close();
    }
  });
  it('connects to an existing browser with userDataDir', async () => {
    const tmpDir = os.tmpdir();
    const folderPath = path.join(tmpDir, `temp-folder-${crypto.randomUUID()}`);
    const browser = await launch({
      headless: true,
      isolated: false,
      userDataDir: folderPath,
      executablePath: executablePath(),
      devtools: false,
      chromeArgs: ['--remote-debugging-port=0'],
    });
    try {
      const connectedBrowser = await ensureBrowserConnected({
        userDataDir: folderPath,
        devtools: false,
      });
      assert.ok(connectedBrowser);
      assert.ok(connectedBrowser.connected);
      connectedBrowser.disconnect();
    } finally {
      await browser.close();
    }
  });
});

describe('BrowserDefinition', () => {
  it('returns correct display names', () => {
    assert.strictEqual(CHROME_DEFINITION.displayName, 'Chrome');
    const edgeDef = new BrowserDefinition({
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'edge',
      displayName: 'Microsoft Edge',
      urlSchemePrefix: 'edge',
      profileDirPrefix: 'edge',
    });
    assert.strictEqual(edgeDef.displayName, 'Microsoft Edge');
  });

  it('returns correct inspect URLs', () => {
    assert.strictEqual(
      CHROME_DEFINITION.inspectUrl,
      'chrome://inspect/#remote-debugging',
    );
    const edgeDef = new BrowserDefinition({
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'edge',
      displayName: 'Microsoft Edge',
      urlSchemePrefix: 'edge',
      profileDirPrefix: 'edge',
    });
    assert.strictEqual(edgeDef.inspectUrl, 'edge://inspect/#remote-debugging');
  });

  it('detects chrome extension URLs', () => {
    assert.strictEqual(
      CHROME_DEFINITION.isExtensionUrl('chrome-extension://abcdef/popup.html'),
      true,
    );
  });

  it('detects extension URLs with custom definition', () => {
    const edgeDef = new BrowserDefinition({
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'edge',
      displayName: 'Microsoft Edge',
      urlSchemePrefix: 'edge',
      profileDirPrefix: 'edge',
    });
    assert.strictEqual(
      edgeDef.isExtensionUrl('edge-extension://abcdef/popup.html'),
      true,
    );
  });

  it('rejects non-extension URLs', () => {
    assert.strictEqual(CHROME_DEFINITION.isExtensionUrl('https://example.com'), false);
    assert.strictEqual(CHROME_DEFINITION.isExtensionUrl('chrome://settings'), false);
  });

  it('detects new tab URLs', () => {
    assert.strictEqual(CHROME_DEFINITION.isNewTabUrl('chrome://newtab/'), true);
    assert.strictEqual(CHROME_DEFINITION.isNewTabUrl('https://example.com'), false);
    const edgeDef = new BrowserDefinition({
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'edge',
      displayName: 'Microsoft Edge',
      urlSchemePrefix: 'edge',
      profileDirPrefix: 'edge',
    });
    assert.strictEqual(edgeDef.isNewTabUrl('edge://newtab/'), true);
  });

  it('detects inspect URLs', () => {
    assert.strictEqual(CHROME_DEFINITION.isInspectUrl('chrome://inspect'), true);
    assert.strictEqual(
      CHROME_DEFINITION.isInspectUrl('chrome://inspect/#remote-debugging'),
      true,
    );
    assert.strictEqual(CHROME_DEFINITION.isInspectUrl('https://example.com'), false);
    const edgeDef = new BrowserDefinition({
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'edge',
      displayName: 'Microsoft Edge',
      urlSchemePrefix: 'edge',
      profileDirPrefix: 'edge',
    });
    assert.strictEqual(edgeDef.isInspectUrl('edge://inspect'), true);
  });

  it('derives schemes from urlSchemePrefix', () => {
    const customDef = new BrowserDefinition({
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'custom',
      displayName: 'Custom',
      urlSchemePrefix: 'custom',
      profileDirPrefix: 'custom',
    });
    assert.ok(customDef.extensionSchemes.includes('custom-extension://'));
    assert.ok(customDef.internalSchemes.includes('custom://'));
    assert.ok(customDef.newTabUrls.includes('custom://newtab/'));
  });
});

describe('ensureBrowserConnected with BrowserDefinition', () => {
  it('uses Chrome-specific error message on connection failure', async () => {
    const fakePath = path.join(
      os.tmpdir(),
      `chrome-no-exist-${crypto.randomUUID()}`,
    );
    await fs.promises.mkdir(fakePath, {recursive: true});
    try {
      await ensureBrowserConnected({
        userDataDir: fakePath,
        devtools: false,
        browserDef: CHROME_DEFINITION,
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(
        err.message.includes('Chrome'),
        `Error should mention Chrome: ${err.message}`,
      );
      assert.ok(
        err.message.includes('chrome://inspect'),
        `Error should mention chrome://inspect: ${err.message}`,
      );
    } finally {
      await fs.promises.rm(fakePath, {recursive: true, force: true});
    }
  });

  it('uses custom browser name in error message', async () => {
    const customDef = new BrowserDefinition({
      'chrome-devtools-mcp/browserDefinition/version': '1.0',
      name: 'custom',
      displayName: 'Custom Browser',
      urlSchemePrefix: 'custom',
      profileDirPrefix: 'custom',
    });
    const fakePath = path.join(
      os.tmpdir(),
      `custom-no-exist-${crypto.randomUUID()}`,
    );
    await fs.promises.mkdir(fakePath, {recursive: true});
    try {
      await ensureBrowserConnected({
        userDataDir: fakePath,
        devtools: false,
        browserDef: customDef,
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(
        err.message.includes('Custom Browser'),
        `Error should mention Custom Browser: ${err.message}`,
      );
    } finally {
      await fs.promises.rm(fakePath, {recursive: true, force: true});
    }
  });
});

describe('launch with BrowserDefinition', () => {
  it('uses profileDirPrefix from definition', () => {
    const cases = [
      {prefix: 'chrome', channel: 'stable', expected: 'chrome-profile'},
      {prefix: 'chrome', channel: 'beta', expected: 'chrome-profile-beta'},
      {prefix: 'edge', channel: 'stable', expected: 'edge-profile'},
      {prefix: 'edge', channel: 'beta', expected: 'edge-profile-beta'},
      {prefix: 'edge', channel: 'dev', expected: 'edge-profile-dev'},
      {prefix: 'edge', channel: 'canary', expected: 'edge-profile-canary'},
    ];
    for (const {prefix, channel, expected} of cases) {
      const profileDirName =
        channel && channel !== 'stable'
          ? `${prefix}-profile-${channel}`
          : `${prefix}-profile`;
      assert.strictEqual(profileDirName, expected, `prefix=${prefix} channel=${channel}`);
    }
  });
});
