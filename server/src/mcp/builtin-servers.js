// myco MCP market — built-in catalog seeds (mcp-market phase 1).
//
// The marketplace's design decision (see docs/whatsnew + the original
// 方案 doc): myco does NOT run an MCP gateway or spawn arbitrary MCP
// server processes. Instead, each catalog entry ("MCP server") is a
// SKILL PACK — a small set of Claude Code skills that document how to
// call a website's MCP endpoints (transport, base URL, auth env vars,
// per-tool interface + parameters, curl/fetch invocation examples).
// Installing a pack copies the skill folders into the session's
// `.claude/skills/` store (the same mechanism the skill market uses),
// so the agent learns the MCP server's tool surface as ordinary skill
// instructions and calls it with Bash/curl. Zero new runtime deps,
// zero process management — the Claude Agent SDK's skill loading does
// all the work.
//
// Each entry below declares the pack the registry materializes:
//   name / displayName / description / category / version
//   transport     — documented transport (stdio | sse | streamable-http | builtin)
//   endpoint      — base URL / command documented to the agent
//   security      — { level, requiresAuth, scopes } shown on the card
//   skills        — { dirName, description, guide (SKILL.md body) }[]
// The `guide` body becomes the SKILL.md content; the registry writes
// the `---\nname/description\n---` front matter around it.

'use strict';

// ─── skill-guide helpers ───

function _httpGuide({ displayName, endpoint, tools, authEnv, notes }) {
  const toolLines = (tools || []).map((t) =>
    `### \`${t.name}\`\n\n${t.description}\n\nParameters:\n\n` +
    (t.params || []).map((p) => `- \`${p.name}\` (${p.type}${p.required ? ', required' : ''}) — ${p.description}`).join('\n') +
    `\n\nExample:\n\n\`\`\`bash\ncurl -s -X POST "${endpoint}${t.path}" \\\n  -H "Content-Type: application/json" \\\n  ${authEnv ? `-H "Authorization: Bearer $${authEnv}" \\\n  ` : ''}-d '${JSON.stringify(Object.fromEntries((t.params || []).map((p) => [p.name, p.example ?? '<value>'])))}'\n\`\`\``)
    .join('\n\n');
  return `# ${displayName} — MCP tool guide

This skill teaches you how to call the **${displayName}** MCP server over HTTP.
The server speaks the Model Context Protocol; each "tool" below is an MCP tool
exposed at the listed HTTP endpoint. Call them with \`curl\` (Bash tool) and
parse the JSON response — no MCP client library is needed.

- Endpoint base: \`${endpoint}\`
- Transport: streamable HTTP (JSON request/response)
${authEnv ? `- Auth: send \`Authorization: Bearer $\{${authEnv}}\` — the token is read from the \`${authEnv}\` environment variable.` : '- Auth: none required.'}

## Tools

${toolLines}

${notes || ''}

## Response handling

MCP HTTP endpoints answer with JSON. On success you get \`{ "result": ... }\`;
on failure \`{ "error": { "code": ..., "message": ... } }\`. Surface errors to
the user verbatim and suggest the likely fix (bad params, missing auth, wrong path).`;
}

function _stdioGuide({ displayName, command, args, tools, env, notes }) {
  const toolLines = (tools || []).map((t) =>
    `### \`${t.name}\`\n\n${t.description}\n\nParameters (JSON):\n\n` +
    (t.params || []).map((p) => `- \`${p.name}\` (${p.type}${p.required ? ', required' : ''}) — ${p.description}`).join('\n'))
    .join('\n\n');
  return `# ${displayName} — MCP stdio server guide

This skill teaches you how to invoke the **${displayName}** MCP server, a
local stdio process. Interact via JSON-RPC over stdio: each line you write is
a JSON-RPC request; each line the server writes back is a JSON-RPC response.

- Launch: \`${command} ${args.join(' ')}\`
${env && env.length ? `- Required env: ${env.map((e) => `\`${e}\``).join(', ')}` : '- Required env: none'}

## Protocol

\`\`\`json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"claude","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"<tool>","arguments":{...}}}
\`\`\`

Use a heredoc + pipe, then read the matching \`id\` line from stdout:
\`\`\`bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,...}' | ${command} ${args.join(' ')} | head -5
\`\`\`
For a single call the initialize + tools/call lines can be piped together.

## Tools

${toolLines}

${notes || ''}`;
}

// ─── built-in catalog entries ───

