/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
 * Resolves the --browser argument to a BrowserDefinition.
 *
 * - "chrome" or "default" → built-in Chrome definition
 * - A name matching a loaded definition → that definition
 * - A file path ending in .json → load definition from file
 */
export function resolveBrowserArg(
  browserArg: string,
  definitions: Map<string, BrowserDefinition>,
): BrowserDefinition {
  if (browserArg === 'default') {
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
