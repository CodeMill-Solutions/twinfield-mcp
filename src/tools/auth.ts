import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TwinfieldClient, loadCredentialsFile } from '../twinfield-client.js';

/**
 * Register the auth / setup tools.
 *
 * `whoami` is the smallest end-to-end auth check we can make: it exercises
 * the refresh-token grant, the cluster-URL discovery, and the access-token
 * itself, without touching any business service. It's intended as the
 * Phase-1 go/no-go gate before the broader read-tools land.
 *
 * `reload_credentials` mirrors yuki-mcp's `reload_keys`: re-read the JSON
 * credentials file from disk and swap the in-memory map in place. Tokens
 * for offices whose credentials changed (or were removed) are evicted from
 * the token cache so the next call re-authenticates against Twinfield.
 */
export function registerAuthTools(server: McpServer, client: TwinfieldClient): void {
  server.registerTool(
    'whoami',
    {
      description:
        'Validate Twinfield authentication for an office by calling the OpenID Connect ' +
        'userinfo endpoint. Returns the identity claims (twf.id, twf.organisationCode, etc.). ' +
        'Run this first to confirm credentials, cluster discovery, and the refresh-token flow ' +
        'all work end-to-end before invoking business tools.',
      inputSchema: {
        office: z
          .string()
          .optional()
          .describe(
            'Twinfield office code (CompanyCode). Defaults to TWINFIELD_OFFICE_CODE when omitted.',
          ),
      },
    },
    async ({ office }) => {
      try {
        const claims = await client.fetchUserInfo(office);
        const resolved = office ?? client.defaultOfficeCode;
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, office: resolved, claims }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }, null, 2) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'reload_credentials',
    {
      description:
        'Reload the office → OAuth2 credentials map from the JSON credentials file without ' +
        'restarting the MCP server. Use after a new entry has been written externally (for ' +
        'example by `npm run authorize`) to make it usable for SOAP calls immediately. Tokens ' +
        'for changed/removed offices are invalidated; unchanged offices keep their cached ' +
        'token. Returns a diff of added/updated/removed office codes.',
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            'Optional explicit path to the credentials JSON file. ' +
              'Defaults to TWINFIELD_CREDENTIALS_FILE → ~/.twinfield/credentials.json → ./credentials.json.',
          ),
      },
    },
    async ({ path }) => {
      try {
        const loaded = loadCredentialsFile(path);
        if (!loaded.found) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    success: false,
                    error: `Credentials file not found at ${loaded.path}`,
                    source: loaded.path,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        const diff = client.reloadCredentials(loaded.map);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  source: loaded.path,
                  added: diff.added,
                  updated: diff.updated,
                  removed: diff.removed,
                  total: diff.total,
                  unchanged: diff.total - diff.added.length - diff.updated.length,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }, null, 2) }],
          isError: true,
        };
      }
    },
  );
}
