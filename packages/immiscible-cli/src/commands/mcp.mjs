/**
 * immiscible mcp: how to add Immiscible's MCP server to an MCP client.
 *
 * Prints, and changes nothing: the one-line command or the config file
 * entry for Claude Code, Cursor, VS Code, Windsurf, Codex, Gemini CLI and
 * connector clients (Claude, ChatGPT). The agent key is never printed: the
 * configs name the IMMISCIBLE_AGENT_KEY variable, which `immiscible init`
 * writes to .env, or leave the header out so the client signs in with
 * OAuth. No server is contacted.
 */

import { CliError, EXIT } from '../errors.mjs';

const KEY = 'IMMISCIBLE_AGENT_KEY';

/** Every client's setup, for the MCP server at `url` (the server's base address). */
export function mcpSetups(base) {
  const url = `${base.replace(/\/+$/, '')}/mcp`;
  const json = (o) => JSON.stringify(o, null, 2);
  const cursorEntry = { url, headers: { Authorization: `Bearer \${env:${KEY}}` } };
  const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=immiscible&config=${Buffer.from(JSON.stringify(cursorEntry)).toString('base64')}`;
  return {
    'claude-code': {
      title: 'Claude Code',
      command: `claude mcp add --transport http immiscible ${url} --header "Authorization: Bearer $${KEY}"`,
      file: '.mcp.json',
      config: json({ mcpServers: { immiscible: { type: 'http', url, headers: { Authorization: `Bearer \${${KEY}}` } } } }),
      note: 'The command stores the key for you (local scope). .mcp.json is for a project you share: Claude Code fills ${IMMISCIBLE_AGENT_KEY} from the environment and asks each person to approve the server once.',
    },
    cursor: {
      title: 'Cursor',
      command: null,
      link: cursorLink,
      file: '.cursor/mcp.json',
      config: json({ mcpServers: { immiscible: cursorEntry } }),
      note: 'Cursor fills ${env:IMMISCIBLE_AGENT_KEY} from the environment. The link opens Cursor\'s install prompt with the same entry.',
    },
    vscode: {
      title: 'VS Code (GitHub Copilot agent mode)',
      command: `code --add-mcp '${JSON.stringify({ name: 'immiscible', type: 'http', url })}'`,
      link: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'immiscible', type: 'http', url }))}`,
      file: '.vscode/mcp.json',
      config: json({
        inputs: [{ type: 'promptString', id: 'immiscible-agent-key', description: 'Immiscible agent key (ask_...)', password: true }],
        servers: { immiscible: { type: 'http', url, headers: { Authorization: 'Bearer ${input:immiscible-agent-key}' } } },
      }),
      note: 'The command and the link add the server with no key, so VS Code signs in with OAuth; the file asks for the key once and stores it securely.',
    },
    windsurf: {
      title: 'Windsurf (Devin Desktop)',
      command: null,
      file: '~/.config/devin/mcp_config.json (Windows: %APPDATA%\\devin\\mcp_config.json; older Windsurf: ~/.codeium/windsurf/mcp_config.json)',
      config: json({ mcpServers: { immiscible: { serverUrl: url, headers: { Authorization: `Bearer \${env:${KEY}}` } } } }),
      note: 'Windsurf fills ${env:IMMISCIBLE_AGENT_KEY} from the environment.',
    },
    codex: {
      title: 'Codex CLI',
      command: `codex mcp add immiscible --url ${url} --bearer-token-env-var ${KEY}`,
      file: '~/.codex/config.toml',
      config: `[mcp_servers.immiscible]\nurl = "${url}"\nbearer_token_env_var = "${KEY}"`,
      note: 'Codex reads the key from the variable named.',
    },
    gemini: {
      title: 'Gemini CLI',
      command: `gemini mcp add --transport http -H "Authorization: Bearer $${KEY}" immiscible ${url}`,
      file: '.gemini/settings.json',
      config: json({ mcpServers: { immiscible: { httpUrl: url, headers: { Authorization: `Bearer \${${KEY}}` } } } }),
      note: 'httpUrl is Streamable HTTP. Gemini CLI expands ${IMMISCIBLE_AGENT_KEY} in settings.json from the environment.',
    },
    connector: {
      title: 'Claude, ChatGPT and other connector clients',
      command: null,
      file: null,
      config: url,
      note: 'Add this address as a custom connector and sign in. You choose which agent the connection acts as on the consent screen; no key is pasted.',
    },
  };
}

export const MCP_CLIENTS = Object.keys(mcpSetups('https://x.test'));

export async function mcp(ctx) {
  const { ui, flags } = ctx;
  const all = mcpSetups(ctx.url);
  const want = flags.client ? String(flags.client).toLowerCase() : null;
  if (want && !all[want]) {
    throw new CliError(`unknown MCP client "${flags.client}"`, { exit: EXIT.USAGE, code: 'usage', fix: `Use one of: ${MCP_CLIENTS.join(', ')}.` });
  }
  const chosen = want ? { [want]: all[want] } : all;
  if (ui.json) {
    ui.writeJson({ ok: true, url: `${ctx.url}/mcp`, keyVariable: KEY, clients: chosen, docs: `${ctx.url}/docs/answers/add-the-mcp-server` });
    return EXIT.OK;
  }
  const { c } = ui;
  ui.out(`${c.bold('Immiscible MCP server')} ${c.dim(`${ctx.url}/mcp`)}`);
  ui.note(`The configs read the agent key from ${KEY} (immiscible init writes it to .env). Nothing is changed by this command.`);
  for (const [, s] of Object.entries(chosen)) {
    ui.blank();
    ui.out(c.bold(s.title));
    if (s.command) ui.out(`  ${s.command}`);
    if (s.link) ui.out(`  ${c.dim('Install link:')} ${s.link}`);
    if (s.file) ui.out(`  ${c.dim(s.file)}`);
    for (const l of String(s.config).split('\n')) ui.out(`  ${l}`);
    ui.note(`  ${s.note}`);
  }
  return EXIT.OK;
}
