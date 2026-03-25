/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';

export type Channel = 'stable' | 'canary' | 'beta' | 'dev';

/**
 * Expands `${ENV_VAR}` placeholders in a string with process.env values.
 */
export function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    return process.env[varName] ?? '';
  });
}

/**
 * JSON-serializable data describing a browser. External browser definitions
 * are loaded from JSON files with the identifying property
 * `"chrome-devtools-mcp/browserDefinition/version"` set to `"1.0"`.
 */
export interface BrowserDefinitionData {
  'chrome-devtools-mcp/browserDefinition/version': string;
  /** Short identifier used as the --browser value (e.g. "chrome", "edge"). */
  name: string;
  /** Human-readable name shown in error messages (e.g. "Chrome", "Microsoft Edge"). */
  displayName: string;
  /**
   * Prefix that replaces "chrome" when deriving URL schemes.
   * For example, if urlSchemePrefix is "edge", then "chrome-extension://"
   * maps to "edge-extension://", "chrome://" maps to "edge://", etc.
   * When urlSchemes is explicitly provided, those take precedence.
   */
  urlSchemePrefix: string;
  /**
   * Explicit URL schemes for this browser. If omitted, schemes are derived
   * from urlSchemePrefix by replacing "chrome" in the default Chrome schemes.
   */
  urlSchemes?: {
    internal?: string[];
    extension?: string[];
    newTab?: string[];
    inspect?: string[];
  };
  /**
   * Prefix for the profile directory name (e.g. "chrome" → "chrome-profile",
   * "edge" → "edge-profile-beta").
   */
  profileDirPrefix: string;
  /**
   * Per-platform executable paths, keyed by os.platform() value.
   * Each channel maps to an array of candidate paths to try.
   * Paths may contain ${ENV_VAR} placeholders for environment variable expansion.
   */
  executablePaths?: Record<string, Partial<Record<Channel, string[]>>>;
  /**
   * Per-platform user data directories, keyed by os.platform() value.
   * Each channel maps to a single directory path.
   * Paths may contain ${ENV_VAR} placeholders for environment variable expansion.
   */
  userDataDirs?: Record<string, Partial<Record<Channel, string>>>;
  /**
   * Per-platform list of channels that are not supported.
   * For example, { "linux": ["canary"] } means canary is not available on Linux.
   */
  unsupportedChannels?: Record<string, Channel[]>;
}

/**
 * The built-in Chrome definition data.
 */
const CHROME_DATA: BrowserDefinitionData = {
  'chrome-devtools-mcp/browserDefinition/version': '1.0',
  name: 'chrome',
  displayName: 'Chrome',
  urlSchemePrefix: 'chrome',
  urlSchemes: {
    internal: ['chrome://', 'chrome-untrusted://'],
    extension: ['chrome-extension://'],
    newTab: ['chrome://newtab/'],
    inspect: ['chrome://inspect'],
  },
  profileDirPrefix: 'chrome',
};

/**
 * Wrapper class around BrowserDefinitionData that provides methods for
 * URL scheme matching, name resolution, and other browser-specific logic.
 * This is the type passed around throughout the codebase.
 */
export class BrowserDefinition {
  readonly data: BrowserDefinitionData;
  readonly internalSchemes: string[];
  readonly extensionSchemes: string[];
  readonly newTabUrls: string[];
  readonly inspectPrefixes: string[];

  constructor(data: BrowserDefinitionData) {
    this.data = data;
    this.internalSchemes = resolveSchemes(data, 'internal');
    this.extensionSchemes = resolveSchemes(data, 'extension');
    this.newTabUrls = resolveSchemes(data, 'newTab');
    this.inspectPrefixes = resolveSchemes(data, 'inspect');
  }

  get name(): string {
    return this.data.name;
  }

  get displayName(): string {
    return this.data.displayName;
  }

  get profileDirPrefix(): string {
    return this.data.profileDirPrefix;
  }

