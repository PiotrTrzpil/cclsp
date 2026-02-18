import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { constants, access, readFile } from 'node:fs/promises';
import { dirname, join, normalize, relative } from 'node:path';
import { applyWorkspaceEdit } from './file-editor.js';
import { loadGitignore, scanDirectoryForExtensions } from './file-scanner.js';
import { logger } from './logger.js';
import { adapterRegistry } from './lsp/adapters/registry.js';
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  Config,
  Diagnostic,
  DocumentDiagnosticReport,
  DocumentSymbol,
  LSPError,
  LSPLocation,
  LSPServerConfig,
  Location,
  Position,
  SymbolInformation,
  SymbolMatch,
} from './types.js';
import { SymbolKind } from './types.js';
import { pathToUri, uriToPath } from './utils.js';

/** Check if a JSON-RPC message has an id (handles id=0 correctly) */
export function hasId(message: { id?: number | null }): boolean {
  return message.id !== undefined && message.id !== null;
}

interface LSPMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: LSPError;
}

interface ServerState {
  process: ChildProcess;
  initialized: boolean;
  initializationPromise: Promise<void>;
  openFiles: Set<string>;
  fileVersions: Map<string, number>; // Track file versions for didChange notifications
  startTime: number;
  config: LSPServerConfig;
  restartTimer?: NodeJS.Timeout;
  initializationResolve?: () => void;
  diagnostics: Map<string, Diagnostic[]>; // Store diagnostics by file URI
  lastDiagnosticUpdate: Map<string, number>; // Track last update time per file
  diagnosticVersions: Map<string, number>; // Track diagnostic versions per file
  symbolCache: Map<string, { version: number; symbols: DocumentSymbol[] | SymbolInformation[] }>; // Cache document symbols per file
  adapter?: import('./lsp/adapters/types.js').ServerAdapter; // Optional adapter for server-specific behavior
  serverCapabilities?: Record<string, unknown>; // Server capabilities from initialize response
  dead?: boolean; // Set when the server process exits or errors unexpectedly
  progressTokens: Set<string | number>; // Active work-done progress tokens (e.g., indexing)
  indexingWaiters: Array<() => void>; // Callbacks waiting for indexing to complete
  readyPromise: Promise<void>; // Resolves when server responds to first real request (readiness probe)
}

/**
 * Default timeouts for LSP methods that are known to be slower.
 * Adapters can override these with their own values.
 */
const DEFAULT_METHOD_TIMEOUTS: Record<string, number> = {
  'textDocument/documentSymbol': 45000,
  'textDocument/references': 45000,
  'textDocument/rename': 45000,
  'textDocument/prepareRename': 45000,
  'workspace/willRenameFiles': 45000,
  'workspace/symbol': 45000,
};

const DEFAULT_TIMEOUT = 30000;