// `sdkTools` (below on each entry) is the machine-readable companion to
// the `guide` bodies: the tools myco can execute SERVER-SIDE on the
// session's behalf through the per-session `myco_mcp` SDK MCP server
// (see mcp/mcp-server.js — createSdkMcpServer pattern from
// myco-mcp.js). Shape per tool: { name, description, params:
// [{name, type:'string'|'number', required, description}] }.
// Handlers live in mcp-server.js keyed by entry name. Entries whose
// service myco cannot reach server-side (stdio sidecars like the
// filesystem/postgres packs, or intranet-gated CodeHub REST) omit
// `sdkTools` — their skills remain pure guidance and the agent uses
// Bash/JSON-RPC per the guide.
const builtinServers = [
  {
    name: 'github',
    displayName: 'GitHub Tools',
    description: 'GitHub repo/file/issue operations over the GitHub REST API — exposed as skill-guided MCP-style tool calls.',
    version: '1.0.0',
    category: 'devops',
    transport: { type: 'streamable-http' },
    endpoint: 'https://api.github.com',
    security: { level: 'medium', requiresAuth: true, scopes: ['repo'] },
    // Server-side executable tools (myco_mcp SDK MCP server). Auth:
    // myco's stored git token for the session's user (OAuth or /setpat).
    sdkTools: [
      { name: 'list_repos', description: 'List the authenticated user\'s GitHub repositories (name, visibility, url).',
        params: [{ name: 'perPage', type: 'number', required: false, description: 'Page size 1-100 (default 30)' }] },
      { name: 'get_file', description: 'Fetch a file\'s decoded content from a repo at a ref (default HEAD).',
        params: [
          { name: 'owner', type: 'string', required: true, description: 'Repo owner' },
          { name: 'repo', type: 'string', required: true, description: 'Repo name' },
          { name: 'path', type: 'string', required: true, description: 'File path inside the repo' },
          { name: 'ref', type: 'string', required: false, description: 'Branch / tag / sha (default HEAD)' },
        ] },
      { name: 'create_issue', description: 'Open a new issue on a repo.',
        params: [
          { name: 'owner', type: 'string', required: true, description: 'Repo owner' },
          { name: 'repo', type: 'string', required: true, description: 'Repo name' },
          { name: 'title', type: 'string', required: true, description: 'Issue title' },
          { name: 'body', type: 'string', required: false, description: 'Issue body (markdown)' },
        ] },
      { name: 'list_issues', description: 'List open issues on a repo.',
        params: [
          { name: 'owner', type: 'string', required: true, description: 'Repo owner' },
          { name: 'repo', type: 'string', required: true, description: 'Repo name' },
          { name: 'limit', type: 'number', required: false, description: 'Max issues (default 20)' },
        ] },
    ],
    skills: [{
      dirName: 'mcp-github',
      description: 'Guide for calling GitHub REST endpoints (repos, files, issues) with curl, including pagination and auth.',
      guide: _httpGuide({
        displayName: 'GitHub Tools',
        endpoint: 'https://api.github.com',
        authEnv: 'GITHUB_TOKEN',
        tools: [
          {
            name: 'list_repos', description: 'List repositories for a user or org.', path: '/users/{user}/repos?per_page=30',
            params: [
              { name: 'user', type: 'string', required: true, description: 'GitHub login or org name' },
              { name: 'per_page', type: 'number', required: false, description: 'Page size (default 30)' },
            ],
          },
          {
            name: 'get_file', description: 'Read a file from a repo (base64 contents).', path: '/repos/{owner}/{repo}/contents/{path}',
            params: [
              { name: 'owner', type: 'string', required: true, description: 'Repo owner' },
              { name: 'repo', type: 'string', required: true, description: 'Repo name' },
              { name: 'path', type: 'string', required: true, description: 'File path inside the repo' },
            ],
          },
          {
            name: 'create_issue', description: 'Open a new issue.', path: '/repos/{owner}/{repo}/issues',
            params: [
              { name: 'owner', type: 'string', required: true, description: 'Repo owner' },
              { name: 'repo', type: 'string', required: true, description: 'Repo name' },
              { name: 'title', type: 'string', required: true, description: 'Issue title' },
              { name: 'body', type: 'string', required: false, description: 'Issue body (markdown)' },
            ],
          },
        ],
        notes: 'Pagination: pass `?page=N`. Rate limit: 5000 req/h authenticated. Use `Accept: application/vnd.github+json`.',
      }),
    }],
    source: 'builtin',
  },
  {
    name: 'gitee',
    displayName: 'Gitee Tools',
    description: 'Gitee repo/issue operations over the Gitee REST API, skill-guided (works in the Huawei intranet via codehub mirrors too).',
    version: '1.0.0',
    category: 'devops',
    transport: { type: 'streamable-http' },
    endpoint: 'https://gitee.com/api/v5',
    security: { level: 'medium', requiresAuth: true, scopes: ['projects', 'issues'] },
    // Server-side executable tools. Auth: per-repo Gitee PAT from
    // myco's token store (/setpat); gitee has no OAuth fallback.
    sdkTools: [
      { name: 'list_repos', description: 'List a user\'s Gitee repositories.',
        params: [{ name: 'user', type: 'string', required: true, description: 'Gitee login' }] },
      { name: 'list_issues', description: 'List open issues on a Gitee repo.',
        params: [
          { name: 'owner', type: 'string', required: true, description: 'Repo owner' },
          { name: 'repo', type: 'string', required: true, description: 'Repo path segment' },
        ] },
      { name: 'create_issue', description: 'Open an issue on a Gitee repo (needs issues-scope PAT).',
        params: [
          { name: 'owner', type: 'string', required: true, description: 'Repo owner' },
          { name: 'repo', type: 'string', required: true, description: 'Repo path segment' },
          { name: 'title', type: 'string', required: true, description: 'Issue title' },
          { name: 'body', type: 'string', required: false, description: 'Issue body (markdown)' },
        ] },
    ],
    skills: [{
      dirName: 'mcp-gitee',
      description: 'Guide for calling Gitee REST endpoints (repos, issues) with curl + PAT auth.',
      guide: _httpGuide({
        displayName: 'Gitee Tools',
        endpoint: 'https://gitee.com/api/v5',
        authEnv: 'GITEE_TOKEN',
        tools: [
          {
            name: 'list_repos', description: 'List a user\'s repositories.', path: '/users/{user}/repos',
            params: [{ name: 'user', type: 'string', required: true, description: 'Gitee login' }],
          },
          {
            name: 'create_issue', description: 'Open an issue on a repo.', path: '/repos/{owner}/{repo}/issues',
            params: [
              { name: 'owner', type: 'string', required: true, description: 'Repo owner' },
              { name: 'repo', type: 'string', required: true, description: 'Repo path (owner/repo)' },
              { name: 'title', type: 'string', required: true, description: 'Issue title' },
              { name: 'body', type: 'string', required: false, description: 'Issue body' },
            ],
          },
        ],
        notes: 'Gitee v5 auth: prefer `Authorization: Bearer $GITEE_TOKEN`; `access_token` query param also works.',
      }),
    }],
    source: 'builtin',
  },
  {
    name: 'huawei-codehub',
    displayName: 'CodeHub (Huawei) Tools',
    description: 'Huawei CodeHub repo operations — REST endpoints for repos/branches/merge requests, skill-guided.',
    version: '1.0.0',
    category: 'devops',
    transport: { type: 'streamable-http' },
    endpoint: 'https://codehub-dg-g.huawei.com/api',
    security: { level: 'high', requiresAuth: true, scopes: ['repo'] },
    skills: [{
      dirName: 'mcp-codehub',
      description: 'Guide for CodeHub REST calls (repos, branches, MRs) with PAT auth, intranet direct-connect notes.',
      guide: _httpGuide({
        displayName: 'CodeHub (Huawei) Tools',
        endpoint: 'https://codehub-dg-g.huawei.com/api',
        authEnv: 'CODEHUB_TOKEN',
        tools: [
          {
            name: 'list_projects', description: 'List the user\'s CodeHub projects.', path: '/v1/projects',
            params: [{ name: 'per_page', type: 'number', required: false, description: 'Page size' }],
          },
          {
            name: 'list_branches', description: 'List branches of a repo.', path: '/v1/projects/{id}/repository/branches',
            params: [{ name: 'id', type: 'number', required: true, description: 'Project numeric id' }],
          },
          {
            name: 'create_mr', description: 'Create a merge request.', path: '/v1/projects/{id}/merge_requests',
            params: [
              { name: 'id', type: 'number', required: true, description: 'Project numeric id' },
              { name: 'source_branch', type: 'string', required: true, description: 'Source branch' },
              { name: 'target_branch', type: 'string', required: true, description: 'Target branch' },
              { name: 'title', type: 'string', required: true, description: 'MR title' },
            ],
          },
        ],
        notes: 'Intranet: resolve codehub-dg-g.huawei.com via /etc/hosts (hostAliases); keep the host inside NO_PROXY so requests go direct.',
      }),
    }],
    source: 'builtin',
  },
  {
    name: 'web-search',
    displayName: 'Web Search',
    description: 'Web search MCP server (stdio) — guides the agent through JSON-RPC tool calls against a local search sidecar.',
    version: '1.0.0',
    category: 'ai',
    transport: { type: 'stdio', command: 'npx', args: ['-y', '@mcp/web-search'] },
    security: { level: 'low', requiresAuth: false, scopes: [] },
    // Server-side executable tools. The referenced stdio sidecar needs
    // a SEARCH_API_KEY myco doesn't hold, so myco additionally provides
    // these direct fetch/read tools the session can always use.
    sdkTools: [
      { name: 'fetch_url', description: 'Fetch a public URL, strip HTML, return bounded cleaned text.',
        params: [
          { name: 'url', type: 'string', required: true, description: 'Absolute http(s) URL' },
          { name: 'maxChars', type: 'number', required: false, description: 'Max characters returned (default 20000)' },
        ] },
      { name: 'search_page', description: 'Fetch a URL and return only the paragraphs containing a keyword.',
        params: [
          { name: 'url', type: 'string', required: true, description: 'Absolute http(s) URL' },
          { name: 'keyword', type: 'string', required: true, description: 'Keyword to filter paragraphs by' },
        ] },
    ],
    skills: [{
      dirName: 'mcp-web-search',
      description: 'Guide for driving a stdio web-search MCP server with JSON-RPC over stdin/stdout.',
      guide: _stdioGuide({
        displayName: 'Web Search',
        command: 'npx',
        args: ['-y', '@mcp/web-search'],
        env: ['SEARCH_API_KEY'],
        tools: [
          {
            name: 'search', description: 'Search the web and return ranked results.',
            params: [
              { name: 'query', type: 'string', required: true, description: 'Search query' },
              { name: 'maxResults', type: 'number', required: false, description: 'Max hits (1-20, default 5)' },
            ],
          },
        ],
      }),
    }],
    source: 'builtin',
  },
  {
    name: 'filesystem',
    displayName: 'Filesystem Tools',
    description: 'Local filesystem MCP server (stdio, @modelcontextprotocol/server-filesystem) — read/write/search files via skill-guided JSON-RPC.',
    version: '1.0.0',
    category: 'files',
    transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
    security: { level: 'medium', requiresAuth: false, scopes: [] },
    skills: [{
      dirName: 'mcp-filesystem',
      description: 'Guide for the official filesystem MCP server: read/write/list files, search, get info via JSON-RPC stdio.',
      guide: _stdioGuide({
        displayName: 'Filesystem Tools',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        env: [],
        tools: [
          { name: 'read_file', description: 'Read a file as text.', params: [{ name: 'path', type: 'string', required: true, description: 'Absolute file path' }] },
          { name: 'write_file', description: 'Write text to a file.', params: [
            { name: 'path', type: 'string', required: true, description: 'Absolute file path' },
            { name: 'content', type: 'string', required: true, description: 'File contents' },
          ] },
          { name: 'list_directory', description: 'List a directory.', params: [{ name: 'path', type: 'string', required: true, description: 'Directory path' }] },
          { name: 'search_files', description: 'Glob-search files under a root.', params: [
            { name: 'path', type: 'string', required: true, description: 'Search root' },
            { name: 'pattern', type: 'string', required: true, description: 'Glob pattern' },
          ] },
        ],
        notes: 'Prefer the built-in Read/Write/Glob tools when they suffice; this MCP server is useful when a skill requires its exact semantics.',
      }),
    }],
    source: 'builtin',
  },
  {
    name: 'postgres',
    displayName: 'PostgreSQL',
    description: 'Postgres MCP server (stdio) — read-only schema introspection + parameterized queries, skill-guided.',
    version: '1.0.0',
    category: 'database',
    transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] },
    security: { level: 'high', requiresAuth: true, scopes: ['db:read'] },
    skills: [{
      dirName: 'mcp-postgres',
      description: 'Guide for the Postgres MCP server: list tables, describe schema, run parameterized SELECT queries.',
      guide: _stdioGuide({
        displayName: 'PostgreSQL',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres'],
        env: ['DATABASE_URL'],
        tools: [
          { name: 'list_tables', description: 'List tables in the public schema.', params: [] },
          { name: 'describe_table', description: 'Describe one table\'s columns.', params: [{ name: 'table', type: 'string', required: true, description: 'Table name' }] },
          { name: 'query', description: 'Run a read-only SQL query.', params: [{ name: 'sql', type: 'string', required: true, description: 'SELECT/WITH statement' }] },
        ],
        notes: 'Read-only by design. NEVER interpolate user text into SQL — pass parameters via the `arguments` object when the server supports it, else validate strictly.',
      }),
    }],
    source: 'builtin',
  },
];

module.exports = { builtinServers };
