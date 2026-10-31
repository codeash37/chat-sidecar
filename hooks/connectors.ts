// Connectors: which tool calls count as a connector use, the connector's display name and row key, and what a call
// says (its call text and summary). Pure functions; the main module keeps the counts.

/** This mod's own server: its tools (plan, assign_task, ...) are never a connector. */
export const OWN_SERVER = 'chat-sidecar'

/** An MCP tool name as server and tool part; null for anything else. */
export function splitMcp(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.*?)__(.*)$/s.exec(name)
  if (!m) return null
  return { server: m[1] ?? '', tool: m[2] ?? '' }
}

/** Whether an MCP call counts as a connector use: not an empty or `ccd_` server, not this mod's own. */
export function isCountedServer(server: string): boolean {
  return server !== '' && !server.startsWith('ccd_') && server !== OWN_SERVER
}

/** A claude.ai connector's server: 8 hex characters, a dash, then hex and dashes (differs per account). */
export function isRandomId(server: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f-]+$/i.test(server)
}

const KNOWN: Record<string, string> = {
  apify: 'Apify',
  attio: 'Attio',
  calendly: 'Calendly',
  'chat-relay': 'Chat Relay',
  circle: 'Circle',
  'circle-community': 'Circle',
  'claude-in-chrome': 'Chrome',
  claude_browser: 'Browser',
  composio: 'Composio',
  figma: 'Figma',
  firecrawl: 'Firecrawl',
  fireflies: 'Fireflies',
  github: 'GitHub',
  gmail: 'Gmail',
  'google-calendar': 'Google Calendar',
  'google-drive': 'Google Drive',
  'google-workspace': 'Google Workspace',
  handoff: 'Handoff',
  higgsfield: 'Higgsfield',
  hubspot: 'HubSpot',
  kit: 'Kit',
  linear: 'Linear',
  make: 'Make',
  notion: 'Notion',
  pandadoc: 'PandaDoc',
  pipedrive: 'Pipedrive',
  posthog: 'PostHog',
  reddit: 'Reddit',
  shopify: 'Shopify',
  slack: 'Slack',
  stripe: 'Stripe',
  supabase: 'Supabase',
  vercel: 'Vercel',
  vidiq: 'vidIQ',
  youtube: 'YouTube',
}

/** The fallback name of a connector nothing names. */
export const FALLBACK_NAME = 'Connector'

const titleCase = (s: string) =>
  s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')

/** A readable server's display name: `plugin_<plugin>_` and `claude_ai_` stripped, then the known list, else title case. */
export function readableName(server: string): string {
  const rest = server.replace(/^plugin_[^_]+_/i, '').replace(/^claude_ai_/i, '')
  return KNOWN[rest.toLowerCase()] ?? (titleCase(rest) || FALLBACK_NAME)
}

const word = (w: string) => new RegExp(`(^|[-_])${w}($|[-_])`, 'i')
const exact = (...names: string[]) => (t: string) => names.includes(t.toLowerCase())
const prefix = (...ps: string[]) => (t: string) => ps.some(p => t.toLowerCase().startsWith(p))
const has = (...parts: string[]) => (t: string) => parts.some(p => t.toLowerCase().includes(p))