export class LSPClient {
  private config: Config;
  private servers: Map<string, ServerState> = new Map();
  private serversStarting: Map<string, Promise<ServerState>> = new Map();
  private nextId = 1;
  private pendingRequests: Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
      pid?: number; // PID of the server process this request was sent to
    }
  > = new Map();

  private isPylspServer(serverConfig: LSPServerConfig): boolean {
    return serverConfig.command.some((cmd) => cmd.includes('pylsp'));
  }

  /**
   * Walk up from a file path to find the nearest project root.
   * Looks for common project markers like .git, pyproject.toml, package.json, etc.
   */
  private detectProjectRoot(filePath: string): string | undefined {
    const markers = ['.git', 'pyproject.toml', 'setup.py', 'package.json', 'go.mod', 'Cargo.toml'];
    let dir = dirname(filePath);
    const root = dirname(dir) === dir ? dir : '/'; // filesystem root

    while (dir !== root && dir !== dirname(dir)) {
      for (const marker of markers) {
        if (existsSync(join(dir, marker))) {
          return dir;
        }
      }
      dir = dirname(dir);
    }
    return undefined;
  }

  constructor(configPath?: string) {
    // First try to load from environment variable (MCP config)
    if (process.env.CCLSP_CONFIG_PATH) {
      logger.info('config', `Loading from CCLSP_CONFIG_PATH: ${process.env.CCLSP_CONFIG_PATH}`);

      if (!existsSync(process.env.CCLSP_CONFIG_PATH)) {
        logger.error(
          'config',
          `Config file specified in CCLSP_CONFIG_PATH does not exist: ${process.env.CCLSP_CONFIG_PATH}`
        );
        process.exit(1);
      }

      try {
        const configData = readFileSync(process.env.CCLSP_CONFIG_PATH, 'utf-8');
        this.config = JSON.parse(configData);
        logger.info(
          'config',
          `Loaded ${this.config.servers.length} server configurations from env`
        );
        return;
      } catch (error) {
        logger.error('config', `Failed to load from CCLSP_CONFIG_PATH: ${error}`);
        process.exit(1);
      }
    }

    // configPath must be provided if CCLSP_CONFIG_PATH is not set
    if (!configPath) {
      logger.error(
        'config',
        'configPath is required when CCLSP_CONFIG_PATH environment variable is not set'
      );
      process.exit(1);
    }

    // Try to load from config file
    try {
      logger.info('config', `Loading from file: ${configPath}`);
      const configData = readFileSync(configPath, 'utf-8');
      this.config = JSON.parse(configData);
      logger.info('config', `Loaded ${this.config.servers.length} server configurations`);
    } catch (error) {
      logger.error('config', `Failed to load from ${configPath}: ${error}`);
      process.exit(1);
    }
  }

  private getServerForFile(filePath: string): LSPServerConfig | null {
    const extension = filePath.split('.').pop();
    if (!extension) return null;

    logger.debug('getServerForFile', `Looking for server for extension: ${extension}`);
    logger.debug(
      'getServerForFile',
      `Available servers: ${this.config.servers.map((s) => s.extensions.join(',')).join(' | ')}`
    );

    // Find all servers that support this extension
    const matchingServers = this.config.servers.filter((server) =>
      server.extensions.includes(extension)
    );

    if (matchingServers.length === 0) {
      logger.debug('getServerForFile', `No server found for extension: ${extension}`);
      return null;
    }

    // If only one server matches, use it
    if (matchingServers.length === 1) {
      const server = matchingServers[0];
      if (server) {
        logger.debug(
          'getServerForFile',
          `Found server for ${extension}: ${server.command.join(' ')}`
        );
      }
      return server || null;
    }

    // Multiple servers match - pick the one with most specific rootDir
    // Check if filePath is already absolute (Unix: /, Windows: C:\ or UNC paths)
    const isAbsolutePath =
      filePath.startsWith('/') || filePath.startsWith('\\') || /^[a-zA-Z]:/.test(filePath);
    const absoluteFilePath = normalize(isAbsolutePath ? filePath : join(process.cwd(), filePath));
    let bestMatch: LSPServerConfig | null = null;
    let longestRootLength = -1;

    for (const server of matchingServers) {
      // Normalize rootDir to use platform-specific separators
      // rootDir might be stored with '/' separators even on Windows
      const normalizedServerRoot = server.rootDir ? normalize(server.rootDir) : '.';
      const isAbsolute =
        normalizedServerRoot.startsWith('/') || /^[a-zA-Z]:/.test(normalizedServerRoot);
      const rootDir = normalize(
        isAbsolute ? normalizedServerRoot : join(process.cwd(), normalizedServerRoot)
      );

      const rel = relative(rootDir, absoluteFilePath);

      // File is inside rootDir if relative path doesn't escape with '..'
      // Works on both Unix and Windows (normalize handles path separators)
      if (!rel.startsWith('..')) {
        if (rootDir.length > longestRootLength) {
          longestRootLength = rootDir.length;
          bestMatch = server;
        }
      }
    }

    // Fallback to first match if no rootDir contains the file
    const server = bestMatch || matchingServers[0];

    if (server) {
      logger.debug(
        'getServerForFile',
        `Found server for ${extension}: ${server.command.join(' ')} (rootDir: ${server.rootDir || '.'})`
      );
    }

    return server || null;
  }

  private async startServer(serverConfig: LSPServerConfig): Promise<ServerState> {
    const [command, ...args] = serverConfig.command;
    if (!command) {
      throw new Error('No command specified in server config');
    }
    const childProcess = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: serverConfig.rootDir || process.cwd(),
    });

    let initializationResolve: (() => void) | undefined;
    const initializationPromise = new Promise<void>((resolve) => {
      initializationResolve = resolve;
    });

    // Auto-detect adapter for this server
    const adapter = adapterRegistry.getAdapter(serverConfig);
    if (adapter) {
      logger.info(
        'startServer',
        `Using adapter "${adapter.name}" for server: ${serverConfig.command.join(' ')}`
      );
    }

    const serverState: ServerState = {
      process: childProcess,
      initialized: false,
      initializationPromise,
      openFiles: new Set(),
      fileVersions: new Map(),
      startTime: Date.now(),
      config: serverConfig,
      restartTimer: undefined,
      diagnostics: new Map(),
      lastDiagnosticUpdate: new Map(),
      diagnosticVersions: new Map(),
      symbolCache: new Map(),
      adapter, // Store adapter for later use
      progressTokens: new Set(),
      indexingWaiters: [],
      readyPromise: Promise.resolve(),
    };

    // Store the resolve function to call when initialized notification is received
    serverState.initializationResolve = initializationResolve;

    let buffer = Buffer.alloc(0);
    const HEADER_SEPARATOR = Buffer.from('\r\n\r\n');

    childProcess.stdout?.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);

      while (true) {
        const headerEndIndex = buffer.indexOf(HEADER_SEPARATOR);
        if (headerEndIndex === -1) break;

        const headerPart = buffer.subarray(0, headerEndIndex).toString('ascii');
        const contentLengthMatch = headerPart.match(/Content-Length: (\d+)/);

        if (contentLengthMatch?.[1]) {
          const contentLength = Number.parseInt(contentLengthMatch[1]);
          const messageStart = headerEndIndex + 4;

          if (buffer.length >= messageStart + contentLength) {
            const messageContent = buffer
              .subarray(messageStart, messageStart + contentLength)
              .toString('utf-8');
            buffer = buffer.subarray(messageStart + contentLength);

            try {
              const message: LSPMessage = JSON.parse(messageContent);
              this.handleMessage(message, serverState);
            } catch (error) {
              logger.warn('startServer', `Failed to parse LSP message: ${error}`);
            }
          } else {
            break;
          }
        } else {
          buffer = buffer.subarray(headerEndIndex + 4);
        }
      }
    });

    childProcess.stderr?.on('data', (data: Buffer) => {
      // Forward LSP server stderr to logger
      logger.debug('lsp-stderr', data.toString().trimEnd());
    });

    // Handle unexpected server death — fail-fast all pending requests instead of
    // letting them sit until their 30s+ timeout expires
    const onServerDeath = (reason: string) => {
      if (serverState.dead) return;
      serverState.dead = true;

      const cmd = serverConfig.command.join(' ');
      logger.error('onServerDeath', `Server died (${cmd}): ${reason}`);

      // Clear restart timer
      if (serverState.restartTimer) {
        clearTimeout(serverState.restartTimer);
        serverState.restartTimer = undefined;
      }

      // Notify indexing waiters so they don't hang forever
      const waiters = serverState.indexingWaiters.splice(0);
      for (const waiter of waiters) waiter();

      // Remove from servers map so getServer will start a fresh instance
      const key = JSON.stringify(serverConfig);
      this.servers.delete(key);

      // Fail-fast all pending requests sent to this server's process instead of
      // letting them wait for their full 30s+ timeout
      const deadPid = childProcess.pid;
      if (deadPid) {
        const deadError = new Error(`LSP server died: ${reason}`);
        for (const [id, entry] of this.pendingRequests.entries()) {
          if (entry.pid === deadPid) {
            this.pendingRequests.delete(id);
            entry.reject(deadError);
          }
        }
      }
    };

    childProcess.on('exit', (code, signal) => {
      onServerDeath(`exit code=${code}, signal=${signal}`);
    });

    childProcess.on('error', (error) => {
      onServerDeath(`error: ${error.message}`);
    });

    // Initialize the server
    const initializeParams: {
      processId: number | null;
      clientInfo: { name: string; version: string };
      capabilities: unknown;
      rootUri: string;
      workspaceFolders: Array<{ uri: string; name: string }>;
      initializationOptions?: unknown;
    } = {
      processId: childProcess.pid || null,
      clientInfo: { name: 'cclsp', version: '0.1.0' },
      capabilities: {
        textDocument: {
          synchronization: {
            didOpen: true,
            didChange: true,
            didClose: true,
          },
          definition: { linkSupport: false },
          references: {
            includeDeclaration: true,
            dynamicRegistration: false,
          },
          rename: { prepareSupport: false },
          documentSymbol: {
            symbolKind: {
              valueSet: [
                1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
                24, 25, 26,
              ],
            },
            hierarchicalDocumentSymbolSupport: true,
          },
          completion: {
            completionItem: {
              snippetSupport: true,
            },
          },
          hover: {},
          signatureHelp: {},
          diagnostic: {
            dynamicRegistration: false,
            relatedDocumentSupport: false,
          },
        },
        workspace: {
          workspaceEdit: {
            documentChanges: true,
          },
          workspaceFolders: true,
          fileOperations: {
            willRename: true,
            didRename: true,
          },
          symbol: {
            symbolKind: {
              valueSet: [
                1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
                24, 25, 26,
              ],
            },
          },
          configuration: true,
        },
        window: {
          workDoneProgress: true,
        },
      },
      rootUri: pathToUri(serverConfig.rootDir || process.cwd()),
      workspaceFolders: [
        {
          uri: pathToUri(serverConfig.rootDir || process.cwd()),
          name: 'workspace',
        },
      ],
    };

    // Handle initializationOptions with backwards compatibility for pylsp
    if (serverConfig.initializationOptions !== undefined) {
      initializeParams.initializationOptions = serverConfig.initializationOptions;
    } else if (this.isPylspServer(serverConfig)) {
      // Backwards compatibility: provide default pylsp settings when none are specified
      initializeParams.initializationOptions = {
        settings: {
          pylsp: {
            plugins: {
              jedi_completion: { enabled: true },
              jedi_definition: { enabled: true },
              jedi_hover: { enabled: true },
              jedi_references: { enabled: true },
              jedi_signature_help: { enabled: true },
              jedi_symbols: { enabled: true },
              pylint: { enabled: false },
              pycodestyle: { enabled: false },
              pyflakes: { enabled: false },
              yapf: { enabled: false },
              rope_completion: { enabled: false },
            },
          },
        },
      };
    }

    const initResult = (await this.sendRequest(childProcess, 'initialize', initializeParams)) as {
      capabilities?: Record<string, unknown>;
    } | null;

    // Store server capabilities for feature detection (e.g., fileOperations.willRename)
    serverState.serverCapabilities = (initResult?.capabilities as Record<string, unknown>) ?? {};

    // Send the initialized notification after receiving the initialize response
    // Per LSP spec, the server is ready after client sends initialized notification
    await this.sendNotification(childProcess, 'initialized', {});

    // Trigger workspace initialization in servers that require it.
    // Pyright won't initialize workspace folders until it receives this notification,
    // even though folders were provided in the initialize request.
    // See: https://github.com/microsoft/pyright/issues/6874
    const adapterSettings = serverState.adapter?.getWorkspaceSettings?.(serverConfig);
    this.sendNotification(childProcess, 'workspace/didChangeConfiguration', {
      settings: adapterSettings ?? {},
    });

    // Mark server as initialized - no response expected from initialized notification
    serverState.initialized = true;
    if (serverState.initializationResolve) {
      serverState.initializationResolve();
      serverState.initializationResolve = undefined;
    }

    // Set up auto-restart timer if configured
    this.setupRestartTimer(serverState);

    // Fire background readiness probe — resolves when the server responds to a
    // real request (handles Pyright which doesn't send $/progress during indexing)
    serverState.readyPromise = this.probeServerReadiness(serverState);

    return serverState;
  }

  private async probeServerReadiness(serverState: ServerState): Promise<void> {
    const startTime = Date.now();
    const cmd = serverState.config.command.join(' ');

    const rootDir = serverState.config.rootDir || process.cwd();
    const filePath = this.findFirstFile(rootDir, serverState.config.extensions, 3);
    if (!filePath) {
      logger.info('probeServerReadiness', `${cmd}: no files found, skipping probe`);
      return;
    }

    try {
      await this.ensureFileOpen(serverState, filePath);
      const method = 'textDocument/documentSymbol';
      const timeout =
        serverState.adapter?.getTimeout?.(method) ??
        DEFAULT_METHOD_TIMEOUTS[method] ??
        DEFAULT_TIMEOUT;
      await this.sendRequest(
        serverState.process,
        method,
        { textDocument: { uri: pathToUri(filePath) } },
        Math.max(timeout, 120000)
      );
      logger.info('probeServerReadiness', `${cmd}: ready after ${Date.now() - startTime}ms`);
    } catch (error) {
      logger.warn(
        'probeServerReadiness',
        `${cmd}: probe failed after ${Date.now() - startTime}ms: ${error}`
      );
      // Resolve anyway — server may still work for other requests
    }
  }

  private handleMessage(message: LSPMessage, serverState?: ServerState) {
    // Distinguish responses from server-initiated requests per JSON-RPC 2.0:
    // - Responses have `id` + (`result` or `error`), no `method`
    // - Server requests have `id` + `method`
    // - Notifications have `method`, no `id`
    //
    // CRITICAL: Use hasId() instead of truthiness check on message.id because
    // id=0 is a valid JSON-RPC id but is falsy in JavaScript. Servers like
    // pyright/basedpyright start their request IDs at 0, so failing to handle
    // id=0 causes the server to hang waiting for a response (the root cause of
    // rename_symbol timeouts).
    const msgHasId = hasId(message);
    const isResponse = msgHasId && !message.method;

    if (isResponse && this.pendingRequests.has(message.id as number)) {
      const request = this.pendingRequests.get(message.id as number);
      if (!request) return;
      const { resolve, reject } = request;
      this.pendingRequests.delete(message.id as number);

      if (message.error) {
        logger.warn(
          'handleMessage',
          `LSP error response for request ${message.id}: ${message.error.message || 'unknown error'}`
        );
        reject(new Error(message.error.message || 'LSP Error'));
      } else {
        resolve(message.result);
      }
      return;
    }

    // Handle notifications and requests from server
    if (message.method && serverState) {
      const { adapter } = serverState;

      // Try adapter-specific handlers first for custom requests (server-initiated requests have id + method)
      if (msgHasId && adapter?.handleRequest) {
        logger.debug(
          'handleMessage',
          `Delegating server request to adapter: ${message.method} (id=${message.id})`
        );
        adapter
          .handleRequest(message.method, message.params, serverState)
          .then((result) => {
            // Send response back to server
            this.sendMessage(serverState.process, {
              jsonrpc: '2.0',
              id: message.id,
              result,
            });
          })
          .catch((error) => {
            // Send error response back to server per JSON-RPC spec
            logger.debug(
              'handleMessage',
              `Adapter did not handle request: ${message.method} - ${error}`
            );
            this.sendMessage(serverState.process, {
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32603, message: `Internal error: ${error}` },
            });
          });
        return;
      }

      // Handle server-initiated requests that have no adapter handler.
      // Per JSON-RPC, every request MUST get a response — otherwise the server
      // blocks waiting, which stalls all subsequent LSP requests (e.g. rename).
      if (msgHasId) {
        logger.info(
          'handleMessage',
          `Auto-responding to server request: ${message.method} (id=${message.id})`
        );

        let result: unknown = null;

        // workspace/configuration expects an array matching params.items length.
        // Return server-appropriate settings to avoid resetting initializationOptions.
        if (
          message.method === 'workspace/configuration' &&
          message.params &&
          typeof message.params === 'object' &&
          'items' in message.params &&
          Array.isArray((message.params as { items: unknown[] }).items)
        ) {
          const items = (message.params as { items: Array<{ section?: string }> }).items;
          const adapterSettings = serverState.adapter?.getWorkspaceSettings?.(serverState.config);
          result = items.map((item) => {
            // For pylsp, return settings that keep heavy plugins disabled
            // (matches what we send in initializationOptions)
            if (item.section === 'pylsp' && this.isPylspServer(serverState.config)) {
              return {
                plugins: {
                  jedi_completion: { enabled: true },
                  jedi_definition: { enabled: true },
                  jedi_hover: { enabled: true },
                  jedi_references: { enabled: true },
                  jedi_signature_help: { enabled: true },
                  jedi_symbols: { enabled: true },
                  pylint: { enabled: false },
                  pycodestyle: { enabled: false },
                  pyflakes: { enabled: false },
                  yapf: { enabled: false },
                  rope_completion: { enabled: false },
                },
              };
            }
            // Return adapter-provided settings for the requested section
            if (item.section && adapterSettings && item.section in adapterSettings) {
              return (adapterSettings as Record<string, unknown>)[item.section];
            }
            return {};
          });
        }

        this.sendMessage(serverState.process, {
          jsonrpc: '2.0',
          id: message.id,
          result,
        });
        return;
      }

      // Try adapter-specific notification handlers (notifications have method but no id)
      if (!msgHasId && adapter?.handleNotification) {
        const handled = adapter.handleNotification(message.method, message.params, serverState);
        if (handled) {
          return;
        }
      }

      // Standard LSP message handling
      if (message.method === 'textDocument/publishDiagnostics') {
        // Handle diagnostic notifications from the server
        const params = message.params as {
          uri: string;
          diagnostics: Diagnostic[];
          version?: number;
        };
        if (params?.uri) {
          logger.debug(
            'handleMessage',
            `publishDiagnostics for ${params.uri}: ${params.diagnostics?.length || 0} diagnostics${params.version !== undefined ? ` (version: ${params.version})` : ''}`
          );
          serverState.diagnostics.set(params.uri, params.diagnostics || []);
          serverState.lastDiagnosticUpdate.set(params.uri, Date.now());
          if (params.version !== undefined) {
            serverState.diagnosticVersions.set(params.uri, params.version);
          }
        }
      }

      if (message.method === '$/progress') {
        const params = message.params as {
          token: string | number;
          value: { kind: string; title?: string; message?: string; percentage?: number };
        };
        if (params?.value) {
          if (params.value.kind === 'begin') {
            serverState.progressTokens.add(params.token);
            logger.info(
              'handleMessage',
              `Progress begin: "${params.value.title || ''}" (token=${params.token})`
            );
          } else if (params.value.kind === 'end') {
            serverState.progressTokens.delete(params.token);
            logger.info(
              'handleMessage',
              `Progress end (token=${params.token}), active: ${serverState.progressTokens.size}`
            );
            if (serverState.progressTokens.size === 0 && serverState.indexingWaiters.length > 0) {
              logger.info(
                'handleMessage',
                `All progress tokens completed, notifying ${serverState.indexingWaiters.length} waiter(s)`
              );
              const waiters = serverState.indexingWaiters.splice(0);
              for (const waiter of waiters) waiter();
            }
          } else if (params.value.kind === 'report') {
            logger.debug(
              'handleMessage',
              `Progress report (token=${params.token}): ${params.value.message || ''}${params.value.percentage !== undefined ? ` ${params.value.percentage}%` : ''}`
            );
          }
        }
      }
    }
  }

  private sendMessage(childProcess: ChildProcess, message: LSPMessage): void {
    const content = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
    try {
      childProcess.stdin?.write(header + content);
    } catch {
      // Process stdin may be closed if the server died — ignore EPIPE
    }
  }

  private sendRequest(
    childProcess: ChildProcess,
    method: string,
    params: unknown,
    timeout = 30000
  ): Promise<unknown> {
    const id = this.nextId++;
    const message: LSPMessage = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const startTime = Date.now();
    logger.info(
      'sendRequest',
      `→ ${method} (id=${id}, timeout=${timeout}ms, pid=${childProcess.pid})`
    );

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        const elapsed = Date.now() - startTime;
        logger.error(
          'sendRequest',
          `✗ TIMEOUT ${method} (id=${id}) after ${elapsed}ms — pending requests: ${this.pendingRequests.size}`
        );
        reject(new Error(`LSP request timeout: ${method} (${timeout}ms)`));
      }, timeout);

      this.pendingRequests.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timeoutId);
          const elapsed = Date.now() - startTime;
          logger.info('sendRequest', `← ${method} (id=${id}) completed in ${elapsed}ms`);
          resolve(value);
        },
        reject: (reason?: unknown) => {
          clearTimeout(timeoutId);
          const elapsed = Date.now() - startTime;
          logger.warn(
            'sendRequest',
            `← ${method} (id=${id}) rejected after ${elapsed}ms: ${reason}`
          );
          reject(reason);
        },
        pid: childProcess.pid,
      });

      this.sendMessage(childProcess, message);
    });
  }

  private sendNotification(childProcess: ChildProcess, method: string, params: unknown): void {
    const message: LSPMessage = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.sendMessage(childProcess, message);
  }

  private setupRestartTimer(serverState: ServerState): void {
    if (serverState.config.restartInterval && serverState.config.restartInterval > 0) {
      // Minimum interval is 0.1 minutes (6 seconds) for testing, practical minimum is 1 minute
      const minInterval = 0.1;
      const actualInterval = Math.max(serverState.config.restartInterval, minInterval);
      const intervalMs = actualInterval * 60 * 1000; // Convert minutes to milliseconds

      logger.debug('setupRestartTimer', `Setting up restart timer for ${actualInterval} minutes`);

      serverState.restartTimer = setTimeout(() => {
        this.restartServer(serverState);
      }, intervalMs);
    }
  }

  private async restartServer(serverState: ServerState): Promise<void> {
    const key = JSON.stringify(serverState.config);
    logger.info(
      'restartServer',
      `Restarting LSP server for ${serverState.config.command.join(' ')}`
    );

    // Clear existing timer
    if (serverState.restartTimer) {
      clearTimeout(serverState.restartTimer);
      serverState.restartTimer = undefined;
    }

    // Mark as dead before killing to prevent the onServerDeath handler from
    // double-processing (it checks the dead flag first)
    serverState.dead = true;
    serverState.process.kill();

    // Remove from servers map
    this.servers.delete(key);

    try {
      // Start new server
      const newServerState = await this.startServer(serverState.config);
      this.servers.set(key, newServerState);

      logger.info(
        'restartServer',
        `Successfully restarted LSP server for ${serverState.config.command.join(' ')}`
      );
    } catch (error) {
      logger.error('restartServer', `Failed to restart LSP server: ${error}`);
    }
  }

  /**
   * Manually restart LSP servers for specific extensions or all servers
   * @param extensions Array of file extensions, or null to restart all
   * @returns Object with success status and details about restarted servers
   */
  async restartServers(
    extensions?: string[]
  ): Promise<{ success: boolean; restarted: string[]; failed: string[]; message: string }> {
    const restarted: string[] = [];
    const failed: string[] = [];

    logger.info(
      'restartServers',
      `Request to restart servers for extensions: ${extensions ? extensions.join(', ') : 'all'}`
    );

    // Collect servers to restart
    const serversToRestart: Array<{ key: string; state: ServerState }> = [];

    for (const [key, serverState] of this.servers.entries()) {
      if (!extensions || extensions.some((ext) => serverState.config.extensions.includes(ext))) {
        serversToRestart.push({ key, state: serverState });
      }
    }

    if (serversToRestart.length === 0) {
      const message = extensions
        ? `No LSP servers found for extensions: ${extensions.join(', ')}`
        : 'No LSP servers are currently running';
      return { success: false, restarted: [], failed: [], message };
    }

    // Restart each server
    for (const { key, state } of serversToRestart) {
      const serverDesc = `${state.config.command.join(' ')} (${state.config.extensions.join(', ')})`;

      try {
        // Clear existing timer
        if (state.restartTimer) {
          clearTimeout(state.restartTimer);
          state.restartTimer = undefined;
        }

        // Mark as dead before killing to prevent onServerDeath double-processing
        state.dead = true;
        state.process.kill();

        // Remove from servers map
        this.servers.delete(key);

        // Start new server
        const newServerState = await this.startServer(state.config);
        this.servers.set(key, newServerState);

        restarted.push(serverDesc);
        logger.info('restartServers', `Successfully restarted: ${serverDesc}`);
      } catch (error) {
        failed.push(`${serverDesc}: ${error}`);
        logger.error('restartServers', `Failed to restart: ${serverDesc}: ${error}`);
      }
    }

    const success = failed.length === 0;
    let message: string;

    if (success) {
      message = `Successfully restarted ${restarted.length} LSP server(s)`;
    } else if (restarted.length > 0) {
      message = `Restarted ${restarted.length} server(s), but ${failed.length} failed`;
    } else {
      message = `Failed to restart all ${failed.length} server(s)`;
    }

    return { success, restarted, failed, message };
  }

  /**
   * Synchronize file content with LSP server after external modifications
   * This should be called after any disk writes to keep the LSP server in sync
   */
  async syncFileContent(filePath: string): Promise<void> {
    try {
      const serverState = await this.getServer(filePath);

      // If file is not already open in the LSP server, open it first
      if (!serverState.openFiles.has(filePath)) {
        logger.debug('syncFileContent', `File not open, opening it first: ${filePath}`);
        await this.ensureFileOpen(serverState, filePath);
      }

      logger.debug('syncFileContent', `Syncing file: ${filePath}`);

      const fileContent = readFileSync(filePath, 'utf-8');
      const uri = pathToUri(filePath);

      // Increment version and send didChange notification
      const version = (serverState.fileVersions.get(filePath) || 1) + 1;
      serverState.fileVersions.set(filePath, version);

      await this.sendNotification(serverState.process, 'textDocument/didChange', {
        textDocument: {
          uri,
          version,
        },
        contentChanges: [
          {
            text: fileContent,
          },
        ],
      });

      logger.debug('syncFileContent', `File synced with version ${version}: ${filePath}`);
    } catch (error) {
      logger.warn('syncFileContent', `Failed to sync file ${filePath}: ${error}`);
      // Don't throw - syncing is best effort
    }
  }

  private async ensureFileOpen(serverState: ServerState, filePath: string): Promise<boolean> {
    const wasAlreadyOpen = serverState.openFiles.has(filePath);
    if (wasAlreadyOpen) {
      logger.debug('ensureFileOpen', `File already open: ${filePath}`);
      return false; // Return false to indicate file was already open
    }

    logger.debug('ensureFileOpen', `Opening file: ${filePath}`);

    try {
      const fileContent = readFileSync(filePath, 'utf-8');
      const uri = pathToUri(filePath);
      const languageId = this.getLanguageId(filePath);

      logger.debug(
        'ensureFileOpen',
        `File content length: ${fileContent.length}, languageId: ${languageId}`
      );

      await this.sendNotification(serverState.process, 'textDocument/didOpen', {
        textDocument: {
          uri,
          languageId,
          version: 1,
          text: fileContent,
        },
      });

      serverState.openFiles.add(filePath);
      serverState.fileVersions.set(filePath, 1);
      logger.debug('ensureFileOpen', `File opened successfully: ${filePath}`);
      return true; // Return true to indicate file was just opened
    } catch (error) {
      logger.error('ensureFileOpen', `Failed to open file ${filePath}: ${error}`);
      throw error;
    }
  }

  private getLanguageId(filePath: string): string {
    const extension = filePath.split('.').pop()?.toLowerCase();
    const languageMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescriptreact',
      js: 'javascript',
      jsx: 'javascriptreact',
      py: 'python',
      go: 'go',
      rs: 'rust',
      c: 'c',
      cpp: 'cpp',
      h: 'c',
      hpp: 'cpp',
      java: 'java',
      jar: 'java', // JAR files contain Java bytecode
      class: 'java', // Java class files
      cs: 'csharp',
      php: 'php',
      rb: 'ruby',
      swift: 'swift',
      kt: 'kotlin',
      scala: 'scala',
      dart: 'dart',
      lua: 'lua',
      sh: 'shellscript',
      bash: 'shellscript',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      xml: 'xml',
      html: 'html',
      css: 'css',
      scss: 'scss',
      vue: 'vue',
      svelte: 'svelte',
      tf: 'terraform',
      sql: 'sql',
      graphql: 'graphql',
      gql: 'graphql',
      md: 'markdown',
      tex: 'latex',
      elm: 'elm',
      hs: 'haskell',
      ml: 'ocaml',
      clj: 'clojure',
      fs: 'fsharp',
      r: 'r',
      toml: 'toml',
      zig: 'zig',
    };

    return languageMap[extension || ''] || 'plaintext';
  }

  private async getServer(filePath: string): Promise<ServerState> {
    logger.debug('getServer', `Getting server for file: ${filePath}`);

    let serverConfig = this.getServerForFile(filePath);
    if (!serverConfig) {
      throw new Error(`No LSP server configured for file: ${filePath}`);
    }

    // When rootDir is not configured, infer it from the file path so that
    // each project gets its own server instance with the correct workspace root.
    if (!serverConfig.rootDir) {
      const detectedRoot = this.detectProjectRoot(filePath);
      if (detectedRoot) {
        serverConfig = { ...serverConfig, rootDir: detectedRoot };
        logger.info('getServer', `Inferred rootDir: ${detectedRoot} for ${filePath}`);
      }
    }

    const cmd = serverConfig.command.join(' ');
    logger.debug('getServer', `Found server config: ${cmd}`);

    const key = JSON.stringify(serverConfig);

    // Check if server already exists
    if (this.servers.has(key)) {
      const server = this.servers.get(key);
      if (!server) {
        throw new Error('Server exists in map but is undefined');
      }

      // If the server is marked dead, remove it and start a fresh one
      if (server.dead) {
        logger.warn('getServer', `Cached server is dead (${cmd}), removing and starting fresh`);
        this.servers.delete(key);
      } else {
        logger.debug('getServer', `Using existing server (${cmd}, pid=${server.process.pid})`);
        return server;
      }
    }

    // Check if server is currently starting
    if (this.serversStarting.has(key)) {
      logger.debug('getServer', `Waiting for server startup in progress (${cmd})`);
      const startPromise = this.serversStarting.get(key);
      if (!startPromise) {
        throw new Error('Server start promise exists in map but is undefined');
      }
      return await startPromise;
    }

    // Start new server with concurrency protection
    logger.info('getServer', `Starting new server: ${cmd}`);
    const startPromise = this.startServer(serverConfig);
    this.serversStarting.set(key, startPromise);

    try {
      const serverState = await startPromise;
      this.servers.set(key, serverState);
      this.serversStarting.delete(key);
      logger.info(
        'getServer',
        `Server started and cached (${cmd}, pid=${serverState.process.pid})`
      );
      return serverState;
    } catch (error) {
      this.serversStarting.delete(key);
      throw error;
    }
  }

  async findDefinition(filePath: string, position: Position): Promise<Location[]> {
    const startTime = Date.now();
    logger.info('findDefinition', `${filePath} at ${position.line}:${position.character}`);

    const serverState = await this.getServer(filePath);

    // Wait for the server to be fully initialized
    await serverState.initializationPromise;

    // Ensure the file is opened and synced with the LSP server
    const wasJustOpened = await this.ensureFileOpen(serverState, filePath);

    // If the file was just opened, give the LSP server time to index the project
    // This fixes issue #27 where the first find_references call returns incomplete results
    if (wasJustOpened) {
      logger.debug(
        'findDefinition',
        'File was just opened, waiting for server to index project...'
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    logger.debug('findDefinition', 'Sending textDocument/definition request');
    const method = 'textDocument/definition';
    const timeout =
      serverState.adapter?.getTimeout?.(method) ??
      DEFAULT_METHOD_TIMEOUTS[method] ??
      DEFAULT_TIMEOUT;
    const result = await this.sendRequest(
      serverState.process,
      method,
      {
        textDocument: { uri: pathToUri(filePath) },
        position,
      },
      timeout
    );

    if (Array.isArray(result)) {
      const locations = result.map((loc: LSPLocation) => ({
        uri: loc.uri,
        range: loc.range,
      }));
      logger.info(
        'findDefinition',
        `completed in ${Date.now() - startTime}ms, returned ${locations.length} location(s)`
      );
      return locations;
    }
    if (result && typeof result === 'object' && 'uri' in result) {
      const location = result as LSPLocation;
      logger.info(
        'findDefinition',
        `completed in ${Date.now() - startTime}ms, returned 1 location`
      );
      return [
        {
          uri: location.uri,
          range: location.range,
        },
      ];
    }

    logger.info('findDefinition', `completed in ${Date.now() - startTime}ms, no definition found`);
    return [];
  }

  async findReferences(
    filePath: string,
    position: Position,
    includeDeclaration = true
  ): Promise<Location[]> {
    const startTime = Date.now();
    logger.info(
      'findReferences',
      `${filePath} at ${position.line}:${position.character}, includeDeclaration: ${includeDeclaration}`
    );

    const serverState = await this.getServer(filePath);

    // Wait for the server to be fully initialized
    await serverState.initializationPromise;

    // Ensure the file is opened and synced with the LSP server
    const wasJustOpened = await this.ensureFileOpen(serverState, filePath);

    // If the file was just opened, give the LSP server time to index the project
    // This fixes issue #27 where the first find_references call returns incomplete results
    if (wasJustOpened) {
      logger.debug(
        'findReferences',
        'File was just opened, waiting for server to index project...'
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const method = 'textDocument/references';
    const timeout =
      serverState.adapter?.getTimeout?.(method) ??
      DEFAULT_METHOD_TIMEOUTS[method] ??
      DEFAULT_TIMEOUT;
    const result = await this.sendRequest(
      serverState.process,
      method,
      {
        textDocument: { uri: pathToUri(filePath) },
        position,
        context: { includeDeclaration },
      },
      timeout
    );

    if (Array.isArray(result)) {
      const locations = result.map((loc: LSPLocation) => ({
        uri: loc.uri,
        range: loc.range,
      }));
      logger.info(
        'findReferences',
        `completed in ${Date.now() - startTime}ms, returned ${locations.length} reference(s)`
      );
      return locations;
    }

    logger.info('findReferences', `completed in ${Date.now() - startTime}ms, no references found`);
    return [];
  }

  /**
   * Normalize an LSP WorkspaceEdit result into the `changes` format.
   * Handles both `changes` (older servers) and `documentChanges` (modern servers) formats.
   */
  private normalizeWorkspaceEdit(
    result: unknown
  ): Record<string, Array<{ range: { start: Position; end: Position }; newText: string }>> | null {
    if (!result || typeof result !== 'object') return null;

    if ('changes' in result) {
      const edit = result as {
        changes: Record<
          string,
          Array<{ range: { start: Position; end: Position }; newText: string }>
        >;
      };
      if (!edit.changes || Object.keys(edit.changes).length === 0) return null;
      return edit.changes;
    }

    if ('documentChanges' in result) {
      const edit = result as {
        documentChanges?: Array<{
          textDocument: { uri: string; version?: number };
          edits: Array<{ range: { start: Position; end: Position }; newText: string }>;
        }>;
      };

      const changes: Record<
        string,
        Array<{ range: { start: Position; end: Position }; newText: string }>
      > = {};

      if (edit.documentChanges) {
        for (const change of edit.documentChanges) {
          if (change.textDocument && change.edits) {
            const uri = change.textDocument.uri;
            if (!changes[uri]) {
              changes[uri] = [];
            }
            changes[uri].push(...change.edits);
          }
        }
      }

      return Object.keys(changes).length > 0 ? changes : null;
    }

    return null;
  }

  async renameSymbol(
    filePath: string,
    position: Position,
    newName: string
  ): Promise<{
    changes?: Record<string, Array<{ range: { start: Position; end: Position }; newText: string }>>;
  }> {
    const renameStart = Date.now();
    logger.info(
      'renameSymbol',
      `Requesting rename for ${filePath} at ${position.line}:${position.character} to "${newName}"`
    );

    const serverState = await this.getServer(filePath);
    logger.debug(
      'renameSymbol',
      `Server acquired in ${Date.now() - renameStart}ms (adapter=${serverState.adapter?.name ?? 'none'}, dead=${serverState.dead ?? false})`
    );

    // Wait for the server to be fully initialized
    await serverState.initializationPromise;
    logger.debug('renameSymbol', `Server initialized, elapsed ${Date.now() - renameStart}ms`);

    // Ensure the file is opened and synced with the LSP server
    await this.ensureFileOpen(serverState, filePath);

    const method = 'textDocument/rename';
    const timeout =
      serverState.adapter?.getTimeout?.(method) ??
      DEFAULT_METHOD_TIMEOUTS[method] ??
      DEFAULT_TIMEOUT;
    logger.info('renameSymbol', `Sending textDocument/rename (timeout=${timeout}ms)`);
    const result = await this.sendRequest(
      serverState.process,
      method,
      {
        textDocument: { uri: pathToUri(filePath) },
        position,
        newName,
      },
      timeout
    );

    const changes = this.normalizeWorkspaceEdit(result);
    if (changes) {
      const changeCount = Object.keys(changes).length;
      logger.info(
        'renameSymbol',
        `WorkspaceEdit has changes for ${changeCount} files (total elapsed ${Date.now() - renameStart}ms)`
      );
      return { changes };
    }

    logger.warn(
      'renameSymbol',
      `No rename changes available (total elapsed ${Date.now() - renameStart}ms)`
    );
    return {};
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string,
    dryRun = false
  ): Promise<{
    moved: boolean;
    importChanges: Record<
      string,
      Array<{ range: { start: Position; end: Position }; newText: string }>
    > | null;
    warnings: string[];
  }> {
    const startTime = Date.now();
    logger.info(
      'moveFile',
      `${dryRun ? '[DRY RUN] ' : ''}Moving ${sourcePath} -> ${destinationPath}`
    );

    // Validate source exists and is a file
    if (!existsSync(sourcePath)) {
      throw new Error(`Source file does not exist: ${sourcePath}`);
    }
    const stats = lstatSync(sourcePath);
    if (stats.isDirectory()) {
      throw new Error(`Source is a directory, not a file: ${sourcePath}`);
    }

    // Validate destination does not already exist
    if (existsSync(destinationPath)) {
      throw new Error(`Destination already exists: ${destinationPath}`);
    }

    const oldUri = pathToUri(sourcePath);
    const newUri = pathToUri(destinationPath);
    const renameParams = { files: [{ oldUri, newUri }] };

    // Ensure source file is open so LSP server can resolve its import graph
    try {
      const serverState = await this.getServer(sourcePath);
      await this.ensureFileOpen(serverState, sourcePath);
    } catch {
      // No server for this file type - proceed anyway
    }

    // Collect workspace edits from all servers that support willRenameFiles
    const mergedChanges: Record<
      string,
      Array<{ range: { start: Position; end: Position }; newText: string }>
    > = {};
    const warnings: string[] = [];

    // Query all servers in parallel to avoid timeout multiplication
    // (N servers * 45s timeout = unacceptable wait if done sequentially)
    const serverPromises = Array.from(this.servers.values()).map(async (serverState) => {
      const caps = serverState.serverCapabilities?.workspace as
        | { fileOperations?: { willRename?: unknown } }
        | undefined;
      if (!caps?.fileOperations?.willRename) {
        warnings.push(
          `Server ${serverState.config.command[0]} does not support willRenameFiles — imports handled by this server won't be updated.`
        );
        return;
      }

      try {
        await serverState.initializationPromise;
        const timeout = serverState.adapter?.getTimeout?.('workspace/willRenameFiles') ?? 45000;
        const result = await this.sendRequest(
          serverState.process,
          'workspace/willRenameFiles',
          renameParams,
          timeout
        );

        const changes = this.normalizeWorkspaceEdit(result);
        if (changes) {
          for (const [uri, edits] of Object.entries(changes)) {
            if (!mergedChanges[uri]) {
              mergedChanges[uri] = [];
            }
            mergedChanges[uri].push(...edits);
          }
        }
      } catch (error) {
        warnings.push(
          `Failed to get import updates from ${serverState.config.command[0]}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });

    await Promise.all(serverPromises);

    const hasImportChanges = Object.keys(mergedChanges).length > 0;

    if (dryRun) {
      return {
        moved: false,
        importChanges: hasImportChanges ? mergedChanges : null,
        warnings,
      };
    }

    // Apply import edits while old file still exists (so servers can resolve)
    if (hasImportChanges) {
      const editResult = await applyWorkspaceEdit({ changes: mergedChanges }, { lspClient: this });
      if (!editResult.success) {
        throw new Error(`Failed to apply import updates: ${editResult.error}`);
      }
      logger.info('moveFile', `Applied import edits to ${editResult.filesModified.length} file(s)`);
    }

    // Create destination directory if needed
    const destDir = dirname(destinationPath);
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }

    // Move the file
    renameSync(sourcePath, destinationPath);
    logger.info('moveFile', `File moved on disk, elapsed ${Date.now() - startTime}ms`);

    // Update LSP state: close old file, open new file
    for (const serverState of this.servers.values()) {
      if (serverState.openFiles.has(sourcePath)) {
        this.sendNotification(serverState.process, 'textDocument/didClose', {
          textDocument: { uri: oldUri },
        });
        serverState.openFiles.delete(sourcePath);
        serverState.fileVersions.delete(sourcePath);
        serverState.symbolCache.delete(sourcePath);
        serverState.diagnostics.delete(oldUri);
        serverState.lastDiagnosticUpdate.delete(oldUri);
        serverState.diagnosticVersions.delete(oldUri);
      }
    }

    // Notify all supporting servers about the rename
    for (const serverState of this.servers.values()) {
      const caps = serverState.serverCapabilities?.workspace as
        | { fileOperations?: { didRename?: unknown } }
        | undefined;
      if (caps?.fileOperations?.didRename) {
        this.sendNotification(serverState.process, 'workspace/didRenameFiles', renameParams);
      }
    }

    // Open the file at its new location in the appropriate server
    try {
      const serverState = await this.getServer(destinationPath);
      await this.ensureFileOpen(serverState, destinationPath);
    } catch {
      // No server handles the new file extension — that's fine
    }

    return {
      moved: true,
      importChanges: hasImportChanges ? mergedChanges : null,
      warnings,
    };
  }

  async getDocumentSymbols(filePath: string): Promise<DocumentSymbol[] | SymbolInformation[]> {
    const startTime = Date.now();
    logger.info('getDocumentSymbols', `${filePath}`);

    const serverState = await this.getServer(filePath);

    // Wait for the server to be fully initialized
    await serverState.initializationPromise;

    // Ensure the file is opened and synced with the LSP server
    await this.ensureFileOpen(serverState, filePath);

    // Wait for server readiness — handles both $/progress servers and probe-based
    // servers like Pyright (which don't send $/progress during indexing).
    // If the server isn't ready within 10s, return empty so callers get a fast response.
    {
      const timeout = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('ready timeout')), 10000)
      );
      try {
        await Promise.race([serverState.readyPromise, timeout]);
      } catch {
        logger.info('getDocumentSymbols', 'Server not ready after 10s, returning empty');
        return [];
      }
    }

    // Check symbol cache - use fileVersions for invalidation
    const currentVersion = serverState.fileVersions.get(filePath) ?? 0;
    const cached = serverState.symbolCache.get(filePath);
    if (cached && cached.version === currentVersion) {
      logger.debug(
        'getDocumentSymbols',
        `Returning cached symbols for ${filePath} (version ${currentVersion}, ${cached.symbols.length} symbols)`
      );
      return cached.symbols;
    }

    logger.debug('getDocumentSymbols', `Requesting documentSymbol for: ${filePath}`);

    // Get custom timeout from adapter if available
    const method = 'textDocument/documentSymbol';
    const timeout =
      serverState.adapter?.getTimeout?.(method) ??
      DEFAULT_METHOD_TIMEOUTS[method] ??
      DEFAULT_TIMEOUT;

    const result = await this.sendRequest(
      serverState.process,
      method,
      {
        textDocument: { uri: pathToUri(filePath) },
      },
      timeout
    );

    if (Array.isArray(result)) {
      const symbols = result as DocumentSymbol[] | SymbolInformation[];
      // Cache the result with current file version
      serverState.symbolCache.set(filePath, { version: currentVersion, symbols });
      logger.info(
        'getDocumentSymbols',
        `completed in ${Date.now() - startTime}ms, returned ${symbols.length} symbol(s)`
      );
      return symbols;
    }

    logger.info('getDocumentSymbols', `completed in ${Date.now() - startTime}ms, no symbols found`);
    return [];
  }

  private flattenDocumentSymbols(
    symbols: DocumentSymbol[],
    parentName?: string
  ): Array<{ symbol: DocumentSymbol; containerName?: string }> {
    const flattened: Array<{ symbol: DocumentSymbol; containerName?: string }> = [];

    for (const symbol of symbols) {
      flattened.push({ symbol, containerName: parentName });
      if (symbol.children) {
        flattened.push(...this.flattenDocumentSymbols(symbol.children, symbol.name));
      }
    }

    return flattened;
  }

  private isDocumentSymbolArray(
    symbols: DocumentSymbol[] | SymbolInformation[]
  ): symbols is DocumentSymbol[] {
    if (symbols.length === 0) return true;
    const firstSymbol = symbols[0];
    if (!firstSymbol) return true;
    // DocumentSymbol has 'range' and 'selectionRange', SymbolInformation has 'location'
    return 'range' in firstSymbol && 'selectionRange' in firstSymbol;
  }

  symbolKindToString(kind: SymbolKind): string {
    const kindMap: Record<SymbolKind, string> = {
      [SymbolKind.File]: 'file',
      [SymbolKind.Module]: 'module',
      [SymbolKind.Namespace]: 'namespace',
      [SymbolKind.Package]: 'package',
      [SymbolKind.Class]: 'class',
      [SymbolKind.Method]: 'method',
      [SymbolKind.Property]: 'property',
      [SymbolKind.Field]: 'field',
      [SymbolKind.Constructor]: 'constructor',
      [SymbolKind.Enum]: 'enum',
      [SymbolKind.Interface]: 'interface',
      [SymbolKind.Function]: 'function',
      [SymbolKind.Variable]: 'variable',
      [SymbolKind.Constant]: 'constant',
      [SymbolKind.String]: 'string',
      [SymbolKind.Number]: 'number',
      [SymbolKind.Boolean]: 'boolean',
      [SymbolKind.Array]: 'array',
      [SymbolKind.Object]: 'object',
      [SymbolKind.Key]: 'key',
      [SymbolKind.Null]: 'null',
      [SymbolKind.EnumMember]: 'enum_member',
      [SymbolKind.Struct]: 'struct',
      [SymbolKind.Event]: 'event',
      [SymbolKind.Operator]: 'operator',
      [SymbolKind.TypeParameter]: 'type_parameter',
    };
    return kindMap[kind] || 'unknown';
  }

  getValidSymbolKinds(): string[] {
    return [
      'file',
      'module',
      'namespace',
      'package',
      'class',
      'method',
      'property',
      'field',
      'constructor',
      'enum',
      'interface',
      'function',
      'variable',
      'constant',
      'string',
      'number',
      'boolean',
      'array',
      'object',
      'key',
      'null',
      'enum_member',
      'struct',
      'event',
      'operator',
      'type_parameter',
    ];
  }

  private async findSymbolPositionInFile(
    filePath: string,
    symbol: SymbolInformation
  ): Promise<Position> {
    try {
      const fileContent = readFileSync(filePath, 'utf-8');
      const lines = fileContent.split('\n');

      const range = symbol.location.range;
      const startLine = range.start.line;
      const endLine = range.end.line;

      logger.debug(
        'findSymbolPositionInFile',
        `Searching for "${symbol.name}" in lines ${startLine}-${endLine}`
      );

      // Search within the symbol's range for the symbol name
      for (let lineNum = startLine; lineNum <= endLine && lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        if (!line) continue;

        // Find all occurrences of the symbol name in this line
        let searchStart = 0;
        if (lineNum === startLine) {
          searchStart = range.start.character;
        }

        let searchEnd = line.length;
        if (lineNum === endLine) {
          searchEnd = range.end.character;
        }

        const searchText = line.substring(searchStart, searchEnd);
        const symbolIndex = searchText.indexOf(symbol.name);

        if (symbolIndex !== -1) {
          const actualCharacter = searchStart + symbolIndex;
          logger.debug(
            'findSymbolPositionInFile',
            `Found "${symbol.name}" at line ${lineNum}, character ${actualCharacter}`
          );

          return {
            line: lineNum,
            character: actualCharacter,
          };
        }
      }

      // Fallback to range start if not found
      logger.debug(
        'findSymbolPositionInFile',
        `Symbol "${symbol.name}" not found in range, using range start`
      );
      return range.start;
    } catch (error) {
      logger.debug('findSymbolPositionInFile', `Error reading file: ${error}, using range start`);
      return symbol.location.range.start;
    }
  }

  private stringToSymbolKind(kindStr: string): SymbolKind | null {
    const kindMap: Record<string, SymbolKind> = {
      file: SymbolKind.File,
      module: SymbolKind.Module,
      namespace: SymbolKind.Namespace,
      package: SymbolKind.Package,
      class: SymbolKind.Class,
      method: SymbolKind.Method,
      property: SymbolKind.Property,
      field: SymbolKind.Field,
      constructor: SymbolKind.Constructor,
      enum: SymbolKind.Enum,
      interface: SymbolKind.Interface,
      function: SymbolKind.Function,
      variable: SymbolKind.Variable,
      constant: SymbolKind.Constant,
      string: SymbolKind.String,
      number: SymbolKind.Number,
      boolean: SymbolKind.Boolean,
      array: SymbolKind.Array,
      object: SymbolKind.Object,
      key: SymbolKind.Key,
      null: SymbolKind.Null,
      enum_member: SymbolKind.EnumMember,
      struct: SymbolKind.Struct,
      event: SymbolKind.Event,
      operator: SymbolKind.Operator,
      type_parameter: SymbolKind.TypeParameter,
    };
    return kindMap[kindStr.toLowerCase()] || null;
  }

  async findSymbolsByName(
    filePath: string,
    symbolName: string,
    symbolKind?: string
  ): Promise<{ matches: SymbolMatch[]; warning?: string }> {
    const startTime = Date.now();
    logger.info(
      'findSymbolsByName',
      `Searching for "${symbolName}" (kind=${symbolKind || 'any'}) in ${filePath}`
    );

    // Validate symbolKind if provided - return validation info for caller to handle
    let validationWarning: string | undefined;
    let effectiveSymbolKind = symbolKind;
    if (symbolKind && this.stringToSymbolKind(symbolKind) === null) {
      const validKinds = this.getValidSymbolKinds();
      validationWarning = `⚠️ Invalid symbol kind "${symbolKind}". Valid kinds are: ${validKinds.join(', ')}. Searching all symbol types instead.`;
      effectiveSymbolKind = undefined; // Reset to search all kinds
    }

    const symbols = await this.getDocumentSymbols(filePath);
    const matches: SymbolMatch[] = [];

    logger.debug('findSymbolsByName', `Got ${symbols.length} symbols from documentSymbols`);

    if (this.isDocumentSymbolArray(symbols)) {
      logger.debug('findSymbolsByName', 'Processing DocumentSymbol[] (hierarchical format)');
      // Handle DocumentSymbol[] (hierarchical)
      const flatSymbols = this.flattenDocumentSymbols(symbols);
      logger.debug('findSymbolsByName', `Flattened to ${flatSymbols.length} symbols`);

      for (const { symbol, containerName } of flatSymbols) {
        const nameMatches = symbol.name === symbolName || symbol.name.includes(symbolName);
        const kindMatches =
          !effectiveSymbolKind ||
          this.symbolKindToString(symbol.kind) === effectiveSymbolKind.toLowerCase();

        if (nameMatches && kindMatches) {
          logger.debug(
            'findSymbolsByName',
            `DocumentSymbol match: ${symbol.name} (${this.symbolKindToString(symbol.kind)}) at ${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}`
          );

          matches.push({
            name: symbol.name,
            kind: symbol.kind,
            position: symbol.selectionRange.start,
            range: symbol.range,
            detail: symbol.detail,
            containerName,
          });
        }
      }
    } else {
      logger.debug('findSymbolsByName', 'Processing SymbolInformation[] (flat format)');
      // Handle SymbolInformation[] (flat)
      for (const symbol of symbols) {
        const nameMatches = symbol.name === symbolName || symbol.name.includes(symbolName);
        const kindMatches =
          !effectiveSymbolKind ||
          this.symbolKindToString(symbol.kind) === effectiveSymbolKind.toLowerCase();

        if (nameMatches && kindMatches) {
          logger.debug(
            'findSymbolsByName',
            `SymbolInformation match: ${symbol.name} (${this.symbolKindToString(symbol.kind)}) at ${symbol.location.range.start.line}:${symbol.location.range.start.character}`
          );

          // For SymbolInformation, we need to find the actual symbol name position within the range
          // by reading the file content and searching for the symbol name
          const position = await this.findSymbolPositionInFile(filePath, symbol);

          logger.debug(
            'findSymbolsByName',
            `Found symbol position in file: ${position.line}:${position.character}`
          );

          matches.push({
            name: symbol.name,
            kind: symbol.kind,
            position: position,
            range: symbol.location.range,
            detail: undefined, // SymbolInformation doesn't have detail
            containerName: symbol.containerName,
          });
        }
      }
    }

    logger.debug('findSymbolsByName', `Found ${matches.length} matching symbols`);

    // If a specific symbol kind was requested but no matches found, try searching all kinds as fallback
    let fallbackWarning: string | undefined;
    if (effectiveSymbolKind && matches.length === 0) {
      logger.debug(
        'findSymbolsByName',
        `No matches found for kind "${effectiveSymbolKind}", trying fallback search for all kinds`
      );

      const fallbackMatches: SymbolMatch[] = [];

      if (this.isDocumentSymbolArray(symbols)) {
        const flatSymbols = this.flattenDocumentSymbols(symbols);
        for (const { symbol, containerName } of flatSymbols) {
          const nameMatches = symbol.name === symbolName || symbol.name.includes(symbolName);
          if (nameMatches) {
            fallbackMatches.push({
              name: symbol.name,
              kind: symbol.kind,
              position: symbol.selectionRange.start,
              range: symbol.range,
              detail: symbol.detail,
              containerName,
            });
          }
        }
      } else {
        for (const symbol of symbols) {
          const nameMatches = symbol.name === symbolName || symbol.name.includes(symbolName);
          if (nameMatches) {
            const position = await this.findSymbolPositionInFile(filePath, symbol);
            fallbackMatches.push({
              name: symbol.name,
              kind: symbol.kind,
              position: position,
              range: symbol.location.range,
              detail: undefined,
              containerName: symbol.containerName,
            });
          }
        }
      }

      if (fallbackMatches.length > 0) {
        const foundKinds = [
          ...new Set(fallbackMatches.map((m) => this.symbolKindToString(m.kind))),
        ];
        fallbackWarning = `⚠️ No symbols found with kind "${effectiveSymbolKind}". Found ${fallbackMatches.length} symbol(s) with name "${symbolName}" of other kinds: ${foundKinds.join(', ')}.`;
        matches.push(...fallbackMatches);
        logger.debug(
          'findSymbolsByName',
          `Fallback search found ${fallbackMatches.length} additional matches`
        );
      }
    }

    const combinedWarning = [validationWarning, fallbackWarning].filter(Boolean).join(' ');
    logger.info(
      'findSymbolsByName',
      `completed in ${Date.now() - startTime}ms, found ${matches.length} match(es)`
    );
    return { matches, warning: combinedWarning || undefined };
  }

  /**
   * Wait for LSP server to become idle after a change.
   * Uses multiple heuristics to determine when diagnostics are likely complete.
   */
  private async waitForDiagnosticsIdle(
    serverState: ServerState,
    fileUri: string,
    options: {
      maxWaitTime?: number; // Maximum time to wait in ms (default: 1000)
      idleTime?: number; // Time without updates to consider idle in ms (default: 100)
      checkInterval?: number; // How often to check for updates in ms (default: 50)
    } = {}
  ): Promise<void> {
    const { maxWaitTime = 1000, idleTime = 100, checkInterval = 50 } = options;

    const startTime = Date.now();
    let lastVersion = serverState.diagnosticVersions.get(fileUri) ?? -1;
    let lastUpdateTime = serverState.lastDiagnosticUpdate.get(fileUri) ?? startTime;

    logger.debug('waitForDiagnosticsIdle', `Waiting for diagnostics to stabilize for ${fileUri}`);

    while (Date.now() - startTime < maxWaitTime) {
      await new Promise((resolve) => setTimeout(resolve, checkInterval));

      const currentVersion = serverState.diagnosticVersions.get(fileUri) ?? -1;
      const currentUpdateTime = serverState.lastDiagnosticUpdate.get(fileUri) ?? lastUpdateTime;

      // Check if version changed
      if (currentVersion !== lastVersion) {
        logger.debug(
          'waitForDiagnosticsIdle',
          `Version changed from ${lastVersion} to ${currentVersion}`
        );
        lastVersion = currentVersion;
        lastUpdateTime = currentUpdateTime;
        continue;
      }

      // Check if enough time has passed without updates
      const timeSinceLastUpdate = Date.now() - currentUpdateTime;
      if (timeSinceLastUpdate >= idleTime) {
        logger.debug(
          'waitForDiagnosticsIdle',
          `Server appears idle after ${timeSinceLastUpdate}ms without updates`
        );
        return;
      }
    }

    logger.debug('waitForDiagnosticsIdle', `Max wait time reached (${maxWaitTime}ms)`);
  }

  async getDiagnostics(filePath: string): Promise<Diagnostic[]> {
    const startTime = Date.now();
    logger.info('getDiagnostics', `${filePath}`);

    const serverState = await this.getServer(filePath);

    // Wait for the server to be fully initialized
    await serverState.initializationPromise;

    // Ensure the file is opened and synced with the LSP server
    await this.ensureFileOpen(serverState, filePath);

    // First, check if we have cached diagnostics from publishDiagnostics
    const fileUri = pathToUri(filePath);
    const cachedDiagnostics = serverState.diagnostics.get(fileUri);

    if (cachedDiagnostics !== undefined) {
      logger.info(
        'getDiagnostics',
        `completed in ${Date.now() - startTime}ms, returning ${cachedDiagnostics.length} cached diagnostics`
      );
      return cachedDiagnostics;
    }

    // If no cached diagnostics, try the pull-based textDocument/diagnostic
    logger.debug('getDiagnostics', 'No cached diagnostics, trying textDocument/diagnostic request');

    try {
      const result = await this.sendRequest(serverState.process, 'textDocument/diagnostic', {
        textDocument: { uri: fileUri },
      });

      if (result && typeof result === 'object' && 'kind' in result) {
        const report = result as DocumentDiagnosticReport;

        if (report.kind === 'full' && report.items) {
          logger.info(
            'getDiagnostics',
            `completed in ${Date.now() - startTime}ms, full report with ${report.items.length} diagnostics`
          );
          return report.items;
        }
        if (report.kind === 'unchanged') {
          logger.info(
            'getDiagnostics',
            `completed in ${Date.now() - startTime}ms, unchanged report`
          );
          return [];
        }
      }

      logger.info(
        'getDiagnostics',
        `completed in ${Date.now() - startTime}ms, unexpected response format`
      );
      return [];
    } catch (error) {
      // Some LSP servers may not support textDocument/diagnostic
      // Try falling back to waiting for publishDiagnostics notifications
      logger.info(
        'getDiagnostics',
        `textDocument/diagnostic not supported or failed: ${error}. Waiting for publishDiagnostics...`
      );

      // Wait for the server to become idle and publish diagnostics
      // MCP tools can afford longer wait times for better reliability
      await this.waitForDiagnosticsIdle(serverState, fileUri, {
        maxWaitTime: 5000, // 5 seconds - generous timeout for MCP usage
        idleTime: 300, // 300ms idle time to ensure all diagnostics are received
      });

      // Check again for cached diagnostics
      const diagnosticsAfterWait = serverState.diagnostics.get(fileUri);
      if (diagnosticsAfterWait !== undefined) {
        logger.info(
          'getDiagnostics',
          `completed in ${Date.now() - startTime}ms, ${diagnosticsAfterWait.length} diagnostics after idle wait`
        );
        return diagnosticsAfterWait;
      }

      // If still no diagnostics, try triggering publishDiagnostics by making a no-op change
      logger.debug(
        'getDiagnostics',
        'No diagnostics yet, triggering publishDiagnostics with no-op change'
      );

      try {
        // Get current file content
        const fileContent = readFileSync(filePath, 'utf-8');

        // Send a no-op change notification (add and remove a space at the end)
        // Use proper version tracking instead of timestamps
        const version1 = (serverState.fileVersions.get(filePath) || 1) + 1;
        serverState.fileVersions.set(filePath, version1);

        await this.sendNotification(serverState.process, 'textDocument/didChange', {
          textDocument: {
            uri: fileUri,
            version: version1,
          },
          contentChanges: [
            {
              text: `${fileContent} `,
            },
          ],
        });

        // Immediately revert the change with next version
        const version2 = version1 + 1;
        serverState.fileVersions.set(filePath, version2);

        await this.sendNotification(serverState.process, 'textDocument/didChange', {
          textDocument: {
            uri: fileUri,
            version: version2,
          },
          contentChanges: [
            {
              text: fileContent,
            },
          ],
        });

        // Wait for the server to process the changes and become idle
        // After making changes, servers may need time to re-analyze
        await this.waitForDiagnosticsIdle(serverState, fileUri, {
          maxWaitTime: 3000, // 3 seconds after triggering changes
          idleTime: 300, // Consistent idle time for reliability
        });

        // Check one more time
        const diagnosticsAfterTrigger = serverState.diagnostics.get(fileUri);
        if (diagnosticsAfterTrigger !== undefined) {
          logger.info(
            'getDiagnostics',
            `completed in ${Date.now() - startTime}ms, ${diagnosticsAfterTrigger.length} diagnostics after trigger`
          );
          return diagnosticsAfterTrigger;
        }
      } catch (triggerError) {
        logger.warn('getDiagnostics', `Failed to trigger publishDiagnostics: ${triggerError}`);
      }

      return [];
    }
  }

  async hover(
    filePath: string,
    position: Position
  ): Promise<{
    contents: string | { kind: string; value: string };
    range?: { start: Position; end: Position };
  } | null> {
    const startTime = Date.now();
    logger.info('hover', `${filePath} at ${position.line}:${position.character}`);

    const serverState = await this.getServer(filePath);
    await serverState.initializationPromise;
    await this.ensureFileOpen(serverState, filePath);

    const method = 'textDocument/hover';
    const timeout =
      serverState.adapter?.getTimeout?.(method) ??
      DEFAULT_METHOD_TIMEOUTS[method] ??
      DEFAULT_TIMEOUT;
    const result = await this.sendRequest(
      serverState.process,
      method,
      {
        textDocument: { uri: pathToUri(filePath) },
        position,
      },
      timeout
    );

    if (result && typeof result === 'object' && 'contents' in result) {
      logger.info('hover', `completed in ${Date.now() - startTime}ms, has content`);
      return result as {
        contents: string | { kind: string; value: string };
        range?: { start: Position; end: Position };
      };
    }

    logger.info('hover', `completed in ${Date.now() - startTime}ms, no hover info`);
    return null;
  }

  async workspaceSymbol(query: string): Promise<SymbolInformation[]> {
    const startTime = Date.now();
    logger.info('workspaceSymbol', `Searching for "${query}"`);

    // If all servers have died, attempt to re-preload them
    if (this.servers.size === 0 && this.serversStarting.size === 0) {
      logger.warn('workspaceSymbol', 'No servers running, attempting to preload...');
      await this.preloadServers(false);
    }

    const servers = Array.from(this.servers.values());
    if (servers.length === 0) {
      logger.warn('workspaceSymbol', 'No LSP servers running');
      return [];
    }

    const allSymbols: SymbolInformation[] = [];

    for (const serverState of servers) {
      if (!serverState) continue;

      await serverState.initializationPromise;

      // Ensure at least one file is open so the server has a project context
      // (tsserver requires an open file before workspace/symbol can work)
      if (serverState.openFiles.size === 0) {
        const opened = await this.ensureAnyFileOpen(serverState);
        if (opened) {
          // Give the server time to index the project
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      // Wait for server readiness — handles both $/progress servers and probe-based
      // servers like Pyright (which don't send $/progress during indexing).
      {
        const cmd = serverState.config.command.join(' ');
        const timeout = new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('ready timeout')), 10000)
        );
        try {
          await Promise.race([serverState.readyPromise, timeout]);
        } catch {
          logger.info('workspaceSymbol', `${cmd} not ready after 10s, skipping`);
          continue;
        }
      }

      try {
        const method = 'workspace/symbol';
        const timeout =
          serverState.adapter?.getTimeout?.(method) ??
          DEFAULT_METHOD_TIMEOUTS[method] ??
          DEFAULT_TIMEOUT;
        const result = await this.sendRequest(serverState.process, method, { query }, timeout);

        if (Array.isArray(result)) {
          allSymbols.push(...(result as SymbolInformation[]));
        }
      } catch (error) {
        logger.warn(
          'workspaceSymbol',
          `Error from server ${serverState.config.command.join(' ')}: ${error}`
        );
      }
    }

    logger.info(
      'workspaceSymbol',
      `completed in ${Date.now() - startTime}ms, found ${allSymbols.length} symbol(s)`
    );
    return allSymbols;
  }

  /**
   * Open any file matching the server's configured extensions to establish a project context.
   * This is needed for workspace-level LSP requests (e.g. workspace/symbol) that require
   * at least one open file before they can function.
   */
  private async ensureAnyFileOpen(serverState: ServerState): Promise<boolean> {
    const rootDir = serverState.config.rootDir || process.cwd();
    const extensions = serverState.config.extensions;

    const filePath = this.findFirstFile(rootDir, extensions, 3);
    if (!filePath) {
      logger.debug(
        'ensureAnyFileOpen',
        `No matching file found in ${rootDir} for extensions: ${extensions.join(', ')}`
      );
      return false;
    }

    logger.debug('ensureAnyFileOpen', `Opening ${filePath} to establish project context`);
    await this.ensureFileOpen(serverState, filePath);
    return true;
  }

  /**
   * Find the first file matching any of the given extensions within maxDepth levels.
   */
  private findFirstFile(dir: string, extensions: string[], maxDepth: number): string | null {
    if (maxDepth < 0) return null;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      // Check files first (before recursing into subdirs)
      for (const entry of entries) {
        if (entry.isFile()) {
          const ext = entry.name.split('.').pop();
          if (ext && extensions.includes(ext)) {
            return join(dir, entry.name);
          }
        }
      }
      // Then recurse into subdirectories
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const found = this.findFirstFile(join(dir, entry.name), extensions, maxDepth - 1);
          if (found) return found;
        }
      }
    } catch {
      // Directory not readable, skip
    }
    return null;
  }

  async findImplementation(filePath: string, position: Position): Promise<Location[]> {
    const startTime = Date.now();
    logger.info('findImplementation', `${filePath} at ${position.line}:${position.character}`);

    const serverState = await this.getServer(filePath);
    await serverState.initializationPromise;
    await this.ensureFileOpen(serverState, filePath);

    const method = 'textDocument/implementation';
    const timeout =
      serverState.adapter?.getTimeout?.(method) ??
      DEFAULT_METHOD_TIMEOUTS[method] ??
      DEFAULT_TIMEOUT;
    const result = await this.sendRequest(
      serverState.process,
      method,
      {
        textDocument: { uri: pathToUri(filePath) },
        position,
      },
      timeout
    );

    if (Array.isArray(result)) {
      const locations = result.map((loc: LSPLocation) => ({
        uri: loc.uri,
        range: loc.range,
      }));
      logger.info(
        'findImplementation',
        `completed in ${Date.now() - startTime}ms, returned ${locations.length} location(s)`
      );
      return locations;
    }
    if (result && typeof result === 'object' && 'uri' in result) {
      const location = result as LSPLocation;
      logger.info(
        'findImplementation',
        `completed in ${Date.now() - startTime}ms, returned 1 location`
      );
      return [{ uri: location.uri, range: location.range }];
    }

    logger.info(
      'findImplementation',
      `completed in ${Date.now() - startTime}ms, no implementations found`
    );
    return [];
  }

  async prepareCallHierarchy(filePath: string, position: Position): Promise<CallHierarchyItem[]> {
    const startTime = Date.now();
    logger.info('prepareCallHierarchy', `${filePath} at ${position.line}:${position.character}`);

    const serverState = await this.getServer(filePath);
    await serverState.initializationPromise;
    await this.ensureFileOpen(serverState, filePath);

    const method = 'textDocument/prepareCallHierarchy';
    const timeout =
      serverState.adapter?.getTimeout?.(method) ??
      DEFAULT_METHOD_TIMEOUTS[method] ??
      DEFAULT_TIMEOUT;
    const result = await this.sendRequest(
      serverState.process,
      method,
      {
        textDocument: { uri: pathToUri(filePath) },
        position,
      },
      timeout
    );

    if (Array.isArray(result)) {
      const items = result as CallHierarchyItem[];
      logger.info(
        'prepareCallHierarchy',
        `completed in ${Date.now() - startTime}ms, returned ${items.length} item(s)`
      );
      return items;
    }

    logger.info('prepareCallHierarchy', `completed in ${Date.now() - startTime}ms, no items found`);
    return [];
  }

  async incomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]> {
    const startTime = Date.now();
    logger.info('incomingCalls', `Requesting for ${item.name}`);

    // Extract file path from item URI
    const filePath = uriToPath(item.uri);
    const serverState = await this.getServer(filePath);
    await serverState.initializationPromise;

    const method = 'callHierarchy/incomingCalls';
    const timeout =
      serverState.adapter?.getTimeout?.(method) ??
      DEFAULT_METHOD_TIMEOUTS[method] ??
      DEFAULT_TIMEOUT;
    const result = await this.sendRequest(serverState.process, method, { item }, timeout);

    if (Array.isArray(result)) {
      const calls = result as CallHierarchyIncomingCall[];
      logger.info(
        'incomingCalls',
        `completed in ${Date.now() - startTime}ms, returned ${calls.length} call(s)`
      );
      return calls;
    }

    logger.info('incomingCalls', `completed in ${Date.now() - startTime}ms, no calls found`);
    return [];
  }

  async outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]> {
    const startTime = Date.now();
    logger.info('outgoingCalls', `Requesting for ${item.name}`);

    // Extract file path from item URI
    const filePath = uriToPath(item.uri);
    const serverState = await this.getServer(filePath);
    await serverState.initializationPromise;

    const method = 'callHierarchy/outgoingCalls';
    const timeout =
      serverState.adapter?.getTimeout?.(method) ??
      DEFAULT_METHOD_TIMEOUTS[method] ??
      DEFAULT_TIMEOUT;
    const result = await this.sendRequest(serverState.process, method, { item }, timeout);

    if (Array.isArray(result)) {
      const calls = result as CallHierarchyOutgoingCall[];
      logger.info(
        'outgoingCalls',
        `completed in ${Date.now() - startTime}ms, returned ${calls.length} call(s)`
      );
      return calls;
    }

    logger.info('outgoingCalls', `completed in ${Date.now() - startTime}ms, no calls found`);
    return [];
  }

  async preloadServers(debug = true): Promise<void> {
    if (debug) {
      logger.info(
        'preloadServers',
        'Scanning configured server directories for supported file types'
      );
    }

    const serversToStart = new Set<LSPServerConfig>();

    // Scan each server's rootDir for its configured extensions
    for (const serverConfig of this.config.servers) {
      const serverDir = serverConfig.rootDir || process.cwd();

      if (debug) {
        logger.debug(
          'preloadServers',
          `Scanning ${serverDir} for extensions: ${serverConfig.extensions.join(', ')}`
        );
      }

      try {
        const ig = await loadGitignore(serverDir);
        const foundExtensions = await scanDirectoryForExtensions(serverDir, 3, ig, false);

        // Check if any of this server's extensions are found in its rootDir
        const hasMatchingExtensions = serverConfig.extensions.some((ext) =>
          foundExtensions.has(ext)
        );

        if (hasMatchingExtensions) {
          serversToStart.add(serverConfig);
          if (debug) {
            const matchingExts = serverConfig.extensions.filter((ext) => foundExtensions.has(ext));
            logger.debug(
              'preloadServers',
              `Found matching extensions in ${serverDir}: ${matchingExts.join(', ')}`
            );
          }
        }
      } catch (error) {
        if (debug) {
          logger.warn('preloadServers', `Failed to scan ${serverDir}: ${error}`);
        }
      }
    }

    if (debug) {
      logger.info('preloadServers', `Starting ${serversToStart.size} LSP servers...`);
    }

    const startPromises = Array.from(serversToStart).map(async (serverConfig) => {
      try {
        const key = JSON.stringify(serverConfig);
        // Skip if already running or already being started (e.g. by a concurrent getServer call)
        if (this.servers.has(key) || this.serversStarting.has(key)) {
          return;
        }
        if (debug) {
          logger.info('preloadServers', `Preloading LSP server: ${serverConfig.command.join(' ')}`);
        }
        // Register in serversStarting to prevent concurrent getServer from spawning a duplicate
        const startPromise = this.startServer(serverConfig);
        this.serversStarting.set(key, startPromise);
        try {
          const serverState = await startPromise;
          this.servers.set(key, serverState);
          this.serversStarting.delete(key);
          if (debug) {
            logger.info(
              'preloadServers',
              `Successfully preloaded LSP server for extensions: ${serverConfig.extensions.join(', ')}`
            );
          }
        } catch (error) {
          this.serversStarting.delete(key);
          throw error;
        }
      } catch (error) {
        logger.error(
          'preloadServers',
          `Failed to preload LSP server for ${serverConfig.extensions.join(', ')}: ${error}`
        );
      }
    });

    await Promise.all(startPromises);
    if (debug) {
      logger.info('preloadServers', 'LSP server preloading completed');
    }

    // Fire-and-forget: wait for indexing to complete in the background.
    // This gives servers a head start so the first tool call is less likely
    // to hit the "still indexing" early-return.
    if (debug && this.isAnyServerIndexing()) {
      const serverCount = this.servers.size;
      logger.info(
        'preloadServers',
        `Waiting for ${serverCount} server(s) to finish indexing in background...`
      );
      this.waitForAllIndexing(120000).then((allReady) => {
        if (allReady) {
          logger.info('preloadServers', 'All servers finished indexing');
        } else {
          logger.warn('preloadServers', 'Some servers still indexing after 120s');
        }
      });
    }
  }

  /**
   * Check if a server for the given file has active progress tokens (e.g., indexing).
   */
  isIndexing(filePath: string): boolean {
    const serverConfig = this.getServerForFile(filePath);
    if (!serverConfig) return false;
    const key = JSON.stringify(serverConfig);
    const serverState = this.servers.get(key);
    if (!serverState) return false;
    return serverState.progressTokens.size > 0;
  }

  /**
   * Check if any running server has active progress tokens.
   */
  isAnyServerIndexing(): boolean {
    for (const serverState of this.servers.values()) {
      if (serverState.progressTokens.size > 0) return true;
    }
    return false;
  }

  /**
   * Wait for the server handling a file to finish all active progress (e.g., indexing).
   * @returns true if completed, false if timed out
   */
  async waitForIndexing(filePath: string, timeout = 60000): Promise<boolean> {
    const serverState = await this.getServer(filePath);
    return this.waitForServerReady(serverState, timeout);
  }

  /**
   * Wait for all running servers to finish active progress.
   * @returns true if all completed, false if any timed out
   */
  async waitForAllIndexing(timeout = 60000): Promise<boolean> {
    const promises: Promise<boolean>[] = [];
    for (const serverState of this.servers.values()) {
      promises.push(this.waitForServerReady(serverState, timeout));
    }
    if (promises.length === 0) return true;
    const results = await Promise.all(promises);
    return results.every(Boolean);
  }

  private waitForServerReady(serverState: ServerState, timeout: number): Promise<boolean> {
    // readyPromise covers Pyright (probe-based) and any other server
    const readyRace = Promise.race([
      serverState.readyPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeout)),
    ]);

    // If we also have progress tokens, wait for those too
    if (serverState.progressTokens.size === 0) {
      return readyRace;
    }

    const progressWait = new Promise<boolean>((resolve) => {
      const waiter = () => {
        clearTimeout(timeoutId);
        resolve(true);
      };

      const timeoutId = setTimeout(() => {
        const idx = serverState.indexingWaiters.indexOf(waiter);
        if (idx >= 0) serverState.indexingWaiters.splice(idx, 1);
        resolve(false);
      }, timeout);

      serverState.indexingWaiters.push(waiter);
    });

    // Both must complete: readyPromise AND progress tokens
    return Promise.all([readyRace, progressWait]).then(
      ([readyResult, progressResult]) => readyResult && progressResult
    );
  }

  dispose(): void {
    const serverCount = this.servers.size;
    if (serverCount > 0) {
      logger.info('dispose', `Disposing ${serverCount} LSP server(s)...`);
    }

    for (const serverState of this.servers.values()) {
      // Mark as dead to prevent onServerDeath from firing during dispose
      serverState.dead = true;

      // Clear restart timer if exists
      if (serverState.restartTimer) {
        clearTimeout(serverState.restartTimer);
        serverState.restartTimer = undefined;
      }

      const pid = serverState.process.pid;
      const cmd = serverState.config?.command?.[0] || 'unknown';

      try {
        // Kill the process - check killed property if available
        const isAlreadyKilled = 'killed' in serverState.process && serverState.process.killed;
        if (!isAlreadyKilled) {
          // Send SIGKILL directly during dispose to ensure cleanup before process.exit().
          // SIGTERM + delayed SIGKILL doesn't work here because process.exit() cancels
          // pending timers, so the SIGKILL setTimeout would never fire.
          serverState.process.kill('SIGKILL');
          if (pid) {
            logger.info('dispose', `Sent SIGKILL to ${cmd} (PID ${pid})`);
          }
        }
      } catch (error) {
        // Log error but continue disposing other servers
        if (pid) {
          logger.warn('dispose', `Error killing ${cmd} (PID ${pid}): ${error}`);
        }
      }
    }

    this.servers.clear();
    this.serversStarting.clear();
    this.pendingRequests.clear();
  }
}
