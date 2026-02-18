import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../logger.js';
import type { LSPServerConfig } from '../../types.js';
import type { InitializeParams, ServerAdapter } from './types.js';

const VENV_DIRS = ['.venv', 'venv'];
const PYTHON_REL_PATH = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';

/**
 * Adapter for Pyright Language Server.
 *
 * Pyright and basedpyright can be slow on large Python projects.
 * This adapter extends timeouts for operations that may take longer
 * and auto-detects virtual environments for correct import resolution.
 */
export class PyrightAdapter implements ServerAdapter {
  readonly name = 'pyright';

  matches(config: LSPServerConfig): boolean {
    return config.command.some((c: string) => c.includes('pyright') || c.includes('basedpyright'));
  }

  customizeInitializeParams(params: InitializeParams): InitializeParams {
    // Pyright works better with specific workspace configuration
    // Preserve any existing initializationOptions from config
    const existingOptions =
      typeof params.initializationOptions === 'object' && params.initializationOptions !== null
        ? params.initializationOptions
        : {};

    return {
      ...params,
      initializationOptions: {
        ...existingOptions,
        // Pyright-specific options can be added here if needed
      },
    };
  }

  getTimeout(method: string): number | undefined {
    // Pyright can be slow on large projects
    // Extend timeouts for operations that may analyze many files
    const timeouts: Record<string, number> = {
      'textDocument/definition': 45000, // 45 seconds
      'textDocument/references': 60000, // 60 seconds
      'textDocument/rename': 60000, // 60 seconds
      'textDocument/documentSymbol': 45000, // 45 seconds
      'workspace/symbol': 60000, // 60 seconds
    };
    return timeouts[method];
  }

  getWorkspaceSettings(config: LSPServerConfig): Record<string, unknown> | undefined {
    const rootDir = config.rootDir || process.cwd();
    const pythonPath = this.detectVenvPython(rootDir);

    if (!pythonPath) {
      return undefined;
    }

    logger.info('PyrightAdapter', `Detected venv python: ${pythonPath}`);

    return {
      python: {
        pythonPath,
      },
    };
  }

  private detectVenvPython(rootDir: string): string | undefined {
    for (const dir of VENV_DIRS) {
      const candidate = join(rootDir, dir, PYTHON_REL_PATH);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }
}