/** Tool-name hints for random-id servers, in priority order; first match wins. */
const HINTS: readonly { name: string; test: (tool: string) => boolean }[] = [
  { name: 'Fireflies', test: prefix('fireflies_') },
  { name: 'Notion', test: prefix('notion-') },
  { name: 'vidIQ', test: prefix('vidiq_') },
  { name: 'Slack', test: prefix('slack_') },
  { name: 'Composio', test: prefix('composio_') },
  { name: 'Higgsfield', test: prefix('ads_studio_', 'ai_influencer_', 'scene_builder_3d_', 'shorts_studio_', 'tiktok_') },
  { name: 'Meta Ads', test: prefix('ads_') },
  {
    name: 'Calendly',
    test: t =>
      prefix('availability-', 'event_types-', 'meetings-', 'routing_forms-', 'scheduling_links-', 'shares-', 'locations-', 'users-', 'organizations-')(t) ||
      has('calendly')(t),
  },
  {
    name: 'Gmail',
    test: t =>
      exact('search_threads', 'get_thread', 'get_message', 'update_message_labels', 'forward', 'reply')(t) ||
      /^(list|get|create|update|delete)_drafts?$/i.test(t) ||
      /^(list|create|update|delete)_labels?$/i.test(t) ||
      /^(un)?label_(thread|message)$/i.test(t) ||
      /^(un)?trash_(thread|message)$/i.test(t) ||
      /^(un)?mark_(thread|message)_spam$/i.test(t) ||
      /^apply_sensitive_(thread|message)_label$/i.test(t) ||
      /^(forward|reply)_(message|thread|email)$/i.test(t),
  },
  { name: 'Google Calendar', test: exact('list_calendars', 'respond_to_event', 'suggest_time', 'search_events') },
  {
    name: 'Google Drive',
    test: exact('list_recent_files', 'search_files', 'read_file_content', 'download_file_content', 'get_file_metadata', 'get_file_permissions', 'share_file', 'trash_file', 'copy_file'),
  },
  {
    name: 'Google Sheets',
    test: exact('get_spreadsheet', 'get_values', 'update_values', 'append_values', 'batch_clear_values', 'update_formulas', 'insert_dimension', 'update_spreadsheet', 'copy_sheet_to_another_spreadsheet'),
  },
  { name: 'Kit', test: has('subscriber', 'broadcast', 'sequence', 'landing_page', 'snippet', 'growth_stats', 'email_template', 'creator_profile', 'email_stats') },
  {
    name: 'Circle',
    test: t =>
      has('community_member', 'space_group', 'space_member', 'course_lesson', 'course_section', 'access_group', 'member_tag', 'tagged_member', 'live_room', 'gamification', 'paywall', 'flagged_content', 'filter_kit', 'post_summary', 'advanced_search')(t) ||
      word('spaces?').test(t),
  },
  { name: 'Apify', test: t => /(^|-)(actors?|dataset)(-|$)/i.test(t) || has('apify', 'key-value-store')(t) },
  {
    name: 'Attio',
    test: t =>
      /(^|-)records?(-|$)/i.test(t) ||
      prefix('semantic-search-')(t) ||
      has('call-recording', 'run-basic-report', '-list-entry-')(t) ||
      /-workspace-(members|teams)$/i.test(t) ||
      /attribute-definitions$/i.test(t),
  },
  {
    name: 'Make',
    test: t =>
      /^(scenarios?|scenario-[a-z-]+|data-stores?|data-store-records|data-structures?|hooks|hook-[a-z-]+|executions|credential-requests|app-modules?|connections|connection-[a-z-]+)_/i.test(t),
  },
  {
    name: 'Supabase',
    test: exact('apply_migration', 'execute_sql', 'list_migrations', 'list_tables', 'list_extensions', 'generate_typescript_types', 'get_advisors', 'get_publishable_keys', 'get_project_url', 'deploy_edge_function', 'list_edge_functions', 'get_edge_function', 'create_edge_function_secret'),
  },
  {
    name: 'Vercel',
    test: t => has('deployment', 'vercel', 'edge_config', 'project_domain', 'sandboxes', 'named_sandbox', 'toolbar_', 'rolling_release', 'kms_')(t) || /_drains?$/i.test(t),
  },
  {
    name: 'Figma',
    test: t =>
      exact('get_design_context', 'get_figjam', 'use_figma', 'get_figma_skill', 'get_variable_defs', 'create_design_system_rules', 'search_design_system', 'send_code_to_figma', 'add_code_connect_map', 'get_motion_context')(t) ||
      has('code_connect', 'shader', 'generative_plugin')(t) ||
      prefix('weave_')(t),
  },
  { name: 'AnyMailFinder', test: t => /^find_(person|company|decision_maker)_emails?$/i.test(t) || exact('verify_email', 'report_bad_email')(t) },
  {
    name: 'Vibe Prospecting',
    test: t => /^(match|enrich)-(business|businesses|prospects?)/i.test(t) || exact('fetch-entities', 'fetch-businesses-events', 'fetch-prospects-events', 'fetch-entities-statistics')(t),
  },
  {
    name: 'YouTube',
    test: t =>
      ['getTranscripts', 'getVideoDetails', 'searchVideos', 'getChannelStatistics', 'getVideoComments', 'getTrendingVideos', 'getChannelTopVideos', 'getVideoCategories'].includes(t),
  },
]

