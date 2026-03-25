/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {Channel} from './browserDefinition.js';
import {
  type BrowserDefinition,
  CHROME_DEFINITION,
} from './browserDefinition.js';
import {logger} from './logger.js';
import type {
  Browser,
  ChromeReleaseChannel,
  LaunchOptions,
  Target,
} from './third_party/index.js';
import {puppeteer} from './third_party/index.js';

let browser: Browser | undefined;

function makeTargetFilter(
  def: BrowserDefinition = CHROME_DEFINITION,
  enableExtensions = false,
) {
  const ignoredPrefixes = new Set(def.internalSchemes);
  if (!enableExtensions) {
    for (const scheme of def.extensionSchemes) {
      ignoredPrefixes.add(scheme);
    }
  }

  return function targetFilter(target: Target): boolean {
    if (def.isNewTabUrl(target.url())) {
      return true;
    }
    // Could be the only page opened in the browser.
    if (def.isInspectUrl(target.url())) {
      return true;
    }
    for (const prefix of ignoredPrefixes) {
      if (target.url().startsWith(prefix)) {
        return false;
      }
    }
    return true;
  };
}

export async function ensureBrowserConnected(options: {
  browserURL?: string;
  wsEndpoint?: string;
  wsHeaders?: Record<string, string>;
  devtools: boolean;
  channel?: Channel;
  browserDef?: BrowserDefinition;
  userDataDir?: string;
  enableExtensions?: boolean;
}) {
  const {channel, enableExtensions, browserDef = CHROME_DEFINITION} = options;
  if (browser?.connected) {
    return browser;
  }

  const connectOptions: Parameters<typeof puppeteer.connect>[0] = {
    targetFilter: makeTargetFilter(browserDef, enableExtensions),
    defaultViewport: null,
    handleDevToolsAsPage: true,
  };

  let autoConnect = false;
  if (options.wsEndpoint) {
    connectOptions.browserWSEndpoint = options.wsEndpoint;
    if (options.wsHeaders) {
      connectOptions.headers = options.wsHeaders;
    }
  } else if (options.browserURL) {
    connectOptions.browserURL = options.browserURL;
  } else if (channel || options.userDataDir) {
    let userDataDir = options.userDataDir;
    // Resolve the browser's default user data dir for auto-connect
    // when the definition provides userDataDirs.
    if (!userDataDir && browserDef.userDataDirs && channel) {
      userDataDir = browserDef.resolveUserDataDir(channel);
    }
    if (userDataDir) {
      autoConnect = true;
      // TODO: re-expose this logic via Puppeteer.
      const portPath = path.join(userDataDir, 'DevToolsActivePort');
      try {
        const fileContent = await fs.promises.readFile(portPath, 'utf8');
        const [rawPort, rawPath] = fileContent
          .split('\n')
          .map(line => {
            return line.trim();
          })
          .filter(line => {
            return !!line;
          });
        if (!rawPort || !rawPath) {
          throw new Error(`Invalid DevToolsActivePort '${fileContent}' found`);
        }
        const port = parseInt(rawPort, 10);
        if (isNaN(port) || port <= 0 || port > 65535) {
          throw new Error(`Invalid port '${rawPort}' found`);
        }
        const browserWSEndpoint = `ws://127.0.0.1:${port}${rawPath}`;
        connectOptions.browserWSEndpoint = browserWSEndpoint;
      } catch (error) {
        throw new Error(
          `Could not connect to ${browserDef.displayName} in ${userDataDir}. Check if ${browserDef.displayName} is running and remote debugging is enabled by going to ${browserDef.inspectUrl}.`,
          {
            cause: error,
          },
        );
      }
    } else {
      if (!channel) {
        throw new Error('Channel must be provided if userDataDir is missing');
      }
      connectOptions.channel = (
        channel === 'stable' ? 'chrome' : `chrome-${channel}`
      ) as ChromeReleaseChannel;
    }
  } else {
    throw new Error(
      'Either browserURL, wsEndpoint, channel or userDataDir must be provided',
    );
  }

  logger('Connecting Puppeteer to ', JSON.stringify(connectOptions));
  try {
    browser = await puppeteer.connect(connectOptions);
  } catch (err) {
    throw new Error(
      `Could not connect to ${browserDef.displayName}. ${autoConnect ? `Check if ${browserDef.displayName} is running and remote debugging is enabled by going to ${browserDef.inspectUrl}.` : `Check if ${browserDef.displayName} is running.`}`,
      {
        cause: err,
      },
    );
  }
  logger('Connected Puppeteer');
  return browser;
}

interface McpLaunchOptions {
  acceptInsecureCerts?: boolean;
  executablePath?: string;
  channel?: Channel;
  browserDef?: BrowserDefinition;
  userDataDir?: string;
  headless: boolean;
  isolated: boolean;
  logFile?: fs.WriteStream;
  viewport?: {
    width: number;
    height: number;
  };
  chromeArgs?: string[];
  ignoreDefaultChromeArgs?: string[];
  devtools: boolean;
  enableExtensions?: boolean;
  viaCli?: boolean;
}

