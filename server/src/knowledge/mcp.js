// In-process SDK MCP server exposing the knowledge base to the agent.
//
// This is a THIN PROXY: every tool call becomes one HTTP request to the
// standalone KB service. myco holds no index, no vectors, no corpus — it
// only knows which KBs the session mounted.
//
// Tools (prefix mcp__myco_kb__):
//   search    — hybrid retrieval over papers + local notes
//   get       — fetch a chunk (and its neighbours) by id
//   related   — same-family / same-discipline papers
//   remember  — write a new conclusion/method/counterexample into the KB
//   notes     — list local knowledge items
//
// Only mounted when the session is in RESEARCH MODE (rec.researchMode) and
// the KB service is configured. A normal session gets no KB server at all,
// so its sdkOpts stay byte-identical to before.

'use strict';

const { createSdkMcpServer, tool } = require('@anthropic-ai/claude-agent-sdk');
const { z } = require('zod');

const client = require('./client');

const TOOL_PREFIX = 'mcp__myco_kb__';
const MAX_TEXT_CHARS = 20000;

function _txt(str, isError) {
  const s = String(str == null ? '' : str);
  return {
    content: [{
      type: 'text',
      text: s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) + '\n…[truncated]' : s,
    }],
    isError: !!isError,
  };
}

// Render search results as compact, citable text blocks.
function renderResults(data, query) {
  if (!data || !Array.isArray(data.results) || !data.results.length) {
    return `No matches for "${query}". Try broader terms, drop filters, or search in English (the corpus is English LaTeX).`;
  }
  const lines = [`${data.count} result(s) for "${query}"${data.vector ? ' (hybrid lexical+vector)' : ''}:`, ''];
  data.results.forEach((r, i) => {
    const flags = [
      r.kind,
      r.noteStatus ? `status=${r.noteStatus}` : null,
      r.noteConfidence ? `confidence=${r.noteConfidence}` : null,
      r.anchorName ? `“${r.anchorName}”` : null,
    ].filter(Boolean).join(' · ');
    lines.push(`${i + 1}. ${r.citation}  [${flags}]`);
    if (r.title) lines.push(`   ${r.title}`);
    lines.push(`   ${String(r.snippet || '').replace(/\n+/g, ' ')}`);
    if (r.sourcePath) lines.push(`   source: ${r.sourcePath}`);
    lines.push('');
  });
  lines.push('Cite as [KB:<paper-slug> §<section>] or [LOCAL:<note-slug>]. '
    + 'Local notes marked draft are unverified — treat them as hypotheses, not facts.');
  return lines.join('\n');
}

