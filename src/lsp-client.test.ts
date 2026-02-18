import { beforeEach, describe, expect, it, jest, spyOn } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LSPClient, hasId } from './lsp-client.js';
import { pathToUri, uriToPath } from './utils.js';

// Type for accessing private methods in tests
type LSPClientInternal = {
  startServer: (config: unknown) => Promise<unknown>;
  getServer: (filePath: string) => Promise<{ initializationPromise: Promise<void> }>;
  ensureFileOpen: (filePath: string) => Promise<void>;
  ensureAnyFileOpen: (serverState: unknown) => Promise<boolean>;
  sendRequest: (method: string, params: unknown) => Promise<unknown>;
};

const TEST_DIR = process.env.RUNNER_TEMP
  ? `${process.env.RUNNER_TEMP}/cclsp-test`
  : '/tmp/cclsp-test';

const TEST_CONFIG_PATH = join(TEST_DIR, 'test-config.json');

describe('LSPClient', () => {
  beforeEach(async () => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }

    mkdirSync(TEST_DIR, { recursive: true });

    // Create test config file
    const testConfig = {
      servers: [
        {
          extensions: ['ts', 'js', 'tsx', 'jsx'],
          command: ['npx', '--', 'typescript-language-server', '--stdio'],
          rootDir: '.',
        },
      ],
    };

    const configContent = JSON.stringify(testConfig, null, 2);

    // Use async file operations for better CI compatibility
    await writeFile(TEST_CONFIG_PATH, configContent);

    // Small delay to ensure filesystem consistency
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify file creation with retry logic for CI environments
    let fileExists = existsSync(TEST_CONFIG_PATH);
    let retries = 0;
    while (!fileExists && retries < 10) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      fileExists = existsSync(TEST_CONFIG_PATH);
      retries++;
    }

    if (!fileExists) {
      throw new Error(
        `Failed to create config file at ${TEST_CONFIG_PATH} after ${retries} retries`
      );
    }
  });

  it('should fail to create LSPClient when config file does not exist', () => {
    const stderrSpy = spyOn(process.stderr, 'write');
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    expect(() => {
      new LSPClient('/nonexistent/config.json');
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    // Logger formats as: [timestamp] [LEVEL] [component] message
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load from /nonexistent/config.json')
    );

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('should fail to create LSPClient when no configPath provided', () => {
    const stderrSpy = spyOn(process.stderr, 'write');
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    expect(() => {
      new LSPClient();
    }).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'configPath is required when CCLSP_CONFIG_PATH environment variable is not set'
      )
    );

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('should create LSPClient with valid config file', () => {
    const client = new LSPClient(TEST_CONFIG_PATH);
    expect(client).toBeDefined();
  });

  describe('preloadServers', () => {
    it('should scan directory and find file extensions', async () => {
      // Create test files with different extensions
      await writeFile(join(TEST_DIR, 'test.ts'), 'console.log("test");');
      await writeFile(join(TEST_DIR, 'test.js'), 'console.log("test");');
      await writeFile(join(TEST_DIR, 'test.py'), 'print("test")');

      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock process.stderr.write to capture output
      const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

      // Mock startServer to avoid actually starting LSP servers
      const startServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'startServer'
      ).mockImplementation(async () => ({
        process: { kill: jest.fn() },
        initialized: true,
        openFiles: new Set(),
      }));

      await client.preloadServers(false);

      // Should attempt to start TypeScript server for .ts and .js files
      expect(startServerSpy).toHaveBeenCalled();

      stderrSpy.mockRestore();
      startServerSpy.mockRestore();
    });

    it('should handle missing .gitignore gracefully', async () => {
      // Create test file without .gitignore
      await writeFile(join(TEST_DIR, 'test.ts'), 'console.log("test");');

      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock startServer
      const startServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'startServer'
      ).mockImplementation(async () => ({
        process: { kill: jest.fn() },
        initialized: true,
        openFiles: new Set(),
      }));

      // Should not throw error
      await expect(async () => {
        await client.preloadServers(false);
      }).not.toThrow();

      startServerSpy.mockRestore();
    });

    it.skip('should handle preloading errors gracefully', async () => {
      await writeFile(join(TEST_DIR, 'test.ts'), 'console.log("test");');

      const client = new LSPClient(TEST_CONFIG_PATH);

      const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

      // Mock startServer to throw error
      const startServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'startServer'
      ).mockRejectedValue(new Error('Failed to start server'));

      // Should complete without throwing
      await client.preloadServers(false);

      // Should have logged the error to stderr
      expect(stderrSpy).toHaveBeenCalled();

      startServerSpy.mockRestore();
      stderrSpy.mockRestore();
    });
  });

  describe('initialization promise behavior', () => {
    it.skip('should wait for initialization on first call and pass through on subsequent calls', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      let initResolve: (() => void) | undefined;
      const initPromise = new Promise<void>((resolve) => {
        initResolve = resolve;
      });

      // Mock getServer to return a server state with our controlled promise
      const mockServerState = {
        initializationPromise: initPromise,
        process: { stdin: { write: jest.fn() } },
        initialized: false,
        openFiles: new Set(),
        diagnostics: new Map(),
        lastDiagnosticUpdate: new Map(),
        diagnosticVersions: new Map(),
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      // Mock ensureFileOpen to avoid file operations
      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      // Mock sendRequest to avoid actual LSP communication
      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue([]);

      // Start first call (should wait)
      const firstCallPromise = client.findDefinition('test.ts', {
        line: 0,
        character: 0,
      });

      // Wait a bit to ensure call is waiting
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Resolve initialization
      initResolve?.();

      // Wait for call to complete
      await firstCallPromise;

      // Verify call was made
      expect(sendRequestSpy).toHaveBeenCalled();

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should handle multiple concurrent calls waiting for initialization', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      let initResolve: (() => void) | undefined;
      const initPromise = new Promise<void>((resolve) => {
        initResolve = resolve;
      });

      const mockServerState = {
        initializationPromise: initPromise,
        process: { stdin: { write: jest.fn() } },
        initialized: false,
        openFiles: new Set(),
        diagnostics: new Map(),
        lastDiagnosticUpdate: new Map(),
        diagnosticVersions: new Map(),
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue([]);

      // Start multiple concurrent calls
      const promises = [
        client.findDefinition('test.ts', { line: 0, character: 0 }),
        client.findReferences('test.ts', { line: 1, character: 0 }),
        client.renameSymbol('test.ts', { line: 2, character: 0 }, 'newName'),
      ];

      // Wait a bit to ensure all are waiting
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Resolve initialization - all should proceed
      initResolve?.();

      // All calls should complete successfully
      const results = await Promise.all(promises);
      expect(results).toHaveLength(3);

      // Each method should have been called once
      expect(sendRequestSpy).toHaveBeenCalledTimes(3);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });
  });

  describe('Symbol caching', () => {
    it('should cache document symbols and return cached result on second call', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'testFunction',
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } },
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(['test.ts']),
        fileVersions: new Map([['test.ts', 1]]),
        symbolCache: new Map(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockSymbols);

      // First call should hit LSP
      const result1 = await client.getDocumentSymbols('test.ts');
      expect(result1).toEqual(mockSymbols);
      expect(sendRequestSpy).toHaveBeenCalledTimes(1);

      // Second call should return cached result
      const result2 = await client.getDocumentSymbols('test.ts');
      expect(result2).toEqual(mockSymbols);
      expect(sendRequestSpy).toHaveBeenCalledTimes(1); // Not called again

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should invalidate cache when file version changes', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbolsV1 = [
        {
          name: 'oldFunction',
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 20 } },
        },
      ];

      const mockSymbolsV2 = [
        {
          name: 'newFunction',
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 20 } },
        },
      ];

      const fileVersions = new Map([['test.ts', 1]]);
      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(['test.ts']),
        fileVersions,
        symbolCache: new Map(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      let callCount = 0;
      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockImplementation(async () => {
        callCount++;
        return callCount === 1 ? mockSymbolsV1 : mockSymbolsV2;
      });

      // First call - fetches from LSP
      const result1 = await client.getDocumentSymbols('test.ts');
      expect(result1).toEqual(mockSymbolsV1);
      expect(sendRequestSpy).toHaveBeenCalledTimes(1);

      // Simulate file change (version bump, like syncFileContent does)
      fileVersions.set('test.ts', 2);

      // Second call - cache invalidated, fetches from LSP again
      const result2 = await client.getDocumentSymbols('test.ts');
      expect(result2).toEqual(mockSymbolsV2);
      expect(sendRequestSpy).toHaveBeenCalledTimes(2);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should cache symbols independently per file', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbolsA = [
        {
          name: 'funcA',
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } },
        },
      ];

      const mockSymbolsB = [
        {
          name: 'funcB',
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } },
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(['a.ts', 'b.ts']),
        fileVersions: new Map([
          ['a.ts', 1],
          ['b.ts', 1],
        ]),
        symbolCache: new Map(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      let callCount = 0;
      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockImplementation(async () => {
        callCount++;
        return callCount === 1 ? mockSymbolsA : mockSymbolsB;
      });

      // Fetch symbols for both files
      const resultA = await client.getDocumentSymbols('a.ts');
      const resultB = await client.getDocumentSymbols('b.ts');
      expect(resultA).toEqual(mockSymbolsA);
      expect(resultB).toEqual(mockSymbolsB);
      expect(sendRequestSpy).toHaveBeenCalledTimes(2);

      // Both should be cached now
      const cachedA = await client.getDocumentSymbols('a.ts');
      const cachedB = await client.getDocumentSymbols('b.ts');
      expect(cachedA).toEqual(mockSymbolsA);
      expect(cachedB).toEqual(mockSymbolsB);
      expect(sendRequestSpy).toHaveBeenCalledTimes(2); // No additional calls

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should not cache empty results', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(['test.ts']),
        fileVersions: new Map([['test.ts', 1]]),
        symbolCache: new Map(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      // Return null (non-array) - should not be cached
      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(null);

      const result1 = await client.getDocumentSymbols('test.ts');
      expect(result1).toEqual([]);

      // Should try again since null results aren't cached
      const result2 = await client.getDocumentSymbols('test.ts');
      expect(result2).toEqual([]);
      expect(sendRequestSpy).toHaveBeenCalledTimes(2);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should use cache in findSymbolsByName for repeated lookups', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'testFunction',
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } },
        },
        {
          name: 'testVariable',
          kind: 13,
          range: { start: { line: 3, character: 0 }, end: { line: 3, character: 20 } },
          selectionRange: { start: { line: 3, character: 6 }, end: { line: 3, character: 18 } },
        },
      ];

      // Spy on getDocumentSymbols which is the public method called by findSymbolsByName
      const getDocumentSymbolsSpy = spyOn(client, 'getDocumentSymbols').mockResolvedValue(
        mockSymbols
      );

      // First lookup
      const result1 = await client.findSymbolsByName('test.ts', 'testFunction');
      expect(result1.matches).toHaveLength(1);
      expect(getDocumentSymbolsSpy).toHaveBeenCalledTimes(1);

      // Second lookup for different symbol in same file
      const result2 = await client.findSymbolsByName('test.ts', 'testVariable');
      expect(result2.matches).toHaveLength(1);
      expect(getDocumentSymbolsSpy).toHaveBeenCalledTimes(2);

      getDocumentSymbolsSpy.mockRestore();
    });
  });

  describe('getDocumentSymbols for get_symbols_for_file', () => {
    it('should return hierarchical DocumentSymbol[] with children', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'MyClass',
          kind: 5, // Class
          range: { start: { line: 0, character: 0 }, end: { line: 20, character: 1 } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
          children: [
            {
              name: 'myMethod',
              kind: 6, // Method
              range: { start: { line: 2, character: 2 }, end: { line: 5, character: 3 } },
              selectionRange: {
                start: { line: 2, character: 2 },
                end: { line: 2, character: 10 },
              },
            },
            {
              name: 'myProperty',
              kind: 7, // Property
              range: { start: { line: 1, character: 2 }, end: { line: 1, character: 20 } },
              selectionRange: {
                start: { line: 1, character: 2 },
                end: { line: 1, character: 12 },
              },
            },
          ],
        },
        {
          name: 'helperFunction',
          kind: 12, // Function
          range: { start: { line: 22, character: 0 }, end: { line: 25, character: 1 } },
          selectionRange: {
            start: { line: 22, character: 9 },
            end: { line: 22, character: 23 },
          },
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(['test.ts']),
        fileVersions: new Map([['test.ts', 1]]),
        symbolCache: new Map(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockSymbols);

      const result = await client.getDocumentSymbols('test.ts');

      expect(result).toEqual(mockSymbols);
      expect(result).toHaveLength(2);
      // Verify hierarchical structure is preserved
      const firstSymbol = result[0] as { children?: unknown[] };
      expect(firstSymbol.children).toHaveLength(2);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should return flat SymbolInformation[] format', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'myFunction',
          kind: 12,
          location: {
            uri: 'file:///test.ts',
            range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          },
          containerName: '',
        },
        {
          name: 'myVariable',
          kind: 13,
          location: {
            uri: 'file:///test.ts',
            range: { start: { line: 4, character: 0 }, end: { line: 4, character: 20 } },
          },
          containerName: 'myFunction',
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(['test.ts']),
        fileVersions: new Map([['test.ts', 1]]),
        symbolCache: new Map(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockSymbols);

      const result = await client.getDocumentSymbols('test.ts');

      expect(result).toEqual(mockSymbols);
      expect(result).toHaveLength(2);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });
  });

  describe('Batch definition lookups (find_definitions_batch support)', () => {
    it('should support multiple findSymbolsByName + findDefinition calls efficiently', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbolsFileA = [
        {
          name: 'funcA',
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } },
        },
      ];

      const mockSymbolsFileB = [
        {
          name: 'funcB',
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } },
        },
      ];

      // Mock getDocumentSymbols to return different symbols per file
      const getDocumentSymbolsSpy = spyOn(client, 'getDocumentSymbols').mockImplementation(
        async (filePath: string) => {
          return filePath === 'a.ts' ? mockSymbolsFileA : mockSymbolsFileB;
        }
      );

      // Look up symbols in two different files
      const resultA = await client.findSymbolsByName('a.ts', 'funcA');
      const resultB = await client.findSymbolsByName('b.ts', 'funcB');

      expect(resultA.matches).toHaveLength(1);
      expect(resultA.matches[0]?.name).toBe('funcA');
      expect(resultB.matches).toHaveLength(1);
      expect(resultB.matches[0]?.name).toBe('funcB');

      // getDocumentSymbols was called once per file
      expect(getDocumentSymbolsSpy).toHaveBeenCalledTimes(2);

      getDocumentSymbolsSpy.mockRestore();
    });

    it('should handle mixed results where some symbols are found and others are not', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'existingFunc',
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } },
        },
      ];

      const getDocumentSymbolsSpy = spyOn(client, 'getDocumentSymbols').mockResolvedValue(
        mockSymbols
      );

      // Found
      const result1 = await client.findSymbolsByName('test.ts', 'existingFunc');
      expect(result1.matches).toHaveLength(1);

      // Not found
      const result2 = await client.findSymbolsByName('test.ts', 'nonExistentFunc');
      expect(result2.matches).toHaveLength(0);

      getDocumentSymbolsSpy.mockRestore();
    });
  });

  describe('Symbol kind fallback functionality', () => {
    it('should return fallback results when specified symbol kind not found', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock getDocumentSymbols to return test symbols
      const mockSymbols = [
        {
          name: 'testFunction',
          kind: 12, // Function
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } },
        },
        {
          name: 'testVariable',
          kind: 13, // Variable
          range: { start: { line: 3, character: 0 }, end: { line: 3, character: 20 } },
          selectionRange: { start: { line: 3, character: 6 }, end: { line: 3, character: 18 } },
        },
      ];

      const getDocumentSymbolsSpy = spyOn(client, 'getDocumentSymbols').mockResolvedValue(
        mockSymbols
      );

      // Search for 'testFunction' with kind 'class' (should not match, then fallback to all kinds)
      const result = await client.findSymbolsByName('test.ts', 'testFunction', 'class');

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]?.name).toBe('testFunction');
      expect(result.matches[0]?.kind).toBe(12); // Function
      expect(result.matches[0]?.containerName).toBeUndefined(); // Top-level symbol has no container
      expect(result.warning).toContain('No symbols found with kind "class"');
      expect(result.warning).toContain(
        'Found 1 symbol(s) with name "testFunction" of other kinds: function'
      );

      getDocumentSymbolsSpy.mockRestore();
    });

    it('should return multiple fallback results of different kinds', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock getDocumentSymbols to return symbols with same name but different kinds
      const mockSymbols = [
        {
          name: 'test',
          kind: 12, // Function
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 13 } },
        },
        {
          name: 'test',
          kind: 13, // Variable
          range: { start: { line: 3, character: 0 }, end: { line: 3, character: 15 } },
          selectionRange: { start: { line: 3, character: 6 }, end: { line: 3, character: 10 } },
        },
        {
          name: 'test',
          kind: 5, // Class
          range: { start: { line: 5, character: 0 }, end: { line: 10, character: 1 } },
          selectionRange: { start: { line: 5, character: 6 }, end: { line: 5, character: 10 } },
        },
      ];

      const getDocumentSymbolsSpy = spyOn(client, 'getDocumentSymbols').mockResolvedValue(
        mockSymbols
      );

      // Search for 'test' with kind 'interface' (should not match, then fallback to all kinds)
      const result = await client.findSymbolsByName('test.ts', 'test', 'interface');

      expect(result.matches).toHaveLength(3);
      expect(result.warning).toContain('No symbols found with kind "interface"');
      expect(result.warning).toContain(
        'Found 3 symbol(s) with name "test" of other kinds: function, variable, class'
      );

      getDocumentSymbolsSpy.mockRestore();
    });

    it('should not trigger fallback when correct symbol kind is found', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'testFunction',
          kind: 12, // Function
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } },
        },
        {
          name: 'testVariable',
          kind: 13, // Variable
          range: { start: { line: 3, character: 0 }, end: { line: 3, character: 20 } },
          selectionRange: { start: { line: 3, character: 6 }, end: { line: 3, character: 18 } },
        },
      ];

      const getDocumentSymbolsSpy = spyOn(client, 'getDocumentSymbols').mockResolvedValue(
        mockSymbols
      );

      // Search for 'testFunction' with correct kind 'function'
      const result = await client.findSymbolsByName('test.ts', 'testFunction', 'function');

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]?.name).toBe('testFunction');
      expect(result.matches[0]?.containerName).toBeUndefined(); // Top-level symbol
      expect(result.warning).toBeUndefined(); // No warning expected

      getDocumentSymbolsSpy.mockRestore();
    });

    it('should populate containerName for nested symbols in DocumentSymbol hierarchy', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      // Hierarchical DocumentSymbol[] with class containing a method
      const mockSymbols = [
        {
          name: 'MyClass',
          kind: 5, // Class
          range: { start: { line: 0, character: 0 }, end: { line: 20, character: 1 } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
          children: [
            {
              name: 'myMethod',
              kind: 6, // Method
              range: { start: { line: 2, character: 2 }, end: { line: 5, character: 3 } },
              selectionRange: {
                start: { line: 2, character: 2 },
                end: { line: 2, character: 10 },
              },
            },
            {
              name: 'myProp',
              kind: 7, // Property
              range: { start: { line: 1, character: 2 }, end: { line: 1, character: 20 } },
              selectionRange: {
                start: { line: 1, character: 2 },
                end: { line: 1, character: 8 },
              },
            },
          ],
        },
      ];

      const getDocumentSymbolsSpy = spyOn(client, 'getDocumentSymbols').mockResolvedValue(
        mockSymbols
      );

      // Search for 'myMethod' - should have containerName 'MyClass'
      const result = await client.findSymbolsByName('test.ts', 'myMethod', 'method');

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]?.name).toBe('myMethod');
      expect(result.matches[0]?.containerName).toBe('MyClass');

      // Search for 'MyClass' - top-level, no container
      const classResult = await client.findSymbolsByName('test.ts', 'MyClass', 'class');
      expect(classResult.matches).toHaveLength(1);
      expect(classResult.matches[0]?.containerName).toBeUndefined();

      getDocumentSymbolsSpy.mockRestore();
    });

    it('should return empty results when no symbols found even with fallback', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'otherFunction',
          kind: 12, // Function
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 22 } },
        },
      ];

      const getDocumentSymbolsSpy = spyOn(client, 'getDocumentSymbols').mockResolvedValue(
        mockSymbols
      );

      // Search for non-existent symbol
      const result = await client.findSymbolsByName('test.ts', 'nonExistentSymbol', 'function');

      expect(result.matches).toHaveLength(0);
      expect(result.warning).toBeUndefined(); // No fallback triggered since no name matches found

      getDocumentSymbolsSpy.mockRestore();
    });
  });

  describe('Server restart functionality', () => {
    it('should setup restart timer when restartInterval is configured', () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock setTimeout to verify timer is set
      const setTimeoutSpy = spyOn(global, 'setTimeout').mockImplementation((() => 123) as any);

      const mockServerState = {
        process: { kill: jest.fn() },
        initialized: true,
        initializationPromise: Promise.resolve(),
        openFiles: new Set(),
        startTime: Date.now(),
        config: {
          extensions: ['ts'],
          command: ['echo', 'mock'],
          restartInterval: 0.1, // 0.1 minutes
        },
        restartTimer: undefined,
      };

      try {
        // Call setupRestartTimer directly
        (client as any).setupRestartTimer(mockServerState);

        // Verify setTimeout was called with correct interval (0.1 minutes = 6000ms)
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 6000);
      } finally {
        setTimeoutSpy.mockRestore();
        client.dispose();
      }
    });

    it('should not setup restart timer when restartInterval is not configured', () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock setTimeout to verify timer is NOT set
      const setTimeoutSpy = spyOn(global, 'setTimeout').mockImplementation((() => 123) as any);

      const mockServerState = {
        process: { kill: jest.fn() },
        initialized: true,
        initializationPromise: Promise.resolve(),
        openFiles: new Set(),
        startTime: Date.now(),
        config: {
          extensions: ['ts'],
          command: ['echo', 'mock'],
          // No restartInterval
        },
        restartTimer: undefined,
      };

      try {
        // Call setupRestartTimer directly
        (client as any).setupRestartTimer(mockServerState);

        // Verify setTimeout was NOT called
        expect(setTimeoutSpy).not.toHaveBeenCalled();
      } finally {
        setTimeoutSpy.mockRestore();
        client.dispose();
      }
    });

    it('should clear restart timer when disposing client', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockTimer = setTimeout(() => {}, 1000);
      const mockServerState = {
        process: { kill: jest.fn() },
        restartTimer: mockTimer,
      };

      // Mock servers map to include our test server state
      const serversMap = new Map();
      serversMap.set('test-key', mockServerState);
      (client as any).servers = serversMap;

      const clearTimeoutSpy = spyOn(global, 'clearTimeout');

      client.dispose();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(mockTimer);
      expect(mockServerState.process.kill).toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
    });
  });

  describe('restartServers', () => {
    it('should handle restart request for non-existent extensions', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const result = await client.restartServers(['xyz']);

      expect(result.success).toBe(false);
      expect(result.restarted).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(result.message).toContain('No LSP servers found for extensions');
    });

    it('should handle restart request when no servers are running', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const result = await client.restartServers();

      expect(result.success).toBe(false);
      expect(result.restarted).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(result.message).toBe('No LSP servers are currently running');
    });

    it('should restart servers for specific extensions', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock servers map with running servers
      const mockServerState = {
        process: { kill: jest.fn() },
        config: {
          extensions: ['ts', 'tsx'],
          command: ['typescript-language-server', '--stdio'],
        },
        restartTimer: undefined,
      };

      const serversMap = new Map();
      serversMap.set(JSON.stringify(mockServerState.config), mockServerState);
      (client as any).servers = serversMap;

      // Mock startServer to simulate successful restart
      const startServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'startServer'
      ).mockResolvedValue({
        process: { kill: jest.fn() },
        initialized: true,
        initializationPromise: Promise.resolve(),
        openFiles: new Set(),
        startTime: Date.now(),
        config: mockServerState.config,
      });

      const result = await client.restartServers(['ts']);

      expect(result.success).toBe(true);
      expect(result.restarted).toHaveLength(1);
      expect(result.restarted[0]).toContain('typescript-language-server');
      expect(result.failed).toHaveLength(0);
      expect(mockServerState.process.kill).toHaveBeenCalled();
      expect(startServerSpy).toHaveBeenCalledWith(mockServerState.config);

      startServerSpy.mockRestore();
    });

    it('should restart all servers when no extensions specified', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock multiple servers
      const mockServer1 = {
        process: { kill: jest.fn() },
        config: {
          extensions: ['ts', 'tsx'],
          command: ['typescript-language-server', '--stdio'],
        },
        restartTimer: undefined,
      };

      const mockServer2 = {
        process: { kill: jest.fn() },
        config: {
          extensions: ['py'],
          command: ['pylsp'],
        },
        restartTimer: undefined,
      };

      const serversMap = new Map();
      serversMap.set(JSON.stringify(mockServer1.config), mockServer1);
      serversMap.set(JSON.stringify(mockServer2.config), mockServer2);
      (client as any).servers = serversMap;

      // Mock startServer
      const startServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'startServer'
      ).mockResolvedValue({
        process: { kill: jest.fn() },
        initialized: true,
        initializationPromise: Promise.resolve(),
        openFiles: new Set(),
        startTime: Date.now(),
        config: mockServer1.config,
      });

      const result = await client.restartServers();

      expect(result.success).toBe(true);
      expect(result.restarted).toHaveLength(2);
      expect(result.failed).toHaveLength(0);
      expect(mockServer1.process.kill).toHaveBeenCalled();
      expect(mockServer2.process.kill).toHaveBeenCalled();
      expect(startServerSpy).toHaveBeenCalledTimes(2);

      startServerSpy.mockRestore();
    });

    it('should handle partial restart failures', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServer1 = {
        process: { kill: jest.fn() },
        config: {
          extensions: ['ts'],
          command: ['typescript-language-server', '--stdio'],
        },
        restartTimer: undefined,
      };

      const mockServer2 = {
        process: { kill: jest.fn() },
        config: {
          extensions: ['py'],
          command: ['pylsp'],
        },
        restartTimer: undefined,
      };

      const serversMap = new Map();
      serversMap.set(JSON.stringify(mockServer1.config), mockServer1);
      serversMap.set(JSON.stringify(mockServer2.config), mockServer2);
      (client as any).servers = serversMap;

      let callCount = 0;
      const startServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'startServer'
      ).mockImplementation(async (config) => {
        callCount++;
        if (callCount === 1) {
          return {
            process: { kill: jest.fn() },
            initialized: true,
            initializationPromise: Promise.resolve(),
            openFiles: new Set(),
            startTime: Date.now(),
            config,
          };
        }
        throw new Error('Failed to start server');
      });

      const result = await client.restartServers();

      expect(result.success).toBe(false);
      expect(result.restarted).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.message).toContain('Restarted 1 server(s), but 1 failed');

      startServerSpy.mockRestore();
    });

    it('should clear restart timer before restarting', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockTimer = setTimeout(() => {}, 1000);
      const mockServerState = {
        process: { kill: jest.fn() },
        config: {
          extensions: ['ts'],
          command: ['typescript-language-server', '--stdio'],
        },
        restartTimer: mockTimer,
      };

      const serversMap = new Map();
      serversMap.set(JSON.stringify(mockServerState.config), mockServerState);
      (client as any).servers = serversMap;

      const clearTimeoutSpy = spyOn(global, 'clearTimeout');
      const startServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'startServer'
      ).mockResolvedValue({
        process: { kill: jest.fn() },
        initialized: true,
        initializationPromise: Promise.resolve(),
        openFiles: new Set(),
        startTime: Date.now(),
        config: mockServerState.config,
      });

      await client.restartServers(['ts']);

      expect(clearTimeoutSpy).toHaveBeenCalledWith(mockTimer);

      clearTimeoutSpy.mockRestore();
      startServerSpy.mockRestore();
    });
  });

  describe('getDiagnostics', () => {
    it('should return diagnostics when server supports textDocument/diagnostic', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockDiagnostics = [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 10 },
          },
          severity: 1, // Error
          message: 'Test error message',
          source: 'test',
        },
        {
          range: {
            start: { line: 5, character: 2 },
            end: { line: 5, character: 8 },
          },
          severity: 2, // Warning
          message: 'Test warning message',
          source: 'test',
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        diagnostics: new Map(),
        lastDiagnosticUpdate: new Map(),
        diagnosticVersions: new Map(),
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue({
        kind: 'full',
        items: mockDiagnostics,
      });

      const result = await client.getDiagnostics('/test.ts');

      expect(result).toEqual(mockDiagnostics);
      expect(sendRequestSpy).toHaveBeenCalledWith(
        mockServerState.process,
        'textDocument/diagnostic',
        {
          textDocument: { uri: pathToUri('/test.ts') },
        }
      );

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should return empty array for unchanged report', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        diagnostics: new Map(),
        lastDiagnosticUpdate: new Map(),
        diagnosticVersions: new Map(),
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue({
        kind: 'unchanged',
        resultId: 'test-result-id',
      });

      const result = await client.getDiagnostics('/test.ts');

      expect(result).toEqual([]);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should return cached diagnostics from publishDiagnostics', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockDiagnostics = [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 10 },
          },
          severity: 1,
          message: 'Cached error',
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        diagnostics: new Map([[pathToUri('/test.ts'), mockDiagnostics]]),
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);
      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);
      const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

      const result = await client.getDiagnostics('/test.ts');

      expect(result).toEqual(mockDiagnostics);
      // Logger formats as: [timestamp] [LEVEL] [component] message
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('returning 1 cached diagnostics')
      );

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      stderrSpy.mockRestore();
    });

    it('should handle server not supporting textDocument/diagnostic', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        diagnostics: new Map(),
        lastDiagnosticUpdate: new Map(),
        diagnosticVersions: new Map(),
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockRejectedValue(new Error('Method not found'));

      const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

      const result = await client.getDiagnostics('/test.ts');

      expect(result).toEqual([]);
      // Logger formats as: [timestamp] [LEVEL] [component] message
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('textDocument/diagnostic not supported or failed')
      );

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
      stderrSpy.mockRestore();
    });

    it('should handle unexpected response format', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        diagnostics: new Map(),
        lastDiagnosticUpdate: new Map(),
        diagnosticVersions: new Map(),
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue({ unexpected: 'response' });

      const result = await client.getDiagnostics('/test.ts');

      expect(result).toEqual([]);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });
  });

  describe('hover', () => {
    it('should return hover information when available', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockHoverResult = {
        contents: 'function test(): void',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 10 },
        },
      };

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockHoverResult);

      const result = await client.hover('/test.ts', { line: 0, character: 5 });

      expect(result).toEqual(mockHoverResult);
      expect(sendRequestSpy).toHaveBeenCalledWith(
        mockServerState.process,
        'textDocument/hover',
        {
          textDocument: { uri: pathToUri('/test.ts') },
          position: { line: 0, character: 5 },
        },
        30000
      );

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should return null when no hover information available', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(null);

      const result = await client.hover('/test.ts', { line: 0, character: 5 });

      expect(result).toBeNull();

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });
  });

  describe('workspaceSymbol', () => {
    it('should return symbols matching query', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'testFunction',
          kind: 12, // Function
          location: {
            uri: pathToUri('/test.ts'),
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 20 },
            },
          },
        },
        {
          name: 'testClass',
          kind: 5, // Class
          location: {
            uri: pathToUri('/test.ts'),
            range: {
              start: { line: 10, character: 0 },
              end: { line: 10, character: 15 },
            },
          },
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(['test.ts']),
        config: { extensions: ['ts'], command: ['test'] },
        adapter: undefined,
      };

      // Mock servers map
      (client as any).servers = new Map([['test-key', mockServerState]]);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockSymbols);

      const result = await client.workspaceSymbol('test');

      expect(result).toEqual(mockSymbols);
      expect(sendRequestSpy).toHaveBeenCalledWith(
        mockServerState.process,
        'workspace/symbol',
        { query: 'test' },
        30000
      );

      sendRequestSpy.mockRestore();
    });

    it('should return empty array when no servers running', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock empty servers map
      (client as any).servers = new Map();

      const result = await client.workspaceSymbol('test');

      expect(result).toEqual([]);
    });

    it('should return empty array when result is not an array', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(['test.ts']),
        config: { extensions: ['ts'], command: ['test'] },
        adapter: undefined,
      };

      (client as any).servers = new Map([['test-key', mockServerState]]);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(null);

      const result = await client.workspaceSymbol('test');

      expect(result).toEqual([]);

      sendRequestSpy.mockRestore();
    });

    it('should open a file first when no files are open (tsserver project context)', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'testFunction',
          kind: 12,
          location: {
            uri: pathToUri('/test.ts'),
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
          },
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set<string>(), // Empty - no files open
        config: { extensions: ['ts'], command: ['test'] },
        adapter: undefined,
      };

      (client as any).servers = new Map([['test-key', mockServerState]]);

      // Mock ensureAnyFileOpen to track that it was called
      const ensureAnyFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureAnyFileOpen'
      ).mockResolvedValue(true);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockSymbols);

      const result = await client.workspaceSymbol('test');

      expect(result).toEqual(mockSymbols);
      expect(ensureAnyFileOpenSpy).toHaveBeenCalledTimes(1);

      ensureAnyFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should skip opening a file when files are already open', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'testFunction',
          kind: 12,
          location: {
            uri: pathToUri('/test.ts'),
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
          },
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(['test.ts']), // Has an open file
        config: { extensions: ['ts'], command: ['test'] },
        adapter: undefined,
      };

      (client as any).servers = new Map([['test-key', mockServerState]]);

      const ensureAnyFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureAnyFileOpen'
      ).mockResolvedValue(true);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockSymbols);

      const result = await client.workspaceSymbol('test');

      expect(result).toEqual(mockSymbols);
      expect(ensureAnyFileOpenSpy).not.toHaveBeenCalled();

      ensureAnyFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });
  });

  describe('workspaceSymbol with kind filtering (find_symbol_anywhere support)', () => {
    it('should return symbols filterable by kind using symbolKindToString', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'MyClass',
          kind: 5, // Class
          location: {
            uri: pathToUri('/models.ts'),
            range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
          },
        },
        {
          name: 'myFunction',
          kind: 12, // Function
          location: {
            uri: pathToUri('/utils.ts'),
            range: { start: { line: 5, character: 0 }, end: { line: 8, character: 1 } },
          },
        },
        {
          name: 'myVariable',
          kind: 13, // Variable
          location: {
            uri: pathToUri('/config.ts'),
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
          },
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(['test.ts']),
        config: { extensions: ['ts'], command: ['test'] },
        adapter: undefined,
      };

      (client as any).servers = new Map([['test-key', mockServerState]]);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockSymbols);

      const result = await client.workspaceSymbol('my');

      // Simulate kind filtering as the tool handler does
      const filtered = result.filter((sym) => client.symbolKindToString(sym.kind) === 'class');
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.name).toBe('MyClass');

      const functions = result.filter((sym) => client.symbolKindToString(sym.kind) === 'function');
      expect(functions).toHaveLength(1);
      expect(functions[0]?.name).toBe('myFunction');

      sendRequestSpy.mockRestore();
    });

    it('should support exact name matching from workspace symbol results', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'handleRequest',
          kind: 12,
          location: {
            uri: pathToUri('/handler.ts'),
            range: { start: { line: 10, character: 0 }, end: { line: 20, character: 1 } },
          },
        },
        {
          name: 'handleRequestError',
          kind: 12,
          location: {
            uri: pathToUri('/handler.ts'),
            range: { start: { line: 25, character: 0 }, end: { line: 30, character: 1 } },
          },
        },
        {
          name: 'handleRequestTimeout',
          kind: 12,
          location: {
            uri: pathToUri('/handler.ts'),
            range: { start: { line: 35, character: 0 }, end: { line: 40, character: 1 } },
          },
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(['test.ts']),
        config: { extensions: ['ts'], command: ['test'] },
        adapter: undefined,
      };

      (client as any).servers = new Map([['test-key', mockServerState]]);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockSymbols);

      const result = await client.workspaceSymbol('handleRequest');
      expect(result).toHaveLength(3); // workspace/symbol returns partial matches

      // Simulate exact name filtering as the tool handler does
      const exactMatches = result.filter((sym) => sym.name === 'handleRequest');
      expect(exactMatches).toHaveLength(1);
      expect(exactMatches[0]?.name).toBe('handleRequest');

      sendRequestSpy.mockRestore();
    });

    it('should include containerName in results for scoped symbols', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'render',
          kind: 6, // Method
          location: {
            uri: pathToUri('/component.ts'),
            range: { start: { line: 15, character: 2 }, end: { line: 20, character: 3 } },
          },
          containerName: 'MyComponent',
        },
        {
          name: 'render',
          kind: 6,
          location: {
            uri: pathToUri('/widget.ts'),
            range: { start: { line: 8, character: 2 }, end: { line: 12, character: 3 } },
          },
          containerName: 'Widget',
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(['test.ts']),
        config: { extensions: ['ts'], command: ['test'] },
        adapter: undefined,
      };

      (client as any).servers = new Map([['test-key', mockServerState]]);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockSymbols);

      const result = await client.workspaceSymbol('render');
      expect(result).toHaveLength(2);
      expect(result[0]?.containerName).toBe('MyComponent');
      expect(result[1]?.containerName).toBe('Widget');

      sendRequestSpy.mockRestore();
    });
  });

  describe('findImplementation', () => {
    it('should return array of implementation locations', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockLocations = [
        {
          uri: pathToUri('/impl1.ts'),
          range: {
            start: { line: 5, character: 0 },
            end: { line: 5, character: 20 },
          },
        },
        {
          uri: pathToUri('/impl2.ts'),
          range: {
            start: { line: 10, character: 0 },
            end: { line: 10, character: 25 },
          },
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockLocations);

      const result = await client.findImplementation('/test.ts', { line: 0, character: 5 });

      expect(result).toEqual(mockLocations);
      expect(sendRequestSpy).toHaveBeenCalledWith(
        mockServerState.process,
        'textDocument/implementation',
        {
          textDocument: { uri: pathToUri('/test.ts') },
          position: { line: 0, character: 5 },
        },
        30000
      );

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should return single location when result is object', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockLocation = {
        uri: pathToUri('/impl.ts'),
        range: {
          start: { line: 5, character: 0 },
          end: { line: 5, character: 20 },
        },
      };

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockLocation);

      const result = await client.findImplementation('/test.ts', { line: 0, character: 5 });

      expect(result).toEqual([mockLocation]);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should return empty array when no implementations found', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(null);

      const result = await client.findImplementation('/test.ts', { line: 0, character: 5 });

      expect(result).toEqual([]);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });
  });

  describe('prepareCallHierarchy', () => {
    it('should return call hierarchy items', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItems = [
        {
          name: 'testFunction',
          kind: 12, // Function
          uri: pathToUri('/test.ts'),
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 20 },
          },
          selectionRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 12 },
          },
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockItems);

      const result = await client.prepareCallHierarchy('/test.ts', { line: 0, character: 5 });

      expect(result).toEqual(mockItems);
      expect(sendRequestSpy).toHaveBeenCalledWith(
        mockServerState.process,
        'textDocument/prepareCallHierarchy',
        {
          textDocument: { uri: pathToUri('/test.ts') },
          position: { line: 0, character: 5 },
        },
        30000
      );

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should return empty array when no items found', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        openFiles: new Set(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(null);

      const result = await client.prepareCallHierarchy('/test.ts', { line: 0, character: 5 });

      expect(result).toEqual([]);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });
  });

  describe('incomingCalls', () => {
    it('should return incoming calls using uriToPath', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItem = {
        name: 'testFunction',
        kind: 12, // Function
        uri: pathToUri('/test.ts'),
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 20 },
        },
        selectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 12 },
        },
      };

      const mockIncomingCalls = [
        {
          from: {
            name: 'caller1',
            kind: 12,
            uri: pathToUri('/caller1.ts'),
            range: {
              start: { line: 5, character: 0 },
              end: { line: 5, character: 10 },
            },
            selectionRange: {
              start: { line: 5, character: 0 },
              end: { line: 5, character: 7 },
            },
          },
          fromRanges: [
            {
              start: { line: 5, character: 0 },
              end: { line: 5, character: 10 },
            },
          ],
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockIncomingCalls);

      const result = await client.incomingCalls(mockItem);

      expect(result).toEqual(mockIncomingCalls);
      expect(getServerSpy).toHaveBeenCalledWith(uriToPath(mockItem.uri));
      expect(sendRequestSpy).toHaveBeenCalledWith(
        mockServerState.process,
        'callHierarchy/incomingCalls',
        { item: mockItem },
        30000
      );

      getServerSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should return empty array when no incoming calls', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItem = {
        name: 'testFunction',
        kind: 12,
        uri: pathToUri('/test.ts'),
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 20 },
        },
        selectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 12 },
        },
      };

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(null);

      const result = await client.incomingCalls(mockItem);

      expect(result).toEqual([]);
      expect(getServerSpy).toHaveBeenCalledWith(uriToPath(mockItem.uri));

      getServerSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });
  });

  describe('outgoingCalls', () => {
    it('should return outgoing calls using uriToPath', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItem = {
        name: 'testFunction',
        kind: 12, // Function
        uri: pathToUri('/test.ts'),
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 20 },
        },
        selectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 12 },
        },
      };

      const mockOutgoingCalls = [
        {
          to: {
            name: 'callee1',
            kind: 12,
            uri: pathToUri('/callee1.ts'),
            range: {
              start: { line: 10, character: 0 },
              end: { line: 10, character: 15 },
            },
            selectionRange: {
              start: { line: 10, character: 0 },
              end: { line: 10, character: 7 },
            },
          },
          fromRanges: [
            {
              start: { line: 5, character: 0 },
              end: { line: 5, character: 10 },
            },
          ],
        },
      ];

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(mockOutgoingCalls);

      const result = await client.outgoingCalls(mockItem);

      expect(result).toEqual(mockOutgoingCalls);
      expect(getServerSpy).toHaveBeenCalledWith(uriToPath(mockItem.uri));
      expect(sendRequestSpy).toHaveBeenCalledWith(
        mockServerState.process,
        'callHierarchy/outgoingCalls',
        { item: mockItem },
        30000
      );

      getServerSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });

    it('should return empty array when no outgoing calls', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItem = {
        name: 'testFunction',
        kind: 12,
        uri: pathToUri('/test.ts'),
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 20 },
        },
        selectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 12 },
        },
      };

      const mockServerState = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue(null);

      const result = await client.outgoingCalls(mockItem);

      expect(result).toEqual([]);
      expect(getServerSpy).toHaveBeenCalledWith(uriToPath(mockItem.uri));

      getServerSpy.mockRestore();
      sendRequestSpy.mockRestore();
    });
  });

  describe('moveFile', () => {
    const srcFile = join(TEST_DIR, 'move-src.ts');
    const destFile = join(TEST_DIR, 'move-dest.ts');
    const destInSubdir = join(TEST_DIR, 'subdir', 'move-dest.ts');

    beforeEach(async () => {
      await writeFile(srcFile, 'export const x = 1;');
      // Ensure dest doesn't exist
      if (existsSync(destFile)) rmSync(destFile);
      if (existsSync(destInSubdir)) rmSync(destInSubdir, { recursive: true });
    });

    it('should throw when source file does not exist', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      (client as any).servers = new Map();

      await expect(client.moveFile('/nonexistent/file.ts', destFile)).rejects.toThrow(
        'Source file does not exist'
      );
    });

    it('should throw when source is a directory', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      (client as any).servers = new Map();

      await expect(client.moveFile(TEST_DIR, destFile)).rejects.toThrow('Source is a directory');
    });

    it('should throw when destination already exists', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      (client as any).servers = new Map();

      // Create dest file
      writeFileSync(destFile, 'existing');

      await expect(client.moveFile(srcFile, destFile)).rejects.toThrow(
        'Destination already exists'
      );

      rmSync(destFile);
    });

    it('should move file and warn when no servers support willRenameFiles', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        process: { stdin: { write: jest.fn() } },
        config: { extensions: ['ts'], command: ['typescript-language-server', '--stdio'] },
        initializationPromise: Promise.resolve(),
        openFiles: new Set<string>(),
        fileVersions: new Map<string, number>(),
        symbolCache: new Map(),
        diagnostics: new Map(),
        lastDiagnosticUpdate: new Map(),
        diagnosticVersions: new Map(),
        serverCapabilities: {}, // No fileOperations support
      };

      (client as any).servers = new Map([['ts-key', mockServerState]]);

      // Mock getServer + ensureFileOpen for the post-move open
      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);
      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const result = await client.moveFile(srcFile, destFile);

      expect(result.moved).toBe(true);
      expect(result.importChanges).toBeNull();
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('does not support willRenameFiles');

      // Verify file was actually moved
      expect(existsSync(srcFile)).toBe(false);
      expect(existsSync(destFile)).toBe(true);

      getServerSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
    });

    it('should return preview in dry run mode without moving file', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        process: { stdin: { write: jest.fn() } },
        config: { extensions: ['ts'], command: ['typescript-language-server', '--stdio'] },
        initializationPromise: Promise.resolve(),
        openFiles: new Set<string>(),
        fileVersions: new Map<string, number>(),
        symbolCache: new Map(),
        diagnostics: new Map(),
        lastDiagnosticUpdate: new Map(),
        diagnosticVersions: new Map(),
        serverCapabilities: {
          workspace: {
            fileOperations: {
              willRename: { filters: [{ pattern: { glob: '**/*.ts' } }] },
            },
          },
        },
        adapter: undefined,
      };

      (client as any).servers = new Map([['ts-key', mockServerState]]);

      // Mock sendRequest to return a workspace edit
      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue({
        changes: {
          [pathToUri(join(TEST_DIR, 'other.ts'))]: [
            {
              range: { start: { line: 0, character: 20 }, end: { line: 0, character: 35 } },
              newText: './move-dest',
            },
          ],
        },
      });

      const result = await client.moveFile(srcFile, destFile, true);

      expect(result.moved).toBe(false);
      expect(result.importChanges).not.toBeNull();
      // File should NOT have moved
      expect(existsSync(srcFile)).toBe(true);
      expect(existsSync(destFile)).toBe(false);

      sendRequestSpy.mockRestore();
    });

    it('should move file with import updates from supporting server', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      // Create a file that "imports" the source
      const importingFile = join(TEST_DIR, 'importer.ts');
      writeFileSync(importingFile, "import { x } from './move-src';");

      const mockServerState = {
        process: { stdin: { write: jest.fn() } },
        config: { extensions: ['ts'], command: ['typescript-language-server', '--stdio'] },
        initializationPromise: Promise.resolve(),
        openFiles: new Set<string>([srcFile]),
        fileVersions: new Map<string, number>([[srcFile, 1]]),
        symbolCache: new Map(),
        diagnostics: new Map(),
        lastDiagnosticUpdate: new Map(),
        diagnosticVersions: new Map(),
        serverCapabilities: {
          workspace: {
            fileOperations: {
              willRename: { filters: [{ pattern: { glob: '**/*.ts' } }] },
              didRename: { filters: [{ pattern: { glob: '**/*.ts' } }] },
            },
          },
        },
        adapter: undefined,
      };

      (client as any).servers = new Map([['ts-key', mockServerState]]);

      // Mock sendRequest for willRenameFiles — return edit to update the import
      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockResolvedValue({
        changes: {
          [pathToUri(importingFile)]: [
            {
              range: { start: { line: 0, character: 18 }, end: { line: 0, character: 30 } },
              newText: "'./move-dest'",
            },
          ],
        },
      });

      // Mock getServer + ensureFileOpen for the post-move open
      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);
      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const result = await client.moveFile(srcFile, destFile);

      expect(result.moved).toBe(true);
      expect(result.importChanges).not.toBeNull();
      expect(result.warnings).toHaveLength(0);

      // Verify file was moved
      expect(existsSync(srcFile)).toBe(false);
      expect(existsSync(destFile)).toBe(true);

      // Verify old file was removed from server tracking
      expect(mockServerState.openFiles.has(srcFile)).toBe(false);

      getServerSpy.mockRestore();
      sendRequestSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();

      // Clean up
      rmSync(importingFile);
    });

    it('should create destination directory if it does not exist', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      (client as any).servers = new Map();

      // Mock getServer to throw (no server for extension - that's fine)
      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockRejectedValue(new Error('no server'));

      const result = await client.moveFile(srcFile, destInSubdir);

      expect(result.moved).toBe(true);
      expect(existsSync(srcFile)).toBe(false);
      expect(existsSync(destInSubdir)).toBe(true);

      getServerSpy.mockRestore();
      rmSync(join(TEST_DIR, 'subdir'), { recursive: true });
    });

    it('should handle willRenameFiles request failure gracefully', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockServerState = {
        process: { stdin: { write: jest.fn() } },
        config: { extensions: ['ts'], command: ['typescript-language-server', '--stdio'] },
        initializationPromise: Promise.resolve(),
        openFiles: new Set<string>(),
        fileVersions: new Map<string, number>(),
        symbolCache: new Map(),
        diagnostics: new Map(),
        lastDiagnosticUpdate: new Map(),
        diagnosticVersions: new Map(),
        serverCapabilities: {
          workspace: {
            fileOperations: {
              willRename: { filters: [{ pattern: { glob: '**/*.ts' } }] },
            },
          },
        },
        adapter: undefined,
      };

      (client as any).servers = new Map([['ts-key', mockServerState]]);

      // Mock sendRequest to throw
      const sendRequestSpy = spyOn(
        client as unknown as LSPClientInternal,
        'sendRequest'
      ).mockRejectedValue(new Error('Server timeout'));

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);
      const ensureFileOpenSpy = spyOn(
        client as unknown as LSPClientInternal,
        'ensureFileOpen'
      ).mockResolvedValue(undefined);

      const result = await client.moveFile(srcFile, destFile);

      // File should still be moved even though willRenameFiles failed
      expect(result.moved).toBe(true);
      expect(result.importChanges).toBeNull();
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('Failed to get import updates');

      expect(existsSync(srcFile)).toBe(false);
      expect(existsSync(destFile)).toBe(true);

      getServerSpy.mockRestore();
      sendRequestSpy.mockRestore();
      ensureFileOpenSpy.mockRestore();
    });
  });
});

describe('hasId', () => {
  it('should return true for id=1 (typical client request id)', () => {
    expect(hasId({ id: 1 })).toBe(true);
  });

  it('should return true for id=0 (common server-initiated request id)', () => {
    // This is the critical case: pyright/basedpyright starts server request IDs at 0.
    // Previously, id=0 was treated as falsy, causing server requests to be silently
    // dropped, which hung the server and caused rename timeouts.
    expect(hasId({ id: 0 })).toBe(true);
  });

  it('should return false for undefined id (notifications)', () => {
    expect(hasId({})).toBe(false);
    expect(hasId({ id: undefined })).toBe(false);
  });

  it('should return false for null id', () => {
    expect(hasId({ id: null })).toBe(false);
  });

  it('should return true for negative ids', () => {
    expect(hasId({ id: -1 })).toBe(true);
  });
});
