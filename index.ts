#!/usr/bin/env node

import { resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { applyWorkspaceEdit } from './src/file-editor.js';
import { LSPClient } from './src/lsp-client.js';
import { formatLocationWithContext, uriToPath } from './src/utils.js';

// Handle subcommands
const args = process.argv.slice(2);
if (args.length > 0) {
  const subcommand = args[0];

  if (subcommand === 'setup') {
    const { main } = await import('./src/setup.js');
    await main();
    process.exit(0);
  } else {
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error('Available subcommands:');
    console.error('  setup    Configure cclsp for your project');
    console.error('');
    console.error('Run without arguments to start the MCP server.');
    process.exit(1);
  }
}

const lspClient = new LSPClient();

const server = new Server(
  {
    name: 'cclsp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'find_definition',
        description:
          'Find the definition of a symbol by name and kind in a file. Returns definitions for all matching symbols, including container context when available. Optionally includes source code context around results.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The path to the file',
            },
            symbol_name: {
              type: 'string',
              description: 'The name of the symbol',
            },
            symbol_kind: {
              type: 'string',
              description: 'The kind of symbol (function, class, variable, method, etc.)',
            },
            include_context: {
              type: 'boolean',
              description:
                'If true, include source code context around each result location (default: false)',
              default: false,
            },
            context_lines: {
              type: 'number',
              description:
                'Number of lines of context to include before and after the target line (default: 2)',
              default: 2,
            },
          },
          required: ['file_path', 'symbol_name'],
        },
      },
      {
        name: 'find_references',
        description:
          'Find all references to a symbol across the entire workspace. Returns references for all matching symbols, including container context when available. Optionally includes source code context around results.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The path to the file where the symbol is defined',
            },
            symbol_name: {
              type: 'string',
              description: 'The name of the symbol',
            },
            symbol_kind: {
              type: 'string',
              description: 'The kind of symbol (function, class, variable, method, etc.)',
            },
            include_declaration: {
              type: 'boolean',
              description: 'Whether to include the declaration',
              default: true,
            },
            include_context: {
              type: 'boolean',
              description:
                'If true, include source code context around each result location (default: false)',
              default: false,
            },
            context_lines: {
              type: 'number',
              description:
                'Number of lines of context to include before and after the target line (default: 2)',
              default: 2,
            },
          },
          required: ['file_path', 'symbol_name'],
        },
      },
      {
        name: 'rename_symbol',
        description:
          'Rename a symbol by name and kind in a file. If multiple symbols match, returns candidate positions (with container context) and suggests using rename_symbol_strict. By default, this will apply the rename to the files. Use dry_run to preview changes without applying them.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The path to the file',
            },
            symbol_name: {
              type: 'string',
              description: 'The name of the symbol',
            },
            symbol_kind: {
              type: 'string',
              description: 'The kind of symbol (function, class, variable, method, etc.)',
            },
            new_name: {
              type: 'string',
              description: 'The new name for the symbol',
            },
            dry_run: {
              type: 'boolean',
              description:
                'If true, only preview the changes without applying them (default: false)',
            },
          },
          required: ['file_path', 'symbol_name', 'new_name'],
        },
      },
      {
        name: 'rename_symbol_strict',
        description:
          'Rename a symbol at a specific position in a file. Use this when rename_symbol returns multiple candidates. By default, this will apply the rename to the files. Use dry_run to preview changes without applying them.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The path to the file',
            },
            line: {
              type: 'number',
              description: 'The line number (1-indexed)',
            },
            character: {
              type: 'number',
              description: 'The character position in the line (1-indexed)',
            },
            new_name: {
              type: 'string',
              description: 'The new name for the symbol',
            },
            dry_run: {
              type: 'boolean',
              description:
                'If true, only preview the changes without applying them (default: false)',
            },
          },
          required: ['file_path', 'line', 'character', 'new_name'],
        },
      },
      {
        name: 'get_diagnostics',
        description:
          'Get language diagnostics (errors, warnings, hints) for a file. Uses LSP textDocument/diagnostic to pull current diagnostics.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The path to the file to get diagnostics for',
            },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'restart_server',
        description:
          'Manually restart LSP servers. Can restart servers for specific file extensions or all running servers.',
        inputSchema: {
          type: 'object',
          properties: {
            extensions: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Array of file extensions to restart servers for (e.g., ["ts", "tsx"]). If not provided, all servers will be restarted.',
            },
          },
        },
      },
      {
        name: 'get_hover',
        description:
          'Get hover information (documentation, type info) for a symbol at a specific position in a file.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The path to the file',
            },
            line: {
              type: 'number',
              description: 'The line number (1-indexed)',
            },
            character: {
              type: 'number',
              description: 'The character position in the line (1-indexed)',
            },
          },
          required: ['file_path', 'line', 'character'],
        },
      },
      {
        name: 'find_workspace_symbols',
        description:
          'Search for symbols across the entire workspace by name. Returns matching symbols from all files. Optionally includes source code context around results.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The symbol name or pattern to search for',
            },
            include_context: {
              type: 'boolean',
              description:
                'If true, include source code context around each result location (default: false)',
              default: false,
            },
            context_lines: {
              type: 'number',
              description:
                'Number of lines of context to include before and after the target line (default: 2)',
              default: 2,
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'find_implementation',
        description:
          'Find implementations of an interface or abstract method. Returns locations of all implementations. Optionally includes source code context around results.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The path to the file',
            },
            line: {
              type: 'number',
              description: 'The line number (1-indexed)',
            },
            character: {
              type: 'number',
              description: 'The character position in the line (1-indexed)',
            },
            include_context: {
              type: 'boolean',
              description:
                'If true, include source code context around each result location (default: false)',
              default: false,
            },
            context_lines: {
              type: 'number',
              description:
                'Number of lines of context to include before and after the target line (default: 2)',
              default: 2,
            },
          },
          required: ['file_path', 'line', 'character'],
        },
      },
      {
        name: 'prepare_call_hierarchy',
        description:
          'Get call hierarchy item at a position. Use this to prepare for incoming_calls or outgoing_calls.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The path to the file',
            },
            line: {
              type: 'number',
              description: 'The line number (1-indexed)',
            },
            character: {
              type: 'number',
              description: 'The character position in the line (1-indexed)',
            },
          },
          required: ['file_path', 'line', 'character'],
        },
      },
      {
        name: 'get_incoming_calls',
        description:
          'Find all functions/methods that call the function at a position. Requires prepare_call_hierarchy first. Optionally includes source code context around results.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The path to the file',
            },
            line: {
              type: 'number',
              description: 'The line number (1-indexed)',
            },
            character: {
              type: 'number',
              description: 'The character position in the line (1-indexed)',
            },
            include_context: {
              type: 'boolean',
              description:
                'If true, include source code context around each result location (default: false)',
              default: false,
            },
            context_lines: {
              type: 'number',
              description:
                'Number of lines of context to include before and after the target line (default: 2)',
              default: 2,
            },
          },
          required: ['file_path', 'line', 'character'],
        },
      },
      {
        name: 'get_outgoing_calls',
        description:
          'Find all functions/methods called by the function at a position. Requires prepare_call_hierarchy first. Optionally includes source code context around results.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The path to the file',
            },
            line: {
              type: 'number',
              description: 'The line number (1-indexed)',
            },
            character: {
              type: 'number',
              description: 'The character position in the line (1-indexed)',
            },
            include_context: {
              type: 'boolean',
              description:
                'If true, include source code context around each result location (default: false)',
              default: false,
            },
            context_lines: {
              type: 'number',
              description:
                'Number of lines of context to include before and after the target line (default: 2)',
              default: 2,
            },
          },
          required: ['file_path', 'line', 'character'],
        },
      },
      {
        name: 'find_symbol_anywhere',
        description:
          'Find a symbol across the entire workspace without specifying a file. Returns matching symbols with their locations, types, and containing files.',
        inputSchema: {
          type: 'object',
          properties: {
            symbol_name: {
              type: 'string',
              description: 'The name of the symbol to search for',
            },
            symbol_kind: {
              type: 'string',
              description:
                'Optional filter by symbol kind (function, class, variable, method, interface, etc.)',
            },
          },
          required: ['symbol_name'],
        },
      },
      {
        name: 'find_definitions_batch',
        description:
          'Find definitions for multiple symbols in one call. More efficient than calling find_definition multiple times.',
        inputSchema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              description: 'Array of symbols to find definitions for',
              items: {
                type: 'object',
                properties: {
                  file_path: {
                    type: 'string',
                    description: 'The path to the file',
                  },
                  symbol_name: {
                    type: 'string',
                    description: 'The name of the symbol',
                  },
                  symbol_kind: {
                    type: 'string',
                    description: 'The kind of symbol (function, class, variable, method, etc.)',
                  },
                },
                required: ['file_path', 'symbol_name'],
              },
            },
          },
          required: ['items'],
        },
      },
      {
        name: 'get_symbols_for_file',
        description:
          'Return all symbols in a file with their types, positions, and hierarchy. Faster than multiple individual symbol lookups.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The path to the file',
            },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'get_symbol_info',
        description:
          'Get comprehensive information about a symbol in one call: definition location, type/documentation from hover, and symbol kind. Combines find_definition + get_hover into a single request.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The path to the file containing the symbol',
            },
            symbol_name: {
              type: 'string',
              description: 'The name of the symbol',
            },
            symbol_kind: {
              type: 'string',
              description: 'The kind of symbol (function, class, variable, method, etc.)',
            },
          },
          required: ['file_path', 'symbol_name'],
        },
      },
      {
        name: 'move_file',
        description:
          'Move or rename a file and automatically update all import paths across the project. Uses LSP workspace/willRenameFiles to compute import changes before moving. Gracefully degrades when the language server does not support file rename operations.',
        inputSchema: {
          type: 'object',
          properties: {
            source_path: {
              type: 'string',
              description: 'The current path of the file to move',
            },
            destination_path: {
              type: 'string',
              description: 'The new path for the file',
            },
            dry_run: {
              type: 'boolean',
              description:
                'If true, only preview what import changes would be made without moving the file (default: false)',
            },
          },
          required: ['source_path', 'destination_path'],
        },
      },
    ],
  };
});

