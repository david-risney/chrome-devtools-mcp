/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BrowserDefinition,
  CHROME_DEFINITION,
  expandEnvVars,
  validateBrowserDefinitionData,
} from './browserDefinition.js';
import {logger} from './logger.js';

/**
 * Recursively expands env vars in all string values within an object.
 */
function expandEnvVarsInObject(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return expandEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(expandEnvVarsInObject);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvVarsInObject(value);
    }
    return result;
  }
  return obj;
}

/**
 * Returns the platform-specific config directory for browser definitions.
 */
export function getBrowserDefinitionConfigDir(): string {
  if (os.platform() === 'win32') {
    const userProfile = process.env['USERPROFILE'] ?? os.homedir();
    return path.join(userProfile, '.chrome-devtools-mcp', 'browsers');
  }
  return path.join(os.homedir(), '.config', 'chrome-devtools-mcp', 'browsers');
}

/**
 * Loads a single browser definition from a JSON file.
 * Expands ${ENV_VAR} placeholders in path strings.
 */
export function loadBrowserDefinitionFromFile(
  filePath: string,
): BrowserDefinition {
  const content = fs.readFileSync(filePath, 'utf8');
  const raw = JSON.parse(content) as Record<string, unknown>;
  const expanded = expandEnvVarsInObject(raw) as Record<string, unknown>;
  const data = validateBrowserDefinitionData(expanded, filePath);
  return new BrowserDefinition(data);
}

/**
 * Loads all browser definitions: the built-in Chrome definition plus any
 * JSON files found in the config directory.
 */
export function loadBrowserDefinitions(): Map<string, BrowserDefinition> {
  const definitions = new Map<string, BrowserDefinition>();
  definitions.set(CHROME_DEFINITION.name, CHROME_DEFINITION);

  const configDir = getBrowserDefinitionConfigDir();
  if (!fs.existsSync(configDir)) {
    return definitions;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(configDir);
  } catch {
    return definitions;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const filePath = path.join(configDir, entry);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        continue;
      }
      const raw = JSON.parse(
        fs.readFileSync(filePath, 'utf8'),
      ) as Record<string, unknown>;
      // Skip files that aren't browser definitions.
      if (!raw['chrome-devtools-mcp/browserDefinition/version']) {
        logger(`Skipping ${filePath}: not a browser definition file.`);
        continue;
      }
      const expanded = expandEnvVarsInObject(raw) as Record<string, unknown>;
      const data = validateBrowserDefinitionData(expanded, filePath);
      const def = new BrowserDefinition(data);
      definitions.set(def.name, def);
    } catch (err) {
      logger(`Failed to load browser definition from ${filePath}:`, err);
    }
  }

  return definitions;
}

/**
 * Detects the system's default browser executable path.
 * Returns the path or undefined if detection fails.
 */
function detectDefaultBrowserExePath(): string | undefined {
  const platform = os.platform();
  try {
    if (platform === 'win32') {
      // Query the default HTTPS handler ProgId, then resolve to exe path.
      const progId = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice" /v ProgId',
        {encoding: 'utf8', timeout: 5000},
      );
      const progIdMatch = progId.match(/ProgId\s+REG_SZ\s+(\S+)/);
      if (!progIdMatch) {
        return undefined;
      }
      const command = execSync(
        `reg query "HKCR\\${progIdMatch[1]}\\shell\\open\\command" /ve`,
        {encoding: 'utf8', timeout: 5000},
      );
      const exeMatch = command.match(/"([^"]+\.exe)"/i);
      return exeMatch ? exeMatch[1] : undefined;
    } else if (platform === 'darwin') {
      // Use 'open -Ra' to find the default HTTPS handler app.
      const appPath = execSync('open -Ra "https://"', {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
      if (!appPath) {
        return undefined;
      }
      // Resolve to the binary inside Contents/MacOS.
      const macosDir = path.join(appPath, 'Contents', 'MacOS');
      if (fs.existsSync(macosDir)) {
        const entries = fs.readdirSync(macosDir);
        if (entries.length > 0) {
          return path.join(macosDir, entries[0]);
        }
      }
      return undefined;
    } else {
      // Linux: use xdg-settings to get the default .desktop file, then parse Exec=.
      const desktop = execSync('xdg-settings get default-web-browser', {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
      if (!desktop) {
        return undefined;
      }
      // Try to find the .desktop file and parse Exec line.
      const desktopDirs = [
        '/usr/share/applications',
        '/usr/local/share/applications',
        path.join(os.homedir(), '.local', 'share', 'applications'),
      ];
      for (const dir of desktopDirs) {
        const desktopFile = path.join(dir, desktop);
        if (fs.existsSync(desktopFile)) {
          const content = fs.readFileSync(desktopFile, 'utf8');
          const execMatch = content.match(/^Exec=(\S+)/m);
          if (execMatch) {
            return execMatch[1];
          }
        }
      }
      return undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * Normalizes a file path for comparison: resolves to absolute, lowercases on Windows.
 */
function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return os.platform() === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Matches a detected executable path against all loaded browser definitions.
 * Returns the matching definition, or undefined if no match.
 */
function matchExeToDefinition(
  exePath: string,
  definitions: Map<string, BrowserDefinition>,
): BrowserDefinition | undefined {
  const normalizedExe = normalizePath(exePath);
  const platform = os.platform();
  for (const def of definitions.values()) {
    const platformPaths = def.executablePaths?.[platform];
    if (!platformPaths) {
      continue;
    }
    for (const channelPaths of Object.values(platformPaths)) {
      if (!channelPaths) {
        continue;
      }
      for (const candidate of channelPaths) {
        const expanded = expandEnvVars(candidate);
        if (expanded && normalizePath(expanded) === normalizedExe) {
          return def;
        }
      }
    }
  }
  return undefined;
}

/**
 * Resolves the --browser argument to a BrowserDefinition.
 *
 * - "chrome" → built-in Chrome definition
 * - "default" → detect system default browser, match against loaded definitions, fall back to Chrome
 * - A name matching a loaded definition → that definition
 * - A file path ending in .json → load definition from file
 */
export function resolveBrowserArg(
  browserArg: string,
  definitions: Map<string, BrowserDefinition>,
): BrowserDefinition {
  if (browserArg === 'default') {
    const exePath = detectDefaultBrowserExePath();
    if (exePath) {
      const match = matchExeToDefinition(exePath, definitions);
      if (match) {
        return match;
      }
    }
    // Fall back to Chrome.
    return definitions.get('chrome') ?? CHROME_DEFINITION;
  }

  // Look up by name in loaded definitions.
  const byName = definitions.get(browserArg);
  if (byName) {
    return byName;
  }

  // Try as a file path to a JSON definition.
  if (browserArg.endsWith('.json')) {
    return loadBrowserDefinitionFromFile(browserArg);
  }

  throw new Error(
    `Unknown browser "${browserArg}". Available browsers: ${[...definitions.keys()].join(', ')}. ` +
      `You can also specify a path to a browser definition JSON file.`,
  );
}