function createKbMcpServer(sessionId, kbs) {
  const mounted = Array.isArray(kbs) && kbs.length ? kbs.slice() : [];
  if (!mounted.length) return null;
  const defaultKb = mounted[0];

  const pickKb = (requested) => {
    const name = String(requested || defaultKb);
    if (!mounted.includes(name)) {
      return { error: `knowledge base "${name}" is not mounted on this session (mounted: ${mounted.join(', ')})` };
    }
    return { kb: name };
  };

  const tools = [
    tool(
      'search',
      'Search the domain knowledge base for papers, theorems, proofs, reasoning '
      + 'traces, and previously recorded local findings. Use this BEFORE deriving '
      + 'a result from scratch: someone may have already proved it, and a recorded '
      + 'failure may save you a dead end. Returns citable snippets.',
      {
        query: z.string().min(1).describe('Natural-language or keyword query. English works best; Chinese is supported.'),
        kb: z.string().optional().describe(`Knowledge base name (default "${defaultKb}").`),
        k: z.number().min(1).max(20).optional().describe('Number of results (default 6).'),
        kinds: z.array(z.enum([
          'body', 'theorem', 'proof', 'abstract', 'trace', 'lean', 'refs',
          'insight', 'method', 'counterexample', 'failure', 'lemma', 'reference',
        ])).optional().describe('Restrict to specific chunk kinds.'),
        source: z.enum(['corpus', 'local']).optional().describe('corpus = published papers; local = this project\'s notes.'),
        discipline: z.string().optional().describe('e.g. "Number theory", "Theoretical computer science".'),
        family: z.string().optional().describe('Result-family id, e.g. "002".'),
        includeVersions: z.boolean().optional().describe('Include superseded paper versions (default false).'),
        includeDeprecated: z.boolean().optional().describe('Include deprecated local notes (default false).'),
      },
      async (args) => {
        const pick = pickKb(args.kb);
        if (pick.error) return _txt(pick.error, true);
        const res = await client.search(pick.kb, args.query, {
          k: args.k, kinds: args.kinds, source: args.source,
          discipline: args.discipline, family: args.family,
          includeVersions: args.includeVersions,
          includeDeprecated: args.includeDeprecated,
        });
        if (!res.ok) return _txt(`knowledge base unavailable: ${res.error}`, true);
        return _txt(renderResults(res.data, args.query));
      },
    ),

    tool(
      'get',
      'Fetch the full text of one retrieved chunk (and its neighbouring chunks) '
      + 'by chunk id. Use after `search` when a snippet looks directly relevant '
      + 'and you need the complete statement or proof.',
      {
        chunkId: z.number().describe('chunkId from a search result.'),
        kb: z.string().optional(),
        neighbours: z.boolean().optional().describe('Include adjacent chunks (default true).'),
      },
      async (args) => {
        const pick = pickKb(args.kb);
        if (pick.error) return _txt(pick.error, true);
        const res = await client.getChunk(pick.kb, args.chunkId, { neighbours: args.neighbours !== false });
        if (!res.ok) return _txt(`knowledge base unavailable: ${res.error}`, true);
        const { chunk, neighbours } = res.data;
        const parts = [`${chunk.citation}  [${chunk.kind}]`, '', chunk.snippet];
        if (chunk.sourcePath) parts.push('', `source: ${chunk.sourcePath}`);
        if (Array.isArray(neighbours) && neighbours.length) {
          parts.push('', '── adjacent chunks ──');
          for (const n of neighbours) {
            if (n.chunkId === chunk.chunkId) continue;
            parts.push('', `${n.citation}  [${n.kind}]`, n.snippet);
          }
        }
        return _txt(parts.join('\n'));
      },
    ),

    tool(
      'related',
      'Find papers related to a given paper: same result family first, then the '
      + 'same discipline. Useful for finding companion proofs and alternative arguments.',
      {
        paper: z.string().optional().describe('Paper slug from a citation.'),
        family: z.string().optional().describe('Result-family id, e.g. "002".'),
        kb: z.string().optional(),
        limit: z.number().min(1).max(20).optional(),
      },
      async (args) => {
        const pick = pickKb(args.kb);
        if (pick.error) return _txt(pick.error, true);
        const res = await client.related(pick.kb, { paper: args.paper, family: args.family, limit: args.limit });
        if (!res.ok) return _txt(`knowledge base unavailable: ${res.error}`, true);
        const rows = res.data.related || [];
        if (!rows.length) return _txt('No related papers found.');
        return _txt(rows.map((r) =>
          `[KB:${r.paperSlug}] ${r.title || ''} (${r.relation}, family ${r.familyId || '?'})`).join('\n'));
      },
    ),

    tool(
      'remember',
      'Record a NEW, REUSABLE finding into the project knowledge base: a proved '
      + 'statement, a working method, a counterexample, or a dead end worth '
      + 'avoiding. Do NOT record process narration, restatements of the question, '
      + 'or anything already in the KB. Entries are saved as Markdown under '
      + 'the knowledge base notes directory with status=draft and become searchable immediately.',
      {
        title: z.string().min(3).max(160).describe('One-line statement of the finding.'),
        content: z.string().min(10).max(8000).describe(
          'Markdown body. Prefer sections: "## 结论", "## 依据" (cite [KB:...]), "## 适用边界".'),
        kind: z.enum(['insight', 'method', 'counterexample', 'failure', 'lemma', 'reference'])
          .describe('failure = a dead end / negative result; counterexample = a refutation.'),
        tags: z.array(z.string()).max(8).optional(),
        sourceChunkIds: z.array(z.number()).max(20).optional()
          .describe('chunkIds this finding was derived from.'),
        confidence: z.enum(['low', 'medium', 'high']).optional(),
        kb: z.string().optional(),
      },
      async (args) => {
        const pick = pickKb(args.kb);
        if (pick.error) return _txt(pick.error, true);
        const res = await client.remember(pick.kb, {
          title: args.title,
          content: args.content,
          kind: args.kind,
          tags: args.tags,
          confidence: args.confidence,
          source: { session: sessionId, chunks: args.sourceChunkIds || [] },
        });
        if (!res.ok) return _txt(`knowledge base unavailable: ${res.error}`, true);
        const d = res.data;
        return _txt(`${d.created ? 'Created' : 'Merged into'} ${d.kind}/${d.slug}.md `
          + `(status=${d.status}). It is searchable now.`);
      },
    ),

    tool(
      'notes',
      'List the local knowledge items recorded for this project (drafts, verified '
      + 'findings, deprecated entries). Use to see what the team already knows '
      + 'before recording something new.',
      {
        kind: z.enum(['insight', 'method', 'counterexample', 'failure', 'lemma', 'reference']).optional(),
        status: z.enum(['draft', 'verified', 'deprecated']).optional(),
        limit: z.number().min(1).max(200).optional(),
        kb: z.string().optional(),
      },
      async (args) => {
        const pick = pickKb(args.kb);
        if (pick.error) return _txt(pick.error, true);
        const res = await client.listNotes(pick.kb, { kind: args.kind, status: args.status, limit: args.limit });
        if (!res.ok) return _txt(`knowledge base unavailable: ${res.error}`, true);
        const rows = res.data.notes || [];
        if (!rows.length) return _txt('No local notes yet.');
        return _txt(rows.map((r) =>
          `${r.slug}  [${r.kind}/${r.status}]  ${r.title}  (hits=${r.hits})`).join('\n'));
      },
    ),
  ];

  return createSdkMcpServer({
    name: 'myco_kb',
    version: '1.0.0',
    tools,
  });
}

module.exports = { createKbMcpServer, TOOL_PREFIX, renderResults };