export function detectDisplay(): void {
  // Only detect display on Linux/UNIX.
  if (os.platform() === 'win32' || os.platform() === 'darwin') {
    return;
  }
  if (!process.env['DISPLAY']) {
    try {
      const result = execSync(
        `ps -u $(id -u) -o pid= | xargs -I{} cat /proc/{}/environ 2>/dev/null | tr '\\0' '\\n' | grep -m1 '^DISPLAY=' | cut -d= -f2`,
      );
      const display = result.toString('utf8').trim();
      process.env['DISPLAY'] = display;
    } catch {
      // no-op
    }
  }
}

export async function launch(options: McpLaunchOptions): Promise<Browser> {
  const {
    channel,
    executablePath,
    headless,
    isolated,
    browserDef = CHROME_DEFINITION,
  } = options;
  const profileDirName =
    channel && channel !== 'stable'
      ? `${browserDef.profileDirPrefix}-profile-${channel}`
      : `${browserDef.profileDirPrefix}-profile`;

  let userDataDir = options.userDataDir;
  if (!isolated && !userDataDir) {
    userDataDir = path.join(
      os.homedir(),
      '.cache',
      options.viaCli ? 'chrome-devtools-mcp-cli' : 'chrome-devtools-mcp',
      profileDirName,
    );
    await fs.promises.mkdir(userDataDir, {
      recursive: true,
    });
  }

  const args: LaunchOptions['args'] = [
    ...(options.chromeArgs ?? []),
    '--hide-crash-restore-bubble',
  ];
  const ignoreDefaultArgs: LaunchOptions['ignoreDefaultArgs'] =
    options.ignoreDefaultChromeArgs ?? false;

  if (headless) {
    args.push('--screen-info={3840x2160}');
  }
  let puppeteerChannel: ChromeReleaseChannel | undefined;
  if (options.devtools) {
    args.push('--auto-open-devtools-for-tabs');
  }
  let resolvedExecutablePath = executablePath;
  if (!resolvedExecutablePath) {
    if (browserDef.executablePaths) {
      // The definition provides executable paths — resolve from those.
      const resolvedChannel = channel ?? 'stable';
      resolvedExecutablePath = browserDef.resolveExecutablePath(resolvedChannel);
      if (!resolvedExecutablePath) {
        const channelName =
          resolvedChannel === 'stable'
            ? browserDef.displayName
            : `${browserDef.displayName} ${resolvedChannel[0].toUpperCase() + resolvedChannel.slice(1)}`;
        throw new Error(
          `Could not find ${channelName} executable. ` +
            `Install ${channelName} or use --executablePath to specify the path manually.`,
        );
      }
    } else {
      // Default: let Puppeteer resolve via channel name (Chrome).
      puppeteerChannel =
        channel && channel !== 'stable'
          ? (`chrome-${channel}` as ChromeReleaseChannel)
          : 'chrome';
    }
  }

  if (!headless) {
    detectDisplay();
  }

  try {
    const browser = await puppeteer.launch({
      channel: puppeteerChannel,
      targetFilter: makeTargetFilter(browserDef, options.enableExtensions),
      executablePath: resolvedExecutablePath,
      defaultViewport: null,
      userDataDir,
      pipe: true,
      headless,
      args,
      ignoreDefaultArgs: ignoreDefaultArgs,
      acceptInsecureCerts: options.acceptInsecureCerts,
      handleDevToolsAsPage: true,
      enableExtensions: options.enableExtensions,
    });
    if (options.logFile) {
      // FIXME: we are probably subscribing too late to catch startup logs. We
      // should expose the process earlier or expose the getRecentLogs() getter.
      browser.process()?.stderr?.pipe(options.logFile);
      browser.process()?.stdout?.pipe(options.logFile);
    }
    if (options.viewport) {
      const [page] = await browser.pages();
      await page?.resize({
        contentWidth: options.viewport.width,
        contentHeight: options.viewport.height,
      });
    }
    return browser;
  } catch (error) {
    if (
      userDataDir &&
      (error as Error).message.includes('The browser is already running')
    ) {
      throw new Error(
        `The browser is already running for ${userDataDir}. Use --isolated to run multiple browser instances.`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

export async function ensureBrowserLaunched(
  options: McpLaunchOptions,
): Promise<Browser> {
  if (browser?.connected) {
    return browser;
  }
  browser = await launch(options);
  return browser;
}

export type {Channel, BrowserDefinitionData} from './browserDefinition.js';
export {
  BrowserDefinition,
  CHROME_DEFINITION,
} from './browserDefinition.js';
export {
  loadBrowserDefinitions,
  resolveBrowserArg,
} from './browserDefinitionLoader.js';