  get executablePaths(): BrowserDefinitionData['executablePaths'] {
    return this.data.executablePaths;
  }

  get userDataDirs(): BrowserDefinitionData['userDataDirs'] {
    return this.data.userDataDirs;
  }

  get unsupportedChannels(): BrowserDefinitionData['unsupportedChannels'] {
    return this.data.unsupportedChannels;
  }

  get inspectUrl(): string {
    return this.inspectPrefixes.length > 0
      ? `${this.inspectPrefixes[0]}/#remote-debugging`
      : 'chrome://inspect/#remote-debugging';
  }

  isExtensionUrl(url: string): boolean {
    return this.extensionSchemes.some(scheme => url.startsWith(scheme));
  }

  isNewTabUrl(url: string): boolean {
    return this.newTabUrls.some(tabUrl => url === tabUrl);
  }

  isInspectUrl(url: string): boolean {
    return this.inspectPrefixes.some(prefix => url.startsWith(prefix));
  }

  /**
   * Resolves the executable path for the given channel on the current platform.
   * Returns undefined if no executable is found (caller should fall back to Puppeteer).
   */
  resolveExecutablePath(channel: Channel): string | undefined {
    const platform = os.platform();
    const paths = this.executablePaths?.[platform]?.[channel];
    if (!paths || paths.length === 0) {
      return undefined;
    }
    for (const candidate of paths) {
      const expanded = expandEnvVars(candidate);
      if (expanded && fs.existsSync(expanded)) {
        return expanded;
      }
    }
    return undefined;
  }

  /**
   * Resolves the user data directory for the given channel on the current platform.
   */
  resolveUserDataDir(channel: Channel): string | undefined {
    const platform = os.platform();
    const dir = this.userDataDirs?.[platform]?.[channel];
    if (!dir) {
      return undefined;
    }
    return expandEnvVars(dir);
  }

  /**
   * Checks if the given channel is supported on the current platform.
   */
  isChannelSupported(channel: Channel): boolean {
    const platform = os.platform();
    const unsupported = this.unsupportedChannels?.[platform];
    if (unsupported && unsupported.includes(channel)) {
      return false;
    }
    return true;
  }
}

/**
 * The built-in Chrome definition instance.
 */
export const CHROME_DEFINITION = new BrowserDefinition(CHROME_DATA);

// --- Internal helpers ---

function resolveSchemes(
  data: BrowserDefinitionData,
  key: keyof NonNullable<BrowserDefinitionData['urlSchemes']>,
): string[] {
  if (data.urlSchemes?.[key]) {
    return data.urlSchemes[key];
  }
  // Derive from Chrome defaults by replacing "chrome" with the definition's prefix.
  const chromeSchemes = CHROME_DATA.urlSchemes![key]!;
  return chromeSchemes.map(s => s.replace(/chrome/g, data.urlSchemePrefix));
}

/**
 * Validates that a JSON object is valid BrowserDefinitionData.
 * Returns the parsed data or throws with a descriptive error.
 */
export function validateBrowserDefinitionData(
  obj: Record<string, unknown>,
  sourcePath?: string,
): BrowserDefinitionData {
  const prefix = sourcePath ? `In ${sourcePath}: ` : '';
  const version = obj['chrome-devtools-mcp/browserDefinition/version'];
  if (typeof version !== 'string') {
    throw new Error(
      `${prefix}Missing or invalid "chrome-devtools-mcp/browserDefinition/version" property.`,
    );
  }
  if (version !== '1.0') {
    throw new Error(
      `${prefix}Unsupported browser definition version "${version}". Expected "1.0".`,
    );
  }
  for (const field of [
    'name',
    'displayName',
    'urlSchemePrefix',
    'profileDirPrefix',
  ] as const) {
    if (typeof obj[field] !== 'string' || !(obj[field] as string).length) {
      throw new Error(`${prefix}Missing or invalid "${field}" property.`);
    }
  }
  return obj as unknown as BrowserDefinitionData;
}