/** The first hint a random-id server's tool matches, or undefined. */
export function hintOf(tool: string): string | undefined {
  return HINTS.find(h => h.test(tool))?.name
}

/**
 * The display name of an MCP server. A random-id server is named by its tool (hints), the match remembered in
 * `memory` for that server id, so its other tools get the same name; nothing found: `Connector`. A raw id never shows.
 */
export function serverName(server: string, tool: string, memory: Map<string, string>): string {
  const stripped = server.replace(/^plugin_[^_]+_/i, '').replace(/^claude_ai_/i, '')
  if (!isRandomId(server) && !isRandomId(stripped)) return readableName(server)
  const hinted = hintOf(tool)
  if (hinted !== undefined) {
    memory.set(server, hinted)
    return hinted
  }
  return memory.get(server) ?? FALLBACK_NAME
}

/** A row's key: the display name lower-cased, a-z0-9 only; googleworkspace -> google, metaads -> meta. */
export function rowKey(name: string): string {
  const k = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  return k === 'googleworkspace' ? 'google' : k === 'metaads' ? 'meta' : k
}

/**
 * An MCP call's text: the tool part split on `-`, `_` and spaces, lower-cased; leading words dropped while more than
 * one remains and the word is the row key, a word of the display name, or `s` + digits.
 */
export function mcpCallText(tool: string, name: string): string {
  const words = tool.toLowerCase().split(/[-_\s]+/).filter(Boolean)
  const key = rowKey(name)
  const nameWords = new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  while (words.length > 1 && (words[0] === key || nameWords.has(words[0]!) || /^s\d+$/.test(words[0]!))) words.shift()
  return words.join(' ')
}

/** A subagent step's words for an MCP tool: camelCase split, lower-cased, a leading repeat of the name's first word dropped. */
export function stepWords(tool: string, name: string): string {
  const words = tool
    .replace(/__/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase())
  const first = name.split(/\s+/)[0]?.toLowerCase()
  if (words.length > 1 && words[0] === first) words.shift()
  return words.join(' ')
}

/** At most `n` characters, ending in `…` when shortened. */
export function cut(text: string, n: number): string {
  return text.length <= n ? text : text.slice(0, Math.max(0, n - 1)) + '…'
}

/** Whitespace collapsed to single spaces, trimmed. */
export function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

const SUMMARY_KEYS = [
  'query', 'q', 'search', 'searchQuery', 'keyword', 'keywords', 'url', 'file_path', 'path', 'filename', 'fileName', 'name', 'title',
  'subject', 'transcriptId', 'threadId', 'messageId', 'documentId', 'spreadsheetId', 'fileId', 'pageId', 'eventId', 'calendarId', 'id',
  'email', 'channel', 'prompt', 'skill', 'command',
]
const META_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'hook_event_name', 'session_id', 'transcript_path', 'cwd', 'permission_mode', 'surface', 'requestMeta'])

/** A string that looks like a path keeps its last segment. */
function lastIfPath(s: string): string {
  return /^[~/.]/.test(s) && s.includes('/') ? (s.replace(/\/+$/, '').split('/').pop() ?? s) : s
}