/** Format a symbol match label including container context when available */
function formatSymbolLabel(symbolName: string, kindStr: string, containerName?: string): string {
  const container = containerName ? ` in ${containerName}` : '';
  return `${symbolName} (${kindStr})${container}`;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'find_definition') {
      const {
        file_path,
        symbol_name,
        symbol_kind,
        include_context = false,
        context_lines = 2,
      } = args as {
        file_path: string;
        symbol_name: string;
        symbol_kind?: string;
        include_context?: boolean;
        context_lines?: number;
      };
      const absolutePath = resolve(file_path);
      const contextOptions = { linesBefore: context_lines, linesAfter: context_lines };

      const result = await lspClient.findSymbolsByName(absolutePath, symbol_name, symbol_kind);
      const { matches: symbolMatches, warning } = result;

      process.stderr.write(
        `[DEBUG find_definition] Found ${symbolMatches.length} symbol matches for "${symbol_name}"\n`
      );

      if (symbolMatches.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${file_path}. Please verify the symbol name and ensure the language server is properly configured.`,
            },
          ],
        };
      }

      const results = [];
      for (const match of symbolMatches) {
        process.stderr.write(
          `[DEBUG find_definition] Processing match: ${formatSymbolLabel(match.name, lspClient.symbolKindToString(match.kind), match.containerName)} at ${match.position.line}:${match.position.character}\n`
        );
        try {
          const locations = await lspClient.findDefinition(absolutePath, match.position);
          process.stderr.write(
            `[DEBUG find_definition] findDefinition returned ${locations.length} locations\n`
          );

          if (locations.length > 0) {
            const locationResults = locations
              .map((loc) => {
                const filePath = uriToPath(loc.uri);
                const { start } = loc.range;
                return formatLocationWithContext(
                  filePath,
                  start.line + 1,
                  start.character + 1,
                  include_context,
                  contextOptions
                );
              })
              .join(include_context ? '\n\n' : '\n');

            results.push(
              `Results for ${formatSymbolLabel(match.name, lspClient.symbolKindToString(match.kind), match.containerName)} at ${file_path}:${match.position.line + 1}:${match.position.character + 1}:\n${locationResults}`
            );
          } else {
            process.stderr.write(
              `[DEBUG find_definition] No definition found for ${match.name} at position ${match.position.line}:${match.position.character}\n`
            );
          }
        } catch (error) {
          process.stderr.write(`[DEBUG find_definition] Error processing match: ${error}\n`);
          // Continue trying other symbols if one fails
        }
      }

      if (results.length === 0) {
        const responseText = warning
          ? `${warning}\n\nFound ${symbolMatches.length} symbol(s) but no definitions could be retrieved. Please ensure the language server is properly configured.`
          : `Found ${symbolMatches.length} symbol(s) but no definitions could be retrieved. Please ensure the language server is properly configured.`;

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        };
      }

      const responseText = warning ? `${warning}\n\n${results.join('\n\n')}` : results.join('\n\n');

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      };
    }

    if (name === 'find_references') {
      const {
        file_path,
        symbol_name,
        symbol_kind,
        include_declaration = true,
        include_context = false,
        context_lines = 2,
      } = args as {
        file_path: string;
        symbol_name: string;
        symbol_kind?: string;
        include_declaration?: boolean;
        include_context?: boolean;
        context_lines?: number;
      };
      const absolutePath = resolve(file_path);
      const contextOptions = { linesBefore: context_lines, linesAfter: context_lines };

      const result = await lspClient.findSymbolsByName(absolutePath, symbol_name, symbol_kind);
      const { matches: symbolMatches, warning } = result;

      if (symbolMatches.length === 0) {
        const responseText = warning
          ? `${warning}\n\nNo symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${file_path}. Please verify the symbol name and ensure the language server is properly configured.`
          : `No symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${file_path}. Please verify the symbol name and ensure the language server is properly configured.`;

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        };
      }

      const results = [];
      for (const match of symbolMatches) {
        try {
          const locations = await lspClient.findReferences(
            absolutePath,
            match.position,
            include_declaration
          );

          if (locations.length > 0) {
            const locationResults = locations
              .map((loc) => {
                const filePath = uriToPath(loc.uri);
                const { start } = loc.range;
                return formatLocationWithContext(
                  filePath,
                  start.line + 1,
                  start.character + 1,
                  include_context,
                  contextOptions
                );
              })
              .join(include_context ? '\n\n' : '\n');

            results.push(
              `Results for ${formatSymbolLabel(match.name, lspClient.symbolKindToString(match.kind), match.containerName)} at ${file_path}:${match.position.line + 1}:${match.position.character + 1}:\n${locationResults}`
            );
          }
        } catch (error) {
          // Continue trying other symbols if one fails
        }
      }

      if (results.length === 0) {
        const responseText = warning
          ? `${warning}\n\nFound ${symbolMatches.length} symbol(s) but no references could be retrieved. Please ensure the language server is properly configured.`
          : `Found ${symbolMatches.length} symbol(s) but no references could be retrieved. Please ensure the language server is properly configured.`;

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        };
      }

      const responseText = warning ? `${warning}\n\n${results.join('\n\n')}` : results.join('\n\n');

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      };
    }

    if (name === 'rename_symbol') {
      const {
        file_path,
        symbol_name,
        symbol_kind,
        new_name,
        dry_run = false,
      } = args as {
        file_path: string;
        symbol_name: string;
        symbol_kind?: string;
        new_name: string;
        dry_run?: boolean;
      };
      const absolutePath = resolve(file_path);

      const result = await lspClient.findSymbolsByName(absolutePath, symbol_name, symbol_kind);
      const { matches: symbolMatches, warning } = result;

      if (symbolMatches.length === 0) {
        const responseText = warning
          ? `${warning}\n\nNo symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${file_path}. Please verify the symbol name and ensure the language server is properly configured.`
          : `No symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${file_path}. Please verify the symbol name and ensure the language server is properly configured.`;

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        };
      }

      if (symbolMatches.length > 1) {
        const candidatesList = symbolMatches
          .map(
            (match) =>
              `- ${formatSymbolLabel(match.name, lspClient.symbolKindToString(match.kind), match.containerName)} at line ${match.position.line + 1}, character ${match.position.character + 1}`
          )
          .join('\n');

        const responseText = warning
          ? `${warning}\n\nMultiple symbols found matching "${symbol_name}"${symbol_kind ? ` with kind "${symbol_kind}"` : ''}. Please use rename_symbol_strict with one of these positions:\n\n${candidatesList}`
          : `Multiple symbols found matching "${symbol_name}"${symbol_kind ? ` with kind "${symbol_kind}"` : ''}. Please use rename_symbol_strict with one of these positions:\n\n${candidatesList}`;

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        };
      }

      // Single match - proceed with rename
      const match = symbolMatches[0];
      if (!match) {
        throw new Error('Unexpected error: no match found');
      }
      try {
        const workspaceEdit = await lspClient.renameSymbol(absolutePath, match.position, new_name);

        if (workspaceEdit?.changes && Object.keys(workspaceEdit.changes).length > 0) {
          const changes = [];
          for (const [uri, edits] of Object.entries(workspaceEdit.changes)) {
            const filePath = uriToPath(uri);
            changes.push(`File: ${filePath}`);
            for (const edit of edits) {
              const { start, end } = edit.range;
              changes.push(
                `  - Line ${start.line + 1}, Column ${start.character + 1} to Line ${end.line + 1}, Column ${end.character + 1}: "${edit.newText}"`
              );
            }
          }

          // Apply changes if not in dry run mode
          if (!dry_run) {
            const editResult = await applyWorkspaceEdit(workspaceEdit, { lspClient });

            if (!editResult.success) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Failed to apply rename: ${editResult.error}`,
                  },
                ],
              };
            }

            const responseText = warning
              ? `${warning}\n\nSuccessfully renamed ${formatSymbolLabel(match.name, lspClient.symbolKindToString(match.kind), match.containerName)} to "${new_name}".\n\nModified files:\n${editResult.filesModified.map((f) => `- ${f}`).join('\n')}`
              : `Successfully renamed ${formatSymbolLabel(match.name, lspClient.symbolKindToString(match.kind), match.containerName)} to "${new_name}".\n\nModified files:\n${editResult.filesModified.map((f) => `- ${f}`).join('\n')}`;

            return {
              content: [
                {
                  type: 'text',
                  text: responseText,
                },
              ],
            };
          }
          // Dry run mode - show preview
          const responseText = warning
            ? `${warning}\n\n[DRY RUN] Would rename ${formatSymbolLabel(match.name, lspClient.symbolKindToString(match.kind), match.containerName)} to "${new_name}":\n${changes.join('\n')}`
            : `[DRY RUN] Would rename ${formatSymbolLabel(match.name, lspClient.symbolKindToString(match.kind), match.containerName)} to "${new_name}":\n${changes.join('\n')}`;

          return {
            content: [
              {
                type: 'text',
                text: responseText,
              },
            ],
          };
        }
        const responseText = warning
          ? `${warning}\n\nNo rename edits available for ${formatSymbolLabel(match.name, lspClient.symbolKindToString(match.kind), match.containerName)}. The symbol may not be renameable or the language server doesn't support renaming this type of symbol.`
          : `No rename edits available for ${formatSymbolLabel(match.name, lspClient.symbolKindToString(match.kind), match.containerName)}. The symbol may not be renameable or the language server doesn't support renaming this type of symbol.`;

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error renaming symbol: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    if (name === 'rename_symbol_strict') {
      const {
        file_path,
        line,
        character,
        new_name,
        dry_run = false,
      } = args as {
        file_path: string;
        line: number;
        character: number;
        new_name: string;
        dry_run?: boolean;
      };
      const absolutePath = resolve(file_path);

      try {
        const workspaceEdit = await lspClient.renameSymbol(
          absolutePath,
          { line: line - 1, character: character - 1 }, // Convert to 0-indexed
          new_name
        );

        if (workspaceEdit?.changes && Object.keys(workspaceEdit.changes).length > 0) {
          const changes = [];
          for (const [uri, edits] of Object.entries(workspaceEdit.changes)) {
            const filePath = uriToPath(uri);
            changes.push(`File: ${filePath}`);
            for (const edit of edits) {
              const { start, end } = edit.range;
              changes.push(
                `  - Line ${start.line + 1}, Column ${start.character + 1} to Line ${end.line + 1}, Column ${end.character + 1}: "${edit.newText}"`
              );
            }
          }

          // Apply changes if not in dry run mode
          if (!dry_run) {
            const editResult = await applyWorkspaceEdit(workspaceEdit, { lspClient });

            if (!editResult.success) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Failed to apply rename: ${editResult.error}`,
                  },
                ],
              };
            }

            return {
              content: [
                {
                  type: 'text',
                  text: `Successfully renamed symbol at line ${line}, character ${character} to "${new_name}".\n\nModified files:\n${editResult.filesModified.map((f) => `- ${f}`).join('\n')}`,
                },
              ],
            };
          }
          // Dry run mode - show preview
          return {
            content: [
              {
                type: 'text',
                text: `[DRY RUN] Would rename symbol at line ${line}, character ${character} to "${new_name}":\n${changes.join('\n')}`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: `No rename edits available at line ${line}, character ${character}. Please verify the symbol location and ensure the language server is properly configured.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error renaming symbol: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    if (name === 'get_diagnostics') {
      const { file_path } = args as { file_path: string };
      const absolutePath = resolve(file_path);

      try {
        const diagnostics = await lspClient.getDiagnostics(absolutePath);

        if (diagnostics.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No diagnostics found for ${file_path}. The file has no errors, warnings, or hints.`,
              },
            ],
          };
        }

        const severityMap = {
          1: 'Error',
          2: 'Warning',
          3: 'Information',
          4: 'Hint',
        };

        const diagnosticMessages = diagnostics.map((diag) => {
          const severity = diag.severity ? severityMap[diag.severity] || 'Unknown' : 'Unknown';
          const code = diag.code ? ` [${diag.code}]` : '';
          const source = diag.source ? ` (${diag.source})` : '';
          const { start, end } = diag.range;

          return `• ${severity}${code}${source}: ${diag.message}\n  Location: Line ${start.line + 1}, Column ${start.character + 1} to Line ${end.line + 1}, Column ${end.character + 1}`;
        });

        return {
          content: [
            {
              type: 'text',
              text: `Found ${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'} in ${file_path}:\n\n${diagnosticMessages.join('\n\n')}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error getting diagnostics: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    if (name === 'restart_server') {
      const { extensions } = args as { extensions?: string[] };

      try {
        const result = await lspClient.restartServers(extensions);

        let response = result.message;

        if (result.restarted.length > 0) {
          response += `\n\nRestarted servers:\n${result.restarted.map((s) => `• ${s}`).join('\n')}`;
        }

        if (result.failed.length > 0) {
          response += `\n\nFailed to restart:\n${result.failed.map((s) => `• ${s}`).join('\n')}`;
        }

        return {
          content: [
            {
              type: 'text',
              text: response,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error restarting servers: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    if (name === 'get_hover') {
      const { file_path, line, character } = args as {
        file_path: string;
        line: number;
        character: number;
      };
      const absolutePath = resolve(file_path);

      try {
        const result = await lspClient.hover(absolutePath, {
          line: line - 1,
          character: character - 1,
        });

        if (!result) {
          return {
            content: [
              {
                type: 'text',
                text: `No hover information available at ${file_path}:${line}:${character}`,
              },
            ],
          };
        }

        let hoverText: string;
        if (typeof result.contents === 'string') {
          hoverText = result.contents;
        } else if (result.contents && typeof result.contents === 'object') {
          hoverText = result.contents.value || JSON.stringify(result.contents);
        } else {
          hoverText = JSON.stringify(result.contents);
        }

        return {
          content: [
            {
              type: 'text',
              text: `Hover information at ${file_path}:${line}:${character}:\n\n${hoverText}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error getting hover info: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    if (name === 'find_workspace_symbols') {
      const {
        query,
        include_context = false,
        context_lines = 2,
      } = args as {
        query: string;
        include_context?: boolean;
        context_lines?: number;
      };
      const contextOptions = { linesBefore: context_lines, linesAfter: context_lines };

      try {
        const symbols = await lspClient.workspaceSymbol(query);

        if (symbols.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No symbols found matching "${query}"`,
              },
            ],
          };
        }

        const symbolList = symbols.map((sym) => {
          const filePath = uriToPath(sym.location.uri);
          const { start } = sym.location.range;
          const location = formatLocationWithContext(
            filePath,
            start.line + 1,
            start.character + 1,
            include_context,
            contextOptions
          );
          if (include_context) {
            return `• ${sym.name} (${lspClient.symbolKindToString(sym.kind)})\n  ${location.replace(/\n/g, '\n  ')}`;
          }
          return `• ${sym.name} (${lspClient.symbolKindToString(sym.kind)}) at ${location}`;
        });

        return {
          content: [
            {
              type: 'text',
              text: `Found ${symbols.length} symbol(s) matching "${query}":\n\n${symbolList.join(include_context ? '\n\n' : '\n')}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error searching symbols: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    if (name === 'find_implementation') {
      const {
        file_path,
        line,
        character,
        include_context = false,
        context_lines = 2,
      } = args as {
        file_path: string;
        line: number;
        character: number;
        include_context?: boolean;
        context_lines?: number;
      };
      const absolutePath = resolve(file_path);
      const contextOptions = { linesBefore: context_lines, linesAfter: context_lines };

      try {
        const locations = await lspClient.findImplementation(absolutePath, {
          line: line - 1,
          character: character - 1,
        });

        if (locations.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No implementations found at ${file_path}:${line}:${character}`,
              },
            ],
          };
        }

        const locationList = locations.map((loc) => {
          const filePath = uriToPath(loc.uri);
          const { start } = loc.range;
          return formatLocationWithContext(
            filePath,
            start.line + 1,
            start.character + 1,
            include_context,
            contextOptions
          );
        });

        return {
          content: [
            {
              type: 'text',
              text: `Found ${locations.length} implementation(s):\n\n${locationList.join(include_context ? '\n\n' : '\n')}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error finding implementations: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    if (name === 'prepare_call_hierarchy') {
      const { file_path, line, character } = args as {
        file_path: string;
        line: number;
        character: number;
      };
      const absolutePath = resolve(file_path);

      try {
        const items = await lspClient.prepareCallHierarchy(absolutePath, {
          line: line - 1,
          character: character - 1,
        });

        if (items.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No call hierarchy item found at ${file_path}:${line}:${character}`,
              },
            ],
          };
        }

        const itemList = items.map((item) => {
          const filePath = uriToPath(item.uri);
          const { start } = item.selectionRange;
          return `• ${item.name} (${lspClient.symbolKindToString(item.kind)}) at ${filePath}:${start.line + 1}:${start.character + 1}${item.detail ? ` - ${item.detail}` : ''}`;
        });

        return {
          content: [
            {
              type: 'text',
              text: `Call hierarchy item(s) at ${file_path}:${line}:${character}:\n\n${itemList.join('\n')}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error preparing call hierarchy: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    if (name === 'get_incoming_calls') {
      const {
        file_path,
        line,
        character,
        include_context = false,
        context_lines = 2,
      } = args as {
        file_path: string;
        line: number;
        character: number;
        include_context?: boolean;
        context_lines?: number;
      };
      const absolutePath = resolve(file_path);
      const contextOptions = { linesBefore: context_lines, linesAfter: context_lines };

      try {
        const items = await lspClient.prepareCallHierarchy(absolutePath, {
          line: line - 1,
          character: character - 1,
        });

        if (items.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No call hierarchy item found at ${file_path}:${line}:${character}`,
              },
            ],
          };
        }

        const allCalls = [];
        for (const item of items) {
          const calls = await lspClient.incomingCalls(item);
          for (const call of calls) {
            const filePath = uriToPath(call.from.uri);
            const { start } = call.from.selectionRange;
            const location = formatLocationWithContext(
              filePath,
              start.line + 1,
              start.character + 1,
              include_context,
              contextOptions
            );
            if (include_context) {
              allCalls.push(
                `• ${call.from.name} (${lspClient.symbolKindToString(call.from.kind)})\n  ${location.replace(/\n/g, '\n  ')}`
              );
            } else {
              allCalls.push(
                `• ${call.from.name} (${lspClient.symbolKindToString(call.from.kind)}) at ${location}`
              );
            }
          }
        }

        if (allCalls.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No incoming calls found for the function at ${file_path}:${line}:${character}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: `Found ${allCalls.length} incoming call(s):\n\n${allCalls.join(include_context ? '\n\n' : '\n')}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error finding incoming calls: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    if (name === 'get_outgoing_calls') {
      const {
        file_path,
        line,
        character,
        include_context = false,
        context_lines = 2,
      } = args as {
        file_path: string;
        line: number;
        character: number;
        include_context?: boolean;
        context_lines?: number;
      };
      const absolutePath = resolve(file_path);
      const contextOptions = { linesBefore: context_lines, linesAfter: context_lines };

      try {
        const items = await lspClient.prepareCallHierarchy(absolutePath, {
          line: line - 1,
          character: character - 1,
        });

        if (items.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No call hierarchy item found at ${file_path}:${line}:${character}`,
              },
            ],
          };
        }

        const allCalls = [];
        for (const item of items) {
          const calls = await lspClient.outgoingCalls(item);
          for (const call of calls) {
            const filePath = uriToPath(call.to.uri);
            const { start } = call.to.selectionRange;
            const location = formatLocationWithContext(
              filePath,
              start.line + 1,
              start.character + 1,
              include_context,
              contextOptions
            );
            if (include_context) {
              allCalls.push(
                `• ${call.to.name} (${lspClient.symbolKindToString(call.to.kind)})\n  ${location.replace(/\n/g, '\n  ')}`
              );
            } else {
              allCalls.push(
                `• ${call.to.name} (${lspClient.symbolKindToString(call.to.kind)}) at ${location}`
              );
            }
          }
        }

        if (allCalls.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No outgoing calls found for the function at ${file_path}:${line}:${character}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: `Found ${allCalls.length} outgoing call(s):\n\n${allCalls.join(include_context ? '\n\n' : '\n')}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error finding outgoing calls: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    if (name === 'find_symbol_anywhere') {
      const { symbol_name, symbol_kind } = args as {
        symbol_name: string;
        symbol_kind?: string;
      };

      try {
        const symbols = await lspClient.workspaceSymbol(symbol_name);

        if (symbols.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No symbols found matching "${symbol_name}" in the workspace. Ensure at least one LSP server is running.`,
              },
            ],
          };
        }

        // Filter by kind if specified
        let filtered = symbols;
        if (symbol_kind) {
          filtered = symbols.filter(
            (sym) => lspClient.symbolKindToString(sym.kind) === symbol_kind.toLowerCase()
          );

          if (filtered.length === 0) {
            // Show what kinds were found as a helpful hint
            const foundKinds = [
              ...new Set(symbols.map((sym) => lspClient.symbolKindToString(sym.kind))),
            ];
            return {
              content: [
                {
                  type: 'text',
                  text: `No symbols matching "${symbol_name}" with kind "${symbol_kind}" found. Found ${symbols.length} symbol(s) with other kinds: ${foundKinds.join(', ')}.`,
                },
              ],
            };
          }
        }

        // Filter to exact or close name matches (workspace/symbol can return partial matches)
        const exactMatches = filtered.filter((sym) => sym.name === symbol_name);
        const displaySymbols = exactMatches.length > 0 ? exactMatches : filtered;

        const symbolList = displaySymbols.map((sym) => {
          const filePath = uriToPath(sym.location.uri);
          const { start } = sym.location.range;
          const container = sym.containerName ? ` in ${sym.containerName}` : '';
          return `• ${sym.name} (${lspClient.symbolKindToString(sym.kind)}) at ${filePath}:${start.line + 1}:${start.character + 1}${container}`;
        });

        const qualifier =
          exactMatches.length > 0 && exactMatches.length < filtered.length
            ? ` (${filtered.length - exactMatches.length} partial match(es) omitted)`
            : '';

        return {
          content: [
            {
              type: 'text',
              text: `Found ${displaySymbols.length} symbol(s) matching "${symbol_name}"${symbol_kind ? ` with kind "${symbol_kind}"` : ''}${qualifier}:\n\n${symbolList.join('\n')}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error searching for symbol: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    if (name === 'find_definitions_batch') {
      const { items } = args as {
        items: Array<{
          file_path: string;
          symbol_name: string;
          symbol_kind?: string;
        }>;
      };

      const results: string[] = [];

      for (const item of items) {
        const absolutePath = resolve(item.file_path);
        try {
          const result = await lspClient.findSymbolsByName(
            absolutePath,
            item.symbol_name,
            item.symbol_kind
          );
          const { matches: symbolMatches, warning } = result;

          if (symbolMatches.length === 0) {
            results.push(
              `## ${item.symbol_name}${item.symbol_kind ? ` (${item.symbol_kind})` : ''} in ${item.file_path}\nNo symbols found.${warning ? ` ${warning}` : ''}`
            );
            continue;
          }

          for (const match of symbolMatches) {
            try {
              const locations = await lspClient.findDefinition(absolutePath, match.position);

              if (locations.length > 0) {
                const locationResults = locations
                  .map((loc) => {
                    const filePath = uriToPath(loc.uri);
                    const { start } = loc.range;
                    return `  ${filePath}:${start.line + 1}:${start.character + 1}`;
                  })
                  .join('\n');

                results.push(
                  `## ${match.name} (${lspClient.symbolKindToString(match.kind)}) in ${item.file_path}:${match.position.line + 1}:${match.position.character + 1}${warning ? `\n${warning}` : ''}\n${locationResults}`
                );
              }
            } catch (error) {
              results.push(
                `## ${match.name} (${lspClient.symbolKindToString(match.kind)}) in ${item.file_path}\nError: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
        } catch (error) {
          results.push(
            `## ${item.symbol_name} in ${item.file_path}\nError: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      return {
        content: [
          {
            type: 'text',
            text:
              results.length > 0
                ? results.join('\n\n')
                : 'No definitions found for any of the requested symbols.',
          },
        ],
      };
    }

    if (name === 'get_symbols_for_file') {
      const { file_path } = args as { file_path: string };
      const absolutePath = resolve(file_path);

      try {
        const symbols = await lspClient.getDocumentSymbols(absolutePath);

        if (symbols.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No symbols found in ${file_path}. The file may be empty or the language server may not support document symbols.`,
              },
            ],
          };
        }

        // Check if DocumentSymbol[] (hierarchical) or SymbolInformation[] (flat)
        const isHierarchical =
          symbols.length > 0 &&
          symbols[0] &&
          'range' in symbols[0] &&
          'selectionRange' in symbols[0];

        if (isHierarchical) {
          const formatSymbol = (
            sym: {
              name: string;
              kind: number;
              detail?: string;
              range: {
                start: { line: number; character: number };
                end: { line: number; character: number };
              };
              selectionRange: {
                start: { line: number; character: number };
                end: { line: number; character: number };
              };
              children?: unknown[];
            },
            indent: number
          ): string => {
            const prefix = '  '.repeat(indent);
            const kind = lspClient.symbolKindToString(sym.kind);
            const { start } = sym.selectionRange;
            const detail = sym.detail ? ` - ${sym.detail}` : '';
            let line = `${prefix}• ${sym.name} (${kind}) at line ${start.line + 1}:${start.character + 1}${detail}`;

            if (sym.children && Array.isArray(sym.children)) {
              for (const child of sym.children) {
                line += `\n${formatSymbol(child as typeof sym, indent + 1)}`;
              }
            }

            return line;
          };

          const symbolList = symbols.map((sym) =>
            formatSymbol(sym as Parameters<typeof formatSymbol>[0], 0)
          );

          return {
            content: [
              {
                type: 'text',
                text: `Found ${symbols.length} top-level symbol(s) in ${file_path}:\n\n${symbolList.join('\n')}`,
              },
            ],
          };
        }

        // SymbolInformation[] (flat)
        const symbolList = symbols.map((sym) => {
          const s = sym as {
            name: string;
            kind: number;
            location: { uri: string; range: { start: { line: number; character: number } } };
            containerName?: string;
          };
          const kind = lspClient.symbolKindToString(s.kind);
          const { start } = s.location.range;
          const container = s.containerName ? ` in ${s.containerName}` : '';
          return `• ${s.name} (${kind}) at line ${start.line + 1}:${start.character + 1}${container}`;
        });

        return {
          content: [
            {
              type: 'text',
              text: `Found ${symbols.length} symbol(s) in ${file_path}:\n\n${symbolList.join('\n')}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error getting symbols: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }

    if (name === 'get_symbol_info') {
      const { file_path, symbol_name, symbol_kind } = args as {
        file_path: string;
        symbol_name: string;
        symbol_kind?: string;
      };
      const absolutePath = resolve(file_path);

      const result = await lspClient.findSymbolsByName(absolutePath, symbol_name, symbol_kind);
      const { matches: symbolMatches, warning } = result;

      if (symbolMatches.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${file_path}. Please verify the symbol name and ensure the language server is properly configured.`,
            },
          ],
        };
      }

      const results = [];
      for (const match of symbolMatches) {
        const sections: string[] = [];
        const kindStr = lspClient.symbolKindToString(match.kind);
        sections.push(`Symbol: ${match.name} (${kindStr})`);
        sections.push(
          `Location: ${file_path}:${match.position.line + 1}:${match.position.character + 1}`
        );

        if (match.detail) {
          sections.push(`Detail: ${match.detail}`);
        }

        // Get definition and hover in parallel
        const [defResult, hoverResult] = await Promise.allSettled([
          lspClient.findDefinition(absolutePath, match.position),
          lspClient.hover(absolutePath, match.position),
        ]);

        if (defResult.status === 'fulfilled' && defResult.value.length > 0) {
          const defLines = defResult.value.map((loc) => {
            const filePath = uriToPath(loc.uri);
            const { start } = loc.range;
            return `  ${filePath}:${start.line + 1}:${start.character + 1}`;
          });
          sections.push(`Definition:\n${defLines.join('\n')}`);
        }

        if (hoverResult.status === 'fulfilled' && hoverResult.value) {
          const hover = hoverResult.value;
          let hoverText: string;
          if (typeof hover.contents === 'string') {
            hoverText = hover.contents;
          } else if (hover.contents && typeof hover.contents === 'object') {
            hoverText = hover.contents.value || JSON.stringify(hover.contents);
          } else {
            hoverText = JSON.stringify(hover.contents);
          }
          if (hoverText) {
            sections.push(`Type/Documentation:\n${hoverText}`);
          }
        }

        results.push(sections.join('\n'));
      }

      const responseText = warning
        ? `${warning}\n\n${results.join('\n\n---\n\n')}`
        : results.join('\n\n---\n\n');

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      };
    }

    if (name === 'move_file') {
      const {
        source_path,
        destination_path,
        dry_run = false,
      } = args as {
        source_path: string;
        destination_path: string;
        dry_run?: boolean;
      };

      const absoluteSource = resolve(source_path);
      const absoluteDest = resolve(destination_path);

      const result = await lspClient.moveFile(absoluteSource, absoluteDest, dry_run);

      const parts: string[] = [];

      if (dry_run) {
        parts.push('[DRY RUN] Preview of file move:');
        parts.push(`  From: ${absoluteSource}`);
        parts.push(`  To: ${absoluteDest}`);

        if (result.importChanges) {
          parts.push('\nImport changes that would be applied:');
          for (const [uri, edits] of Object.entries(result.importChanges)) {
            const filePath = uriToPath(uri);
            parts.push(`\n  ${filePath}:`);
            for (const edit of edits) {
              const { start, end } = edit.range;
              parts.push(
                `    Line ${start.line + 1}:${start.character + 1} → ${end.line + 1}:${end.character + 1}: "${edit.newText}"`
              );
            }
          }
        } else {
          parts.push('\nNo import changes needed (or server does not support import updates).');
        }
      } else {
        parts.push('Successfully moved file:');
        parts.push(`  From: ${absoluteSource}`);
        parts.push(`  To: ${absoluteDest}`);

        if (result.importChanges) {
          const fileCount = Object.keys(result.importChanges).length;
          parts.push(`\nUpdated imports in ${fileCount} file(s).`);
        }
      }

      if (result.warnings.length > 0) {
        parts.push('\nWarnings:');
        for (const warning of result.warnings) {
          parts.push(`  - ${warning}`);
        }
      }

      return {
        content: [{ type: 'text', text: parts.join('\n') }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
});

// Cleanup helper to ensure we only dispose once
let isDisposing = false;
function cleanup(reason: string, exitCode = 0) {
  if (isDisposing) return;
  isDisposing = true;
  process.stderr.write(`[cclsp] Cleaning up: ${reason}\n`);
  try {
    lspClient.dispose();
  } catch (error) {
    process.stderr.write(`[cclsp] Error during cleanup: ${error}\n`);
  }
  process.exit(exitCode);
}

// Handle graceful shutdown signals
process.on('SIGINT', () => cleanup('SIGINT'));
process.on('SIGTERM', () => cleanup('SIGTERM'));
process.on('SIGHUP', () => cleanup('SIGHUP'));

// Handle stdin close - this is the key fix for orphan processes.
// When the parent process (Claude Code) dies, stdin closes.
// MCP uses stdio transport, so stdin closing means parent is gone.
process.stdin.on('close', () => cleanup('stdin closed (parent died)'));
process.stdin.on('end', () => cleanup('stdin ended (parent died)'));

// Handle uncaught exceptions - clean up before crashing
process.on('uncaughtException', (error) => {
  process.stderr.write(`[cclsp] Uncaught exception: ${error}\n`);
  cleanup('uncaughtException', 1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[cclsp] Unhandled rejection: ${reason}\n`);
  cleanup('unhandledRejection', 1);
});

// Handle normal exit - ensure cleanup happens
process.on('beforeExit', () => {
  if (!isDisposing) {
    cleanup('beforeExit');
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('CCLSP Server running on stdio\n');

  // Preload LSP servers for file types found in the project
  try {
    await lspClient.preloadServers();
  } catch (error) {
    process.stderr.write(`Failed to preload LSP servers: ${error}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`[cclsp] Server error: ${error}\n`);
  cleanup('main() error', 1);
});