/** An MCP call's main argument, cut to 60; empty when it has none. */
export function mcpSummary(input: Readonly<Record<string, unknown>>): string {
  const done = (s: string) => cut(flat(lastIfPath(s)), 60)
  const isText = (v: unknown): v is string | number => (typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && Number.isFinite(v))
  for (const k of SUMMARY_KEYS) {
    const v = input[k]
    if (isText(v)) return done(String(v))
  }
  const rest = Object.entries(input).filter(([k]) => !META_KEYS.has(k) && !SUMMARY_KEYS.includes(k))
  const str = rest.find(([, v]) => typeof v === 'string' && v.trim() !== '')
  if (str) return done(String(str[1]))
  const scalar = rest.find(([, v]) => typeof v === 'number' || typeof v === 'boolean')
  return scalar ? cut(`${scalar[0]} ${String(scalar[1])}`, 60) : ''
}

/** A connector use found in a Bash command. */
export type CliCall = { name: string; text: string; summary: string }

const GWS_SERVICES: Record<string, string> = {
  calendar: 'Google Calendar',
  docs: 'Google Docs',
  drive: 'Google Drive',
  gmail: 'Gmail',
  sheets: 'Google Sheets',
}

const CLI = /(?:^|[;&|(\n`]|(?:^|\s)(?:do|then)(?=\s))[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*(gws|firecrawl|youtube-pp-cli|browser-harness|agent-browser)(?![\w.-])([^;&|\n`)]*)/g

const isPlain = (w: string | undefined): w is string => w !== undefined && /^[a-z][a-z0-9_-]*$/.test(w)

/** The CLI summary: a known key in JSON params, else the first http(s) URL, else what is left of the line. */
function cliSummary(args: string, leading: number): string {
  const json = /\\?["'](q|query|id|fileId|spreadsheetId|documentId|calendarId|url)\\?["']\s*:\s*\\?["']([^"'\\]+)/.exec(args)
  if (json?.[2]) return cut(flat(json[2]), 60)
  const url = /https?:\/\/[^\s"'<>]+/.exec(args)
  if (url) return cut(url[0], 60)
  const words = flat(args.replace(/<<-?\s*['"]?\w+['"]?/g, ' ')).split(' ').filter(Boolean)
  return cut(words.slice(leading).join(' '), 60)
}

/** The connector uses in one Bash command (several per command; identical ones counted once). */
export function parseCli(command: string): CliCall[] {
  const out: CliCall[] = []
  const seen = new Set<string>()
  for (const m of command.matchAll(CLI)) {
    const cmd = m[1]!
    const args = m[2] ?? ''
    const words = flat(args).split(' ').filter(Boolean)
    let call: CliCall
    if (cmd === 'gws') {
      const service = words[0]
      const known = service !== undefined ? GWS_SERVICES[service] : undefined
      const from = known ? 1 : 0
      const sub: string[] = []
      for (let i = from; i < words.length && sub.length < 3 && isPlain(words[i]); i++) sub.push(words[i]!)
      const text = sub.length > 0 ? sub.join(' ') : (service ?? 'run')
      call = { name: known ?? 'Google Workspace', text, summary: cliSummary(args, from + sub.length) }
    } else if (cmd === 'firecrawl' || cmd === 'youtube-pp-cli') {
      const sub = isPlain(words[0]) ? words[0] : undefined
      call = { name: cmd === 'firecrawl' ? 'Firecrawl' : 'YouTube', text: sub ? sub.replace(/-/g, ' ') : 'run', summary: cliSummary(args, sub ? 1 : 0) }
    } else {
      call = { name: 'Browser', text: 'run script', summary: '' }
    }
    const id = `${call.name}\u0000${call.text}\u0000${call.summary}`
    if (!seen.has(id)) {
      seen.add(id)
      out.push(call)
    }
  }
  return out
}
