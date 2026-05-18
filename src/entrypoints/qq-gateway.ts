import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import YAML from 'yaml'

type BridgeConfig = {
  enabled: boolean
  gateway_url: string
  gateway_token: string
  mcp_token: string
  route_prefix: string
  forward_timeout_ms: number
  ai_turn_timeout_ms?: number
  ai_idle_timeout_ms?: number
  minimax_mcp?: {
    enabled?: boolean
    command?: string
    args?: string[]
    api_host?: string
    base_path?: string
    resource_mode?: string
  }
  llm?: {
    primary_provider?: string
    fallback_provider?: string
    docs_url?: string
    usage_dashboard_url?: string
    usage_account?: string
    usage_password?: string
    providers?: Record<string, ProviderConfig>
  }
  prompt?: {
    identity?: string
    system_prompt_override?: string
    system_prompt_append?: string
    structured_analysis_turn_policy?: string
    character_list_turn_policy?: string
  }
  catalog?: {
    path?: string
  }
}

type ProviderConfig = {
  enabled?: boolean
  type?: string
  name?: string
  base_url: string
  api_key: string
  model: string
  models?: string[]
  headers?: Record<string, string>
  extra_body?: Record<string, unknown>
}

type ChatConfig = {
  default_provider?: string
  providers?: Record<string, ProviderConfig>
}

type ServerConfig = {
  port?: number
}

type InboundMessage = {
  session_key: string
  bot_id: string
  user_id: string
  group_id?: string
  scope: 'private' | 'group'
  message_id: string
  reply_to_message_id?: string
  text: string
  sender_nickname?: string
  adapter?: string
  network_enabled?: boolean
  is_master?: boolean
}

type RuntimeConfig = {
  yunzaiDir: string
  bridgeConfig: BridgeConfig
  chatConfig: ChatConfig
  provider: ProviderConfig
  providerName: string
  fallbackProvider: ProviderConfig | null
  fallbackProviderName: string
  availableProviders: Array<{ providerName: string; provider: ProviderConfig }>
  yunzaiBaseUrl: string
  runtimeDir: string
  gatewayPort: number
  litellmPort: number
}

type SessionRuntime = {
  generation: number
  canResume: boolean
  contextFingerprint: string
  hydrated: boolean
  queue: InboundMessage[]
  running: boolean
}

type TurnFailureDetails = {
  stdout_output?: string
  stderr_output?: string
  exit_code?: number | null
  exit_signal?: string | null
}

type SessionChatMessage = {
  role?: string
  text?: string
  message_id?: string
  source?: string
  created_at?: number
}

type BridgeRuntimeContext = {
  session_key?: string
  scope?: string
  self_id?: string
  user_id?: string
  reply_target_user_id?: string
  group_id?: string
  sender_nickname?: string
  game?: string
  last_user_text?: string
  current_query_character_resolution?: unknown
  recent_observations?: unknown[]
  recent_chat_messages?: SessionChatMessage[]
  structured_caches?: unknown[]
  player_cache_overview?: {
    gs?: { uid?: string; profile_count?: number } | null
    sr?: { uid?: string; profile_count?: number } | null
  } | null
  capability_registry?: {
    schema_version?: string
    version?: number
    fingerprint?: string
    built_at?: number
    built_at_iso?: string
    count?: number
    source?: string
    dynamic?: boolean
    counts_by_domain?: Record<string, number>
  } | null
  updated_at?: number
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CC_HAHA_ROOT = path.resolve(__dirname, '../..')
const YUNZAI_DIR = process.env.YUNZAI_DIR || '/home/yingying/yunzai'
const BRIDGE_CONFIG_PATH = path.join(YUNZAI_DIR, 'config/cc-haha-bridge.yaml')
const CHAT_CONFIG_PATH = path.join(YUNZAI_DIR, 'config/yingying-local-chat.yaml')
const SERVER_CONFIG_PATH = path.join(YUNZAI_DIR, 'config/config/server.yaml')
const RUNTIME_DIR = path.join(CC_HAHA_ROOT, 'runtime', 'qq-gateway')
const BUN_BIN = process.env.CC_HAHA_BUN_BIN || '/home/yingying/.bun/bin/bun'
const LITELLM_BIN = process.env.LITELLM_BIN || '/home/yingying/.local/bin/litellm'
const CLAUDE_BIN = path.join(CC_HAHA_ROOT, 'bin/claude-haha')
const MAX_QUEUE_SIZE = 5
const DEFAULT_TURN_TIMEOUT_MS = 240000
const DEFAULT_IDLE_TIMEOUT_MS = 45000
const SESSION_POLICY_VERSION = 11
const DEFAULT_BOT_IDENTITY = '草莓果酱，永新县爱荧科技有限责任公司开发的机器人。'
const DEFAULT_MINIMAX_API_BASE = 'https://v2.aicodee.com'
const DEFAULT_MINIMAX_MODEL = 'MiniMax-M2.5-highspeed'
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-pro'
const DEFAULT_STRUCTURED_ANALYSIS_TURN_POLICY = [
  '这是一个结构化角色分析请求。',
  '必须先读取结构化缓存，再输出结论。',
  '推荐顺序：yunzai_get_user_runtime_context -> yunzai_resolve_character_name（如有角色名/别称）-> yunzai_read_cached_player_data。',
  '最多允许 3 次工具调用：读取上下文、解析角色名、读取结构化缓存。',
  '一旦 yunzai_read_cached_player_data 成功返回目标角色数据，必须立即基于缓存字段直接回答并结束，不要继续搜索命令，不要继续更新面板，不要再读别的工具。',
  '如果用户没有点名某一个角色，而是在问“整体练度”“角色练度”“阵容练度”“养成情况”，优先使用 roster_summary、top_invested_profiles、low_level_five_stars 这类汇总字段直接给出整体评价，不要继续索取面板图，也不要抱着整份 profiles 空转。',
  '如果缓存里已经有目标角色数据，禁止再调用 #角色面板、#原神面板更新、#米游社更新面板、#角色攻略 这类命令。',
  '在没有先读取结构化缓存之前，不要先跑面板图命令，不要让用户点按钮，不要输出通用模板建议。',
  '最终回答必须引用缓存里的具体字段和数值，例如等级、命座、天赋、武器、攻击、双暴、元素伤、精通、充能、圣遗物评分；如果做不到，先继续读缓存，不要空谈。',
  '如果用户问的是“伤害如何”“整体输出循环”“还可以怎么优化”，拿到缓存后就直接分析，不要继续自问自答，也不要反复工具调用。',
].join('\n')

const DEFAULT_CHARACTER_LIST_TURN_POLICY = [
  '这是一个角色列表查询请求。',
  '优先顺序固定为：yunzai_get_user_runtime_context -> yunzai_read_cached_player_data。',
  '先直接从本地结构化缓存读取 profiles 列表。',
  '如果当前 turn prompt 的 runtime context snapshot 已经显示 gs_uid 或 gs_profile_count > 0，就说明当前用户已经存在有效绑定和本地角色缓存；此时禁止回答“没绑定 UID”“没找到绑定记录”这类结论。',
  '如果 yunzai_read_cached_player_data 返回 missing_bound_uid，说明当前用户还没有查询目标 UID；此时应直接指导用户发送「#绑定uid」或「#绑定+UID」，不要继续尝试其他工具或命令。',
  '如果缓存里已经有角色列表，优先使用 roster_summary.grouped_names 和 counts 回答，不要自己猜五星/四星/特殊分类，也不要凭常识补角色星级。',
  '如果缓存里已经有角色列表，默认直接按角色名回答；只有当用户明确要看图、看面板列表、看截图样式结果时，才补充角色列表命令或图片。',
  '如果命令返回了角色列表图片，图片可以作为补充信息源，但不要因为看图而忽略缓存，也不要在同一组图上反复视觉分析直到 max turns。',
  '不要发明不存在的命令；角色列表只允许使用命令目录里真实存在的命令。',
].join('\n')

const state = {
  config: null as RuntimeConfig | null,
  sessions: new Map<string, SessionRuntime>(),
  litellm: null as ChildProcessWithoutNullStreams | null,
  litellmReady: false,
}

function nowIso(): string {
  return new Date().toISOString()
}

function logTurn(payload: Pick<InboundMessage, 'session_key' | 'message_id' | 'text'>, message: string): void {
  process.stdout.write(
    `[qq-gateway] [${payload.session_key}][${payload.message_id}] ${message}${payload.text ? ` | ${payload.text}` : ''}\n`,
  )
}

function logTurnDebug(payload: Pick<InboundMessage, 'session_key' | 'message_id'>, message: string): void {
  process.stdout.write(
    `[qq-gateway] [${payload.session_key}][${payload.message_id}] ${message}\n`,
  )
}

function previewText(text: string, max = 320): string {
  const normalized = String(text || '')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n')
    .trim()
  if (!normalized) return ''
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max)}...`
}

function deterministicSessionId(sessionKey: string): string {
  const hex = createHash('sha1').update(sessionKey).digest('hex')
  const a = hex.slice(0, 8)
  const b = hex.slice(8, 12)
  const c = `5${hex.slice(13, 16)}`
  const d = `a${hex.slice(17, 20)}`
  const e = hex.slice(20, 32)
  return `${a}-${b}-${c}-${d}-${e}`
}

function computeRuntimeContextFingerprint(context: BridgeRuntimeContext | null): string {
  if (!context) return ''
  const normalized = {
    session_key: String(context.session_key || '').trim(),
    user_id: String(context.user_id || '').trim(),
    reply_target_user_id: String(context.reply_target_user_id || '').trim(),
    game: String(context.game || '').trim(),
    gs_uid: String(context.player_cache_overview?.gs?.uid || '').trim(),
    gs_profile_count: Number(context.player_cache_overview?.gs?.profile_count || 0),
    sr_uid: String(context.player_cache_overview?.sr?.uid || '').trim(),
    sr_profile_count: Number(context.player_cache_overview?.sr?.profile_count || 0),
    structured_cache_count: Array.isArray(context.structured_caches) ? context.structured_caches.length : 0,
    capability_registry_version: Number(context.capability_registry?.version || 0),
    capability_registry_fingerprint: String(context.capability_registry?.fingerprint || '').trim(),
    capability_registry_count: Number(context.capability_registry?.count || 0),
  }
  return createHash('sha1').update(JSON.stringify(normalized)).digest('hex')
}

function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= 180) return sanitized
  const digest = createHash('sha1').update(name).digest('hex').slice(0, 12)
  return `${sanitized.slice(0, 180)}-${digest}`
}

async function sessionTranscriptExists(config: RuntimeConfig, sessionId: string): Promise<boolean> {
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
  const transcriptPath = path.join(
    claudeConfigDir,
    'projects',
    sanitizePath(config.yunzaiDir),
    `${sessionId}.jsonl`,
  )
  try {
    await access(transcriptPath)
    return true
  } catch {
    return false
  }
}

async function readYamlFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return (YAML.parse(raw) ?? fallback) as T
  } catch {
    return fallback
  }
}

async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const bridge = await readYamlFile<BridgeConfig>(BRIDGE_CONFIG_PATH, {
    enabled: true,
    gateway_url: 'http://127.0.0.1:4317',
    gateway_token: 'local-cc-haha-gateway',
    mcp_token: 'local-cc-haha-mcp',
    route_prefix: '/cc-haha-bridge',
    forward_timeout_ms: 4000,
    minimax_mcp: {
      enabled: true,
      command: '/home/yingying/.local/bin/uvx',
      args: ['minimax-coding-plan-mcp', '-y'],
      api_host: DEFAULT_MINIMAX_API_BASE,
      base_path: path.join(RUNTIME_DIR, 'minimax-mcp'),
      resource_mode: 'url',
    },
    llm: {
      primary_provider: 'minimax',
      fallback_provider: 'deepseek',
      docs_url: 'https://lcnwoe31c51t.feishu.cn/wiki/A892wYxnVippRXkviJRcw7LBnGV?from=from_copylink',
      usage_dashboard_url: 'http://v2api.aicodee.com/chaxun',
      usage_account: process.env.CC_HAHA_USAGE_ACCOUNT || '',
      usage_password: process.env.CC_HAHA_USAGE_PASSWORD || '',
      providers: {
        minimax: {
          enabled: true,
          type: 'openai-compatible',
          name: 'MiniMax',
          base_url: DEFAULT_MINIMAX_API_BASE,
          api_key: process.env.MINIMAX_API_KEY || '',
          model: DEFAULT_MINIMAX_MODEL,
          models: ['MiniMax-M2.5-highspeed', 'MiniMax-M2.7-highspeed'],
          headers: {},
          extra_body: {},
        },
      },
    },
    prompt: {
      identity: DEFAULT_BOT_IDENTITY,
      system_prompt_override: '',
      system_prompt_append: '',
      structured_analysis_turn_policy: DEFAULT_STRUCTURED_ANALYSIS_TURN_POLICY,
      character_list_turn_policy: DEFAULT_CHARACTER_LIST_TURN_POLICY,
    },
  })
  const chatConfig = await readYamlFile<ChatConfig>(CHAT_CONFIG_PATH, {})
  const serverConfig = await readYamlFile<ServerConfig>(SERVER_CONFIG_PATH, { port: 2536 })
  const { providerName, provider, fallbackProviderName, fallbackProvider, availableProviders } = resolveProviders(bridge, chatConfig)
  const gatewayUrl = String(bridge.gateway_url || 'http://127.0.0.1:4317')
  const gatewayPort = Number(new URL(gatewayUrl).port || 4317)
  return {
    yunzaiDir: YUNZAI_DIR,
    bridgeConfig: bridge,
    chatConfig,
    provider,
    providerName,
    fallbackProvider,
    fallbackProviderName,
    availableProviders,
    yunzaiBaseUrl: `http://127.0.0.1:${Number(serverConfig.port || 2536)}`,
    runtimeDir: RUNTIME_DIR,
    gatewayPort,
    litellmPort: Number(process.env.CC_HAHA_LITELLM_PORT || 4400),
  }
}

function normalizeProviderConfig(providerName: string, input: Partial<ProviderConfig> | undefined | null): ProviderConfig | null {
  if (!input || typeof input !== 'object') return null
  const base_url = String(input.base_url || '').trim()
  const api_key = String(input.api_key || '').trim()
  const model = String(input.model || '').trim()
  const enabled = input.enabled !== false
  if (!enabled || !base_url || !api_key || !model) return null
  const models = Array.isArray(input.models)
    ? Array.from(new Set(input.models.map(item => String(item || '').trim()).filter(Boolean)))
    : []
  if (!models.includes(model)) models.unshift(model)
  return {
    enabled,
    type: String(input.type || 'openai-compatible').trim() || 'openai-compatible',
    name: String(input.name || providerName).trim() || providerName,
    base_url,
    api_key,
    model,
    models,
    headers: (input.headers && typeof input.headers === 'object') ? input.headers : {},
    extra_body: (input.extra_body && typeof input.extra_body === 'object') ? input.extra_body : {},
  }
}

function buildBridgeProviderDefaults(chatConfig: ChatConfig): Record<string, Partial<ProviderConfig>> {
  const deepseekFromChat = (chatConfig.providers?.deepseek || {}) as Partial<ProviderConfig>
  return {
    minimax: {
      enabled: true,
      type: 'openai-compatible',
      name: 'MiniMax',
      base_url: DEFAULT_MINIMAX_API_BASE,
      api_key: process.env.MINIMAX_API_KEY || '',
      model: DEFAULT_MINIMAX_MODEL,
      models: ['MiniMax-M2.5-highspeed', 'MiniMax-M2.7-highspeed'],
      headers: {},
      extra_body: {},
    },
    deepseek: {
      enabled: deepseekFromChat.enabled !== false,
      type: String(deepseekFromChat.type || 'openai-compatible').trim() || 'openai-compatible',
      name: String(deepseekFromChat.name || 'DeepSeek').trim() || 'DeepSeek',
      base_url: String(deepseekFromChat.base_url || 'https://api.deepseek.com').trim(),
      api_key: String(deepseekFromChat.api_key || '').trim(),
      model: String(deepseekFromChat.model || DEFAULT_DEEPSEEK_MODEL).trim() || DEFAULT_DEEPSEEK_MODEL,
      models: Array.isArray(deepseekFromChat.models)
        ? deepseekFromChat.models.map(item => String(item || '').trim()).filter(Boolean)
        : [DEFAULT_DEEPSEEK_MODEL, 'deepseek-reasoner'],
      headers: (deepseekFromChat.headers && typeof deepseekFromChat.headers === 'object') ? deepseekFromChat.headers : {},
      extra_body: (deepseekFromChat.extra_body && typeof deepseekFromChat.extra_body === 'object') ? deepseekFromChat.extra_body : {},
    },
  }
}

function resolveProviders(
  bridge: BridgeConfig,
  chatConfig: ChatConfig,
): {
  providerName: string
  provider: ProviderConfig
  fallbackProviderName: string
  fallbackProvider: ProviderConfig | null
  availableProviders: Array<{ providerName: string; provider: ProviderConfig }>
} {
  const bridgeDefaults = buildBridgeProviderDefaults(chatConfig)
  const rawBridgeProviders = (bridge.llm?.providers && typeof bridge.llm.providers === 'object') ? bridge.llm.providers : {}
  const candidateNames = Array.from(new Set([
    ...Object.keys(bridgeDefaults),
    ...Object.keys(chatConfig.providers || {}),
    ...Object.keys(rawBridgeProviders),
  ])).filter(Boolean)

  const availableProviders = candidateNames
    .map(providerName => {
      const merged = {
        ...(bridgeDefaults[providerName] || {}),
        ...((chatConfig.providers || {})[providerName] || {}),
        ...(rawBridgeProviders[providerName] || {}),
      } as Partial<ProviderConfig>
      const normalized = normalizeProviderConfig(providerName, merged)
      return normalized ? { providerName, provider: normalized } : null
    })
    .filter((item): item is { providerName: string; provider: ProviderConfig } => !!item)

  const providerMap = new Map(availableProviders.map(item => [item.providerName, item.provider]))
  const desiredPrimary = String(bridge.llm?.primary_provider || chatConfig.default_provider || 'deepseek').trim()
  const fallbackPrimary = availableProviders[0]
  const providerName = providerMap.has(desiredPrimary) ? desiredPrimary : (fallbackPrimary?.providerName || '')
  const provider = providerName ? providerMap.get(providerName) : null
  if (!providerName || !provider) {
    throw new Error('missing usable provider config in cc-haha-bridge.yaml/chat config')
  }

  const desiredFallback = String(
    bridge.llm?.fallback_provider
    || (providerName === 'deepseek' ? '' : 'deepseek'),
  ).trim()
  const fallbackProvider = desiredFallback && desiredFallback !== providerName
    ? (providerMap.get(desiredFallback) || null)
    : null

  return {
    providerName,
    provider,
    fallbackProviderName: fallbackProvider ? desiredFallback : '',
    fallbackProvider,
    availableProviders,
  }
}

function resolvePromptConfig(config: RuntimeConfig): Required<NonNullable<BridgeConfig['prompt']>> {
  const prompt = config.bridgeConfig.prompt || {}
  return {
    identity: String(prompt.identity || DEFAULT_BOT_IDENTITY).trim() || DEFAULT_BOT_IDENTITY,
    system_prompt_override: String(prompt.system_prompt_override || '').trim(),
    system_prompt_append: String(prompt.system_prompt_append || '').trim(),
    structured_analysis_turn_policy:
      String(prompt.structured_analysis_turn_policy || '').trim() || DEFAULT_STRUCTURED_ANALYSIS_TURN_POLICY,
    character_list_turn_policy:
      String(prompt.character_list_turn_policy || '').trim() || DEFAULT_CHARACTER_LIST_TURN_POLICY,
  }
}

async function ensureRuntimeDir(config: RuntimeConfig): Promise<void> {
  await mkdir(config.runtimeDir, { recursive: true })
  await mkdir(path.join(config.runtimeDir, 'mcp'), { recursive: true })
  await mkdir(path.join(config.runtimeDir, 'sessions'), { recursive: true })
  await mkdir(path.join(config.runtimeDir, 'turns'), { recursive: true })
  await mkdir(path.join(config.runtimeDir, 'minimax-mcp'), { recursive: true })
}

function getSessionStatePath(config: RuntimeConfig, sessionKey: string): string {
  const digest = createHash('sha1').update(sessionKey).digest('hex')
  return path.join(config.runtimeDir, 'sessions', `${digest}.json`)
}

function getRuntimeSessionId(sessionKey: string, generation: number): string {
  return deterministicSessionId(`${sessionKey}::${generation}`)
}

async function hydrateSessionRuntime(config: RuntimeConfig, sessionKey: string): Promise<SessionRuntime> {
  const session = getOrCreateSessionRuntime(sessionKey)
  if (session.hydrated) return session
  try {
    const raw = await readFile(getSessionStatePath(config, sessionKey), 'utf8')
    const parsed = JSON.parse(raw) as { generation?: number; can_resume?: boolean; policy_version?: number; context_fingerprint?: string }
    const savedGeneration = Number.isInteger(parsed.generation) ? Number(parsed.generation) : 0
    const savedPolicyVersion = Number.isInteger(parsed.policy_version) ? Number(parsed.policy_version) : 0
    if (savedPolicyVersion !== SESSION_POLICY_VERSION) {
      session.generation = savedGeneration + 1
      session.canResume = false
      session.contextFingerprint = ''
    } else {
      session.generation = savedGeneration
      session.canResume = parsed.can_resume === true
      session.contextFingerprint = typeof parsed.context_fingerprint === 'string' ? parsed.context_fingerprint : ''
    }
  } catch {
    session.generation = 0
    session.canResume = false
    session.contextFingerprint = ''
  }
  session.hydrated = true
  return session
}

async function persistSessionRuntime(
  config: RuntimeConfig,
  sessionKey: string,
  session: SessionRuntime,
): Promise<void> {
  await ensureRuntimeDir(config)
  await writeFile(
    getSessionStatePath(config, sessionKey),
    JSON.stringify(
      {
        generation: session.generation,
        can_resume: session.canResume,
        context_fingerprint: session.contextFingerprint || '',
        policy_version: SESSION_POLICY_VERSION,
        updated_at: nowIso(),
      },
      null,
      2,
    ),
    'utf8',
  )
}

async function writeRuntimeFiles(config: RuntimeConfig): Promise<{
  litellmConfigPath: string
  settingsPath: string
  promptPath: string
}> {
  await ensureRuntimeDir(config)
  const litellmConfigPath = path.join(config.runtimeDir, 'litellm-config.yaml')
  const settingsPath = path.join(config.runtimeDir, 'settings.json')
  const promptPath = path.join(config.runtimeDir, 'system-prompt.txt')

  const litellmConfig = {
    model_list: buildLiteLLMModelList(config),
    litellm_settings: {
      drop_params: true,
      use_chat_completions_url_for_anthropic_messages: true,
    },
  }

  const settings = {
    env: {
      ANTHROPIC_API_KEY: 'local-cc-haha-token',
      ANTHROPIC_AUTH_TOKEN: 'local-cc-haha-token',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.litellmPort}`,
      ANTHROPIC_MODEL: config.provider.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: config.provider.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: config.provider.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: config.provider.model,
      API_TIMEOUT_MS: String(Number(config.bridgeConfig.ai_turn_timeout_ms || DEFAULT_TURN_TIMEOUT_MS)),
      DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      NO_PROXY: '127.0.0.1,localhost',
    },
  }

  const promptConfig = resolvePromptConfig(config)
  const defaultPrompt = [
    '你是 cc-haha 驱动的 QQ/Yunzai 代码感知型运行时。',
    `你对外的固定身份是：${promptConfig.identity}`,
    `如果用户问你是谁、你能做什么、或让你自我介绍，必须优先使用“我是${promptConfig.identity.replace(/。+$/g, '')}”这一定义。`,
    '不要自称 Claude Code、Claude、Anthropic、cc-haha 运行时，也不要把自己介绍成“帮助你管理和操作 Yunzai 机器人”的通用开发工具。',
    '你的工作目录是 /home/yingying/yunzai，可以直接读取源码、配置和 data 文件。',
    'Yunzai 动态能力注册表由桥接层根据当前已加载插件实时生成，兼容文件在 /home/yingying/yunzai/data/cc-haha-bridge/command-catalog.json。',
    '默认优先顺序是：先读 runtime context 里的 capability_registry meta；如 version/fingerprint 变化，重新调用 yunzai_capability_search 确认当前真实能力；再执行真实 Yunzai 命令并解释真实结果。',
    '不要把插件能力写死在提示词里，也不要凭旧经验断言某插件、某命令一定存在或一定不存在；插件可能随时安装、卸载、禁用或更新。',
    '若用户请求明显对应现有机器人能力，优先使用 yunzai_capability_search；只有搜索结果仍有歧义时，再读取命令目录文件或真实源码确认命令。',
    '但如果 runtime context、structured_caches、player_cache_overview 或 yunzai_read_cached_player_data 已经证明本地结构化缓存存在，那么缓存读取优先于命令执行；不要在这种情况下继续把命令目录/命令执行放在缓存之前。',
    '绝对不要伪造命令已经执行成功的结果，也不要伪造抽卡、塔罗、面板、更新、攻略检索结果。',
    '如果用户消息是“确认/继续/取消/拒绝/算了”这类短回复，先调用 yunzai_get_user_runtime_context，查看 pending_confirmation，再决定继续执行还是取消。',
    '如果用户是在追问上一轮角色、面板、练度、培养、优化、这/那个角色，先调用 yunzai_get_user_runtime_context，检查 recent_observations、entity refs 和历史 bundle，再决定下一步；不要忽略同一会话里已经拿到过的历史结果。',
    '项目内已经有 miao-plugin 的正式角色别称表。若用户提到角色昵称、绰号、别称或错别字写法，例如“少女”“哥伦比亚”“可丽”，先调用 yunzai_resolve_character_name，把输入规范到正式角色名后再读缓存或执行命令。',
    '如果当前这条用户消息里已经明确提到了角色昵称、别称或正式角色名，那么这条显式角色指向的优先级高于 recent_observations 里的历史角色；不要被上一轮查看过的其他角色带偏。',
    '在决定“没有数据”之前，先调用 yunzai_get_user_runtime_context 或 yunzai_list_structured_caches，检查当前用户已经存在的结构化缓存源；不要忽略本地 JSON 缓存。',
    '如果用户的问题是“练度如何 / 还能怎么优化 / 值不值得养 / 怎么培养 / 锐评角色 / 培养顺序”这类需要结构化角色数据的请求，不能只依赖单一来源。应同时利用本地 PlayerData 缓存和角色面板图，两者互相校验。',
    '如果用户的问题是“伤害如何 / 练度如何 / 分析一下 / 怎么优化 / 怎么培养 / 锐评”这类结构化角色分析请求，不要只读缓存，也不要只看图片。默认策略应是：先定位角色，再读取结构化缓存，再获取或复用该角色的面板图，最后综合两种证据回答。',
    '对于这类结构化角色分析请求，优先顺序固定为：yunzai_get_user_runtime_context -> yunzai_resolve_character_name（若消息里出现角色名、别称、昵称或错别字）-> yunzai_read_cached_player_data -> 如当前回合/历史中还没有该角色的 panel_detail，则调用 yunzai_run_command_capture 获取角色面板图 -> 调用 yunzai_analyze_bundle_images 读取面板图 -> 综合 JSON 与图片结论回答。',
    '如果已经读取了结构化缓存，回答里必须引用具体字段或数值，例如等级、命座、武器、双暴、元素伤害、精通、天赋等级、圣遗物评分；如果已经读取了面板图，也要结合图片里可见的信息验证或补充结论。不要把“分析”写成大而空的常识说明。',
    '角色面板图是正式信息源之一，不是可有可无的附件。只要用户在问伤害、练度、优化、配装、毕业度这类问题，面板图原则上都应该看；除非当前会话已经有同角色、同版本、足够新的面板图结果。',
    '如果结构化缓存存在但缺少支撑结论的关键字段，而 yunzai_run_command_capture 已经返回了角色面板图、圣遗物图、天赋图这类图片结果，应继续调用 yunzai_analyze_bundle_images，把 bundle_ids 里的图片交给视觉模型读取，再把视觉结果作为补充证据。',
    '如果当前可用工具里存在官方 MiniMax MCP 的 understand_image，就优先用 understand_image 读取面板图；如果该工具不可用，再回退到 yunzai_analyze_bundle_images。',
    '只要命令结果里已经返回了图片 URL 或 bundle_ids，你就可以把这些图片交给 understand_image / yunzai_analyze_bundle_images，不要因为“不是用户直接上传的图片”就放弃看图。',
    '只有在你实际调用过 understand_image 或 yunzai_analyze_bundle_images 后，才能声称自己“看了面板图”“从图里看出”“根据图片可见”。不要把“知道有图片 URL”伪装成真正的视觉分析。',
    '除了 PlayerData，本项目还可能存在札记缓存、抽卡缓存、星铁面板缓存等结构化 JSON。需要时优先调用 yunzai_read_structured_cache，而不是重复跑图片命令。',
    '调用 yunzai_run_command_capture 后，如果结果里有 bundle_ids、图片、按钮或结构化结果，应优先调用 qq_send_message 把真实结果发给用户，再补一句自然语言解释。',
    '对于需要确认的高风险系统操作，先调用 qq_request_confirmation，然后结束当前回合并等待用户下一条消息。',
    '低风险游戏写操作，例如原神面板更新，不需要确认，可以直接执行。',
    '对于“更新面板/面板更新”这类请求，必须优先选择带游戏前缀的精确命令；原神默认使用“#原神面板更新”，星铁默认使用“#星铁面板更新”。不要执行裸命令“#更新面板”。',
    '如果常规面板更新路径失败，允许改试“#米游社更新面板”这类备选命令。',
    '如果一次面板更新命令已经成功返回，就应直接基于该结果回复，不要继续尝试别的更新面板变体。',
    '如果某条命令返回了图片、按钮或 bundle_ids，即使暂时没有解析出结构化角色名，也不要据此断言“列表为空”“没有角色数据”或“失败”。特别是角色面板列表图，拿到图片本身就说明列表结果存在。',
    '如果 recent_observations 里已经存在同一角色的 panel_detail / panel_list / panel_refresh 历史结果，就不能再说“没有历史数据”或“完全没有可用信息”；应先基于这些历史结果继续分析，或者在确认结构化字段缺失后进入工程改造路径。',
    '本项目已经把角色缓存保存在 /home/yingying/yunzai/data/PlayerData 下。对于原神角色分析，优先读取这份结构化缓存，而不是把“只有面板图”当成唯一数据源。',
    '如果 yunzai_get_user_runtime_context 返回了 structured_caches，就应把这些缓存当作正式数据源使用。只有在相关缓存缺失、不存在或字段明显不足时，才继续尝试图片命令、联网补充或工程改造。',
    'follow-up 必须优先依赖上一轮真实结果中的 bundle、按钮、entity refs 和文本内容，不要靠硬编码关键词乱猜。',
    '如果用户是在问“你是谁”“你可以做什么”“你能干什么”“你会什么”，优先直接用简短自然语言回答能力概览，不要优先调用 #帮助、#喵喵帮助 之类帮助图片命令，除非用户明确要求看帮助图或命令列表。',
    '如果本地结果不足以回答最新攻略、活动、素材问题，再使用 WebSearch/WebFetch 联网补充，并在最终回答里给出来源。',
    '当用户明确要求你开发、修复、改造、增加工具、写适配器、读取结构化数据或直接让你改代码时，你可以直接在 /home/yingying/yunzai 和 /home/yingying/projects/cc-haha 内读取、编辑、创建文件，并可使用 Bash 运行必要的检索、构建和验证命令。',
    '如果用户没有明确要求改代码、修 bug、加能力或做工程改造，就不要主动修改仓库文件；普通聊天、普通命令执行、普通结果解释默认只读，不要擅自改代码。',
    '如果决定改代码，先阅读相关源码再动手，改动尽量聚焦，优先修根因，不要靠堆硬编码文案掩盖问题。',
    '对于“练度如何 / 锐评角色 / 怎么培养 / 培养顺序 / 哪些角色值得养 / 这个角色强不强 / 伤害如何 / 分析一下”这类需要结构化角色数据的问题，如果本地缓存已经存在，就先读缓存 JSON；只有在缓存不存在、字段明显不足或过旧时，才考虑继续走图片命令、联网补充或工程改造路径。',
    '对于这类练度/优化/培养/伤害分析请求，如果当前回合还没有拿到足够支撑结论的真实结构化数据，就不要直接输出通用建议、自评表、模板化毕业标准、常识说明，或让用户手动补一大串配置作为默认答案。',
    '遇到这种结构化数据缺口时，优先进入工程改造路径：先读 /home/yingying/yunzai 和 /home/yingying/projects/cc-haha 里的相关源码，必要时直接编写或修改适配器、读取器、桥接工具或 MCP 输出，让系统能读到结构化 JSON 数据；然后再基于真实数据回答用户问题。',
    '如果已经确认问题根因是“缺少结构化读取能力”，优先写代码补能力，而不是继续多次尝试 #角色面板、#面板更新、#攻略 这类相近命令。',
    '当你选择工程改造路径时，应该实际使用 Read/Grep/Glob/Bash/Edit/Write/TodoWrite 来完成改动，并在完成后运行最小验证；不要只口头建议“可以写代码”却不动手，也不要退回通用自评表或让用户手填配置作为默认答案。',
    '不要输出“我先判断一下”“我无法访问外部网站”这类旧链路废话。',
    '自我介绍和能力说明要简短、自然，贴近 QQ 机器人语气，不要写成产品说明书。',
  ].join('\n')
  const prompt = [promptConfig.system_prompt_override || defaultPrompt, promptConfig.system_prompt_append]
    .filter(Boolean)
    .join('\n\n')

  await writeFile(litellmConfigPath, YAML.stringify(litellmConfig), 'utf8')
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
  await writeFile(promptPath, prompt, 'utf8')

  return { litellmConfigPath, settingsPath, promptPath }
}

function getLiteLLMProviderModel(providerName: string, provider: ProviderConfig, model: string): string {
  const normalizedProviderName = String(providerName || '').trim().toLowerCase()
  const normalizedType = String(provider.type || '').trim().toLowerCase()
  if (normalizedProviderName === 'deepseek') return `deepseek/${model}`
  if (normalizedProviderName === 'ollama' || normalizedType === 'ollama') return `ollama/${model}`
  return `openai/${model}`
}

function normalizeOpenAICompatibleApiBase(baseUrl: string): string {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/g, '')
  if (!normalized) return ''
  if (/\/v1$/i.test(normalized)) return normalized
  return `${normalized}/v1`
}

function getLiteLLMApiBase(providerName: string, provider: ProviderConfig): string {
  const normalizedProviderName = String(providerName || '').trim().toLowerCase()
  const normalizedType = String(provider.type || '').trim().toLowerCase()
  if (normalizedProviderName === 'deepseek') return provider.base_url
  if (normalizedProviderName === 'ollama' || normalizedType === 'ollama') return provider.base_url
  if (normalizedType === 'openai-compatible' || getLiteLLMProviderModel(providerName, provider, provider.model).startsWith('openai/')) {
    return normalizeOpenAICompatibleApiBase(provider.base_url)
  }
  return provider.base_url
}

function buildLiteLLMModelList(config: RuntimeConfig): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  for (const { providerName, provider } of config.availableProviders) {
    const models = Array.isArray(provider.models) && provider.models.length ? provider.models : [provider.model]
    for (const model of models) {
      const modelName = String(model || '').trim()
      if (!modelName || seen.has(modelName)) continue
      seen.add(modelName)
      const litellmParams: Record<string, unknown> = {
        model: getLiteLLMProviderModel(providerName, provider, modelName),
        api_key: provider.api_key,
        api_base: getLiteLLMApiBase(providerName, provider),
      }
      if (provider.headers && Object.keys(provider.headers).length) {
        litellmParams.extra_headers = provider.headers
      }
      if (provider.extra_body && Object.keys(provider.extra_body).length) {
        litellmParams.extra_body = provider.extra_body
      }
      entries.push({
        model_name: modelName,
        litellm_params: litellmParams,
      })
    }
  }
  return entries
}

async function ping(url: string, headers?: Record<string, string>): Promise<boolean> {
  try {
    const resp = await fetch(url, { headers })
    return resp.ok || resp.status === 404
  } catch {
    return false
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function ensureLiteLLM(config: RuntimeConfig, litellmConfigPath: string): Promise<void> {
  if (state.litellmReady && await ping(`http://127.0.0.1:${config.litellmPort}/health`)) return

  if (state.litellm && state.litellm.exitCode == null) {
    state.litellm.kill('SIGTERM')
    state.litellm = null
    state.litellmReady = false
  }

  const child = spawn(
    LITELLM_BIN,
    [
      '--config',
      litellmConfigPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(config.litellmPort),
      '--telemetry',
      'False',
      '--max_tokens',
      '8192',
    ],
    {
      cwd: config.runtimeDir,
      env: {
        ...process.env,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        PYTHONUNBUFFERED: '1',
        DEBUG: '',
        LITELLM_MODIFY_PARAMS: 'true',
        LITELLM_DROP_PARAMS: 'true',
        LITELLM_USE_CHAT_COMPLETIONS_URL_FOR_ANTHROPIC_MESSAGES: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  child.stdout.on('data', chunk => {
    process.stdout.write(`[litellm] ${String(chunk)}`)
  })
  child.stderr.on('data', chunk => {
    process.stderr.write(`[litellm] ${String(chunk)}`)
  })
  child.on('exit', code => {
    state.litellmReady = false
    if (state.litellm === child) state.litellm = null
    process.stderr.write(`[qq-gateway] LiteLLM exited with code ${code}\n`)
  })

  state.litellm = child

  const healthUrl = `http://127.0.0.1:${config.litellmPort}/health`
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await ping(healthUrl)) {
      state.litellmReady = true
      return
    }
    await sleep(500)
  }

  throw new Error('LiteLLM proxy did not become ready')
}

async function buildMcpConfig(
  config: RuntimeConfig,
  sessionKey: string,
  turnId: string,
): Promise<string> {
  const minimaxMcp = config.bridgeConfig.minimax_mcp || {}
  const minimaxProvider = config.bridgeConfig.llm?.providers?.minimax
  const minimaxServer = minimaxMcp.enabled === false
    ? {}
    : {
        MiniMax: {
          command: String(minimaxMcp.command || '/home/yingying/.local/bin/uvx').trim() || '/home/yingying/.local/bin/uvx',
          args: Array.isArray(minimaxMcp.args) && minimaxMcp.args.length
            ? minimaxMcp.args.map(item => String(item || '').trim()).filter(Boolean)
            : ['minimax-coding-plan-mcp', '-y'],
          env: {
            MINIMAX_API_KEY: String(minimaxProvider?.api_key || '').trim(),
            MINIMAX_API_HOST: String(minimaxMcp.api_host || minimaxProvider?.base_url || DEFAULT_MINIMAX_API_BASE).trim() || DEFAULT_MINIMAX_API_BASE,
            MINIMAX_MCP_BASE_PATH: String(minimaxMcp.base_path || path.join(config.runtimeDir, 'minimax-mcp')).trim() || path.join(config.runtimeDir, 'minimax-mcp'),
            MINIMAX_API_RESOURCE_MODE: String(minimaxMcp.resource_mode || 'url').trim() || 'url',
            PATH: `/home/yingying/.local/bin:${process.env.PATH || ''}`,
          },
        },
      }
  const filePath = path.join(config.runtimeDir, 'mcp', `${turnId}.json`)
  const mcpConfig = {
    mcpServers: {
      cc_haha_bridge: {
        type: 'sse',
        url: `${config.yunzaiBaseUrl}${config.bridgeConfig.route_prefix}/mcp/sse`,
        headers: {
          Authorization: `Bearer ${config.bridgeConfig.mcp_token}`,
          'X-CC-Session-Key': sessionKey,
          'X-CC-Turn-Id': turnId,
        },
      },
      ...minimaxServer,
    },
  }
  await writeFile(filePath, JSON.stringify(mcpConfig, null, 2), 'utf8')
  return filePath
}

function buildUserPrompt(
  payload: InboundMessage,
  config: RuntimeConfig,
  runtimeContext: BridgeRuntimeContext | null = null,
  registeredCapabilityTurn = false,
): string {
  const structuredAnalysisTurn = isStructuredAnalysisTurn(payload.text)
  const characterListTurn = isCharacterListTurn(payload.text)
  const actionTurn = looksLikeActionTurn(payload.text) || registeredCapabilityTurn
  const promptConfig = resolvePromptConfig(config)
  const gsUid = String(runtimeContext?.player_cache_overview?.gs?.uid || '').trim()
  const gsProfileCount = Number(runtimeContext?.player_cache_overview?.gs?.profile_count || 0)
  const srUid = String(runtimeContext?.player_cache_overview?.sr?.uid || '').trim()
  const srProfileCount = Number(runtimeContext?.player_cache_overview?.sr?.profile_count || 0)
  const structuredCacheCount = Array.isArray(runtimeContext?.structured_caches)
    ? runtimeContext.structured_caches.length
    : 0
  const capabilityRegistry = runtimeContext?.capability_registry || null
  const capabilityVersion = Number(capabilityRegistry?.version || 0)
  const capabilityFingerprint = String(capabilityRegistry?.fingerprint || '').trim()
  const capabilityCount = Number(capabilityRegistry?.count || 0)
  const capabilityDomainCounts = capabilityRegistry?.counts_by_domain && typeof capabilityRegistry.counts_by_domain === 'object'
    ? Object.entries(capabilityRegistry.counts_by_domain)
        .map(([domain, count]) => `${domain}:${count}`)
        .join(', ')
    : ''
  const contextLines = [
    '[QQ TURN CONTEXT]',
    `session_key: ${payload.session_key}`,
    `scope: ${payload.scope}`,
    `bot_id: ${payload.bot_id}`,
    `user_id: ${payload.user_id}`,
    `group_id: ${payload.group_id || ''}`,
    `message_id: ${payload.message_id}`,
    `reply_to_message_id: ${payload.reply_to_message_id || ''}`,
    `sender_nickname: ${payload.sender_nickname || ''}`,
    `adapter: ${payload.adapter || 'qq'}`,
    `is_master: ${payload.is_master === true ? 'true' : 'false'}`,
    `network_enabled: ${payload.network_enabled === false ? 'false' : 'true'}`,
    '',
    '[RUNTIME CONTEXT SNAPSHOT]',
    `gs_uid: ${gsUid}`,
    `gs_profile_count: ${gsProfileCount}`,
    `sr_uid: ${srUid}`,
    `sr_profile_count: ${srProfileCount}`,
    `structured_cache_count: ${structuredCacheCount}`,
    '',
    '[YUNZAI CAPABILITY REGISTRY]',
    `schema_version: ${capabilityRegistry?.schema_version || ''}`,
    `version: ${capabilityVersion}`,
    `fingerprint: ${capabilityFingerprint}`,
    `capability_count: ${capabilityCount}`,
    `counts_by_domain: ${capabilityDomainCounts}`,
    'contract: plugin capabilities are dynamic; if version/fingerprint changes or the requested ability is uncertain, call yunzai_capability_search before choosing a command.',
    'negative: do not invent commands, do not assume removed plugins still exist, and do not rely on hard-coded plugin names when registry search can answer.',
    '',
    ...(characterListTurn
      ? [
          '[TURN POLICY]',
          ...promptConfig.character_list_turn_policy.split('\n').map(line => line.trim()).filter(Boolean),
          '',
        ]
      : structuredAnalysisTurn
      ? [
          '[TURN POLICY]',
          ...promptConfig.structured_analysis_turn_policy.split('\n').map(line => line.trim()).filter(Boolean),
          '',
        ]
      : registeredCapabilityTurn
      ? [
          '[TURN POLICY]',
          '这条消息已命中当前动态能力注册表，不要按普通聊天处理。',
          '先调用 yunzai_capability_search 用用户原文确认当前能力，再用 yunzai_run_command_capture 执行真实 Yunzai 命令。',
          '如果搜索结果显示能力已不存在或风险较高，按 registry meta 和 risk 字段处理，不要使用旧的硬编码命令。',
          '',
        ]
      : !actionTurn
        ? [
            '[TURN POLICY]',
            '这条消息更像普通交流、抽象问题或开放式表达，不是明确的命令执行请求。',
            '除非确实需要上下文，否则不要连续调用工具；最多读取一次 yunzai_get_user_runtime_context 就应直接回答。',
            '如果读过一次上下文仍然没有新增事实可用，就立即直接回答或只追问一句，不要在模型内部继续空转。',
            '不要为了凑“工具优先”而反复尝试无关工具，也不要空等到超时。',
            '',
          ]
        : []),
    '[USER MESSAGE]',
    payload.text.trim(),
  ]
  return contextLines.join('\n')
}

function isStructuredAnalysisTurn(text: string): boolean {
  return /(练度|伤害|分析一下|分析下|分析|优化|怎么优化|如何优化|怎么培养|如何培养|培养|锐评|值不值得养|强不强|毕业|配装|圣遗物|武器|天赋|命座)/.test(text)
}

function isCharacterListTurn(text: string): boolean {
  return /(我都有什么角色|我有什么角色|我都有哪些角色|有哪些角色|角色列表|角色都有谁|都有什么人物|都有哪些人物)/.test(text)
}

function looksLikeActionTurn(text: string): boolean {
  return /(更新|面板|角色|原石|札记|抽卡|攻略|图鉴|排行|卡片|命座|天赋|圣遗物|武器|登录|绑定|cookie|ck|状态|日志|重启|安装|订阅|推送|搜索|查询|查看)/.test(text)
}

async function looksLikeRegisteredCapabilityTurn(config: RuntimeConfig, text: string): Promise<boolean> {
  const query = text.trim()
  if (!query || query.length > 80) return false
  if (/^(你好|您好|早|晚安|谢谢|谢了|在吗|你是谁|你会什么|你能干什么)$/i.test(query)) return false
  try {
    const resp = await fetch(
      `${config.yunzaiBaseUrl}${config.bridgeConfig.route_prefix}/capabilities/search?q=${encodeURIComponent(query)}&max_results=3`,
      {
        headers: {
          Authorization: `Bearer ${config.bridgeConfig.gateway_token}`,
        },
      },
    )
    if (!resp.ok) return false
    const parsed = await resp.json() as {
      items?: Array<{ score?: number; invocation?: { rule_regexp?: string }; name?: string; description?: string }>
    }
    const top = Array.isArray(parsed.items) ? parsed.items[0] : null
    const score = Number(top?.score || 0)
    if (score >= 45) return true
    const haystack = `${top?.name || ''} ${top?.description || ''} ${top?.invocation?.rule_regexp || ''}`
    return score >= 25 && haystack.includes(query)
  } catch {
    return false
  }
}

function getToolList(): string {
  return [
    'Read',
    'Edit',
    'Write',
    'TodoWrite',
    'Glob',
    'Grep',
    'Bash',
    'WebFetch',
    'WebSearch',
    'ToolSearch',
    'EnterPlanMode',
    'ExitPlanMode',
    'ListMcpResourcesTool',
    'ReadMcpResourceTool',
    'Skill',
  ].join(',')
}

function collectResultText(raw: string): string {
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed?.result === 'string' ? parsed.result.trim() : ''
  } catch {
    return raw.trim()
  }
}

function isSessionInUseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /Session ID .* is already in use\./i.test(message)
}

function isTurnTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /turn timed out|turn idle timeout|turn max timeout|terminated after timeout/i.test(message)
}

function isCrashSignalError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /exited with signal (SIGSEGV|SIGABRT|SIGBUS|SIGILL|SIGTRAP)/i.test(message)
}

function attachTurnFailureDetails(err: Error, details: TurnFailureDetails): Error {
  Object.assign(err, details)
  return err
}

function getTurnFailureDetails(err: unknown): TurnFailureDetails {
  if (!err || typeof err !== 'object') return {}
  const details = err as TurnFailureDetails
  return {
    stdout_output: typeof details.stdout_output === 'string' ? details.stdout_output : undefined,
    stderr_output: typeof details.stderr_output === 'string' ? details.stderr_output : undefined,
    exit_code: typeof details.exit_code === 'number' || details.exit_code === null ? details.exit_code : undefined,
    exit_signal: typeof details.exit_signal === 'string' || details.exit_signal === null ? details.exit_signal : undefined,
  }
}

function isTimeoutExit(code: number | null, signal: NodeJS.Signals | null, timedOut: boolean): boolean {
  if (!timedOut) return false
  if (signal === 'SIGTERM' || signal === 'SIGKILL') return true
  if (code === 143 || code === 137) return true
  return code == null
}

async function writeTurnTrace(
  config: RuntimeConfig,
  turnId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await ensureRuntimeDir(config)
  const filePath = path.join(config.runtimeDir, 'turns', `${turnId}.json`)
  await writeFile(filePath, JSON.stringify({
    ...data,
    recorded_at: nowIso(),
  }, null, 2), 'utf8')
}

async function queryTurnStatus(
  config: RuntimeConfig,
  turnId: string,
): Promise<{
  delivered: boolean
  bundle_ids?: string[]
  summary?: unknown
  updated_at?: number
  observed_at?: number
  delivered_at?: number
  last_activity_at?: number
  last_activity_message?: string
}> {
  try {
    const resp = await fetch(
      `${config.yunzaiBaseUrl}${config.bridgeConfig.route_prefix}/turn-status?turn_id=${encodeURIComponent(turnId)}`,
      {
        headers: {
          Authorization: `Bearer ${config.bridgeConfig.gateway_token}`,
        },
      },
    )
    if (!resp.ok) return { delivered: false, bundle_ids: [] }
    const parsed = await resp.json() as {
      status?: {
        delivered?: boolean
        bundle_ids?: string[]
        summary?: unknown
        updated_at?: number
        observed_at?: number
        delivered_at?: number
        last_activity_at?: number
        last_activity_message?: string
      }
    }
    return {
      delivered: parsed.status?.delivered === true,
      bundle_ids: Array.isArray(parsed.status?.bundle_ids) ? parsed.status?.bundle_ids : [],
      summary: parsed.status?.summary,
      updated_at: Number(parsed.status?.updated_at || 0) || 0,
      observed_at: Number(parsed.status?.observed_at || 0) || 0,
      delivered_at: Number(parsed.status?.delivered_at || 0) || 0,
      last_activity_at: Number(parsed.status?.last_activity_at || 0) || 0,
      last_activity_message: typeof parsed.status?.last_activity_message === 'string'
        ? parsed.status.last_activity_message
        : '',
    }
  } catch {
    return { delivered: false, bundle_ids: [] }
  }
}

async function fetchBridgeRuntimeContext(
  config: RuntimeConfig,
  sessionKey: string,
): Promise<BridgeRuntimeContext | null> {
  try {
    const resp = await fetch(
      `${config.yunzaiBaseUrl}${config.bridgeConfig.route_prefix}/internal/runtime-context?session_key=${encodeURIComponent(sessionKey)}`,
      {
        headers: {
          Authorization: `Bearer ${config.bridgeConfig.gateway_token}`,
        },
      },
    )
    if (!resp.ok) return null
    const parsed = await resp.json() as { context?: BridgeRuntimeContext | null }
    return parsed?.context || null
  } catch {
    return null
  }
}

async function sendFallbackReply(
  config: RuntimeConfig,
  payload: InboundMessage,
  text: string,
  bundleIds: string[] = [],
): Promise<void> {
  if (!text && !bundleIds.length) return
  await fetch(`${config.yunzaiBaseUrl}${config.bridgeConfig.route_prefix}/internal/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.bridgeConfig.gateway_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session_key: payload.session_key,
      turn_id: payload.message_id,
      text,
      bundle_ids: bundleIds,
    }),
  })
}

async function runDirectChatTurn(
  config: RuntimeConfig,
  payload: InboundMessage,
  providerOverride?: ProviderConfig,
): Promise<string> {
  const activeProvider = providerOverride || config.provider
  const promptConfig = resolvePromptConfig(config)
  const runtimeContext = await fetchBridgeRuntimeContext(config, payload.session_key)
  const recentChatMessages = Array.isArray(runtimeContext?.recent_chat_messages)
    ? runtimeContext.recent_chat_messages
    : []
  const historyMessages = recentChatMessages
    .filter(item => {
      const role = String(item?.role || '').trim()
      const text = String(item?.text || '').trim()
      if ((role !== 'user' && role !== 'assistant') || !text) return false
      if (role === 'user' && String(item?.message_id || '').trim() === payload.message_id) return false
      return true
    })
    .slice(-6)
    .map(item => ({
      role: String(item.role || '').trim() as 'user' | 'assistant',
      content: String(item.text || '').trim(),
    }))
  const system = [
    `你是${promptConfig.identity}`,
    '这是 QQ 机器人普通聊天快速路径。',
    '不要调用工具，不要假装执行命令，不要提系统内部实现。',
    '直接用简短自然的中文回答用户当前问题。',
    '如果用户说法过于抽象或信息不足，只追问一句最必要的话，不要长篇空话。',
    '如果最近几轮同一会话已经出现用户问题和你的追问/澄清，必须结合这些历史再回答当前这句短补充，不要把当前消息孤立理解。',
  ].join('\n')

  if (historyMessages.length) {
    const historyPreview = historyMessages
      .map(item => `${item.role}:${item.content}`)
      .join(' | ')
    logTurnDebug(
      payload,
      `AI direct_chat history_count=${historyMessages.length} preview=${previewText(historyPreview, 360) || '(empty)'}`,
    )
  }

  const resp = await fetch(`http://127.0.0.1:${config.litellmPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: activeProvider.model,
      temperature: 0.3,
      max_tokens: 512,
      messages: [
        { role: 'system', content: system },
        ...historyMessages,
        { role: 'user', content: payload.text.trim() },
      ],
    }),
  })

  if (!resp.ok) {
    throw new Error(`direct chat failed: ${resp.status} ${resp.statusText}`)
  }

  const parsed = await resp.json() as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const text = parsed.choices?.[0]?.message?.content?.trim() || ''
  if (!text) {
    throw new Error('direct chat returned empty content')
  }
  return text
}

async function runClaudeTurn(
  config: RuntimeConfig,
  payload: InboundMessage,
  files: { settingsPath: string; promptPath: string },
  session: SessionRuntime,
  userPrompt: string,
  systemPrompt: string,
): Promise<string> {
  const mcpConfigPath = await buildMcpConfig(config, payload.session_key, payload.message_id)
  const sessionId = getRuntimeSessionId(payload.session_key, session.generation)
  const shouldResume = session.canResume && await sessionTranscriptExists(config, sessionId)
  const args = [
    '-p',
    '--bare',
    '--output-format',
    'json',
    '--permission-mode',
    'bypassPermissions',
    '--model',
    config.provider.model,
    '--max-turns',
    '12',
    '--settings',
    files.settingsPath,
    '--mcp-config',
    mcpConfigPath,
    '--strict-mcp-config',
    '--tools',
    getToolList(),
    '--append-system-prompt-file',
    files.promptPath,
  ]

  if (shouldResume) {
    args.splice(12, 0, '--resume', sessionId)
  } else {
    args.splice(12, 0, '--session-id', sessionId)
  }

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: config.yunzaiDir,
      env: {
        ...process.env,
        PATH: `/home/yingying/.bun/bin:${process.env.PATH || ''}`,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    logTurn(
      payload,
      `AI 回合已启动 pid=${child.pid || 'unknown'} mode=${shouldResume ? 'resume' : 'new'} generation=${session.generation}`,
    )
    logTurnDebug(
      payload,
      `AI system_prompt len=${systemPrompt.length} preview=${previewText(systemPrompt, 480) || '(empty)'}`,
    )
    logTurnDebug(
      payload,
      `AI turn_prompt len=${userPrompt.length} preview=${previewText(userPrompt, 480) || '(empty)'}`,
    )

    let stdout = ''
    let stderr = ''
    let stdoutChunkLogs = 0
    let stderrChunkLogs = 0
    let timeoutReason = 'turn timed out'
    const turnTimeoutMs = Math.max(30000, Number(config.bridgeConfig.ai_turn_timeout_ms || DEFAULT_TURN_TIMEOUT_MS))
    const idleTimeoutMs = Math.max(5000, Number(config.bridgeConfig.ai_idle_timeout_ms || DEFAULT_IDLE_TIMEOUT_MS))
    const watchdogIntervalMs = 5000
    const startedAt = Date.now()
    let lastLocalActivityAt = startedAt
    let killTimer: NodeJS.Timeout | null = null
    let watchdogTimer: NodeJS.Timeout | null = null
    let settled = false
    let timedOut = false
    const finishResolve = (value: string) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const finishReject = (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
    }
    const scheduleWatchdog = () => {
      watchdogTimer = setTimeout(async () => {
        if (settled) return
        const now = Date.now()
        const elapsedMs = now - startedAt
        const status = await queryTurnStatus(config, payload.message_id)
        const remoteActivityAt = Math.max(
          Number(status.updated_at || 0),
          Number(status.observed_at || 0),
          Number(status.delivered_at || 0),
          Number(status.last_activity_at || 0),
        )
        const lastActivityAt = Math.max(startedAt, lastLocalActivityAt, remoteActivityAt)
        const idleMs = now - lastActivityAt

        logTurnDebug(
          payload,
          `AI watchdog elapsed_ms=${elapsedMs} idle_ms=${idleMs} bundle_count=${Array.isArray(status.bundle_ids) ? status.bundle_ids.length : 0} delivered=${status.delivered ? 'true' : 'false'} last_activity=${status.last_activity_message || ''}`,
        )

        const hardTimedOut = elapsedMs >= turnTimeoutMs && idleMs >= 5000
        const idleTimedOut = idleMs >= idleTimeoutMs
        if (hardTimedOut || idleTimedOut) {
          timedOut = true
          timeoutReason = idleTimedOut
            ? `claude-haha turn idle timeout after ${idleTimeoutMs}ms`
            : `claude-haha turn max timeout after ${turnTimeoutMs}ms`
          logTurn(
            payload,
            `AI 回合超时，准备终止 pid=${child.pid || 'unknown'} elapsed_ms=${elapsedMs} idle_ms=${idleMs} reason=${idleTimedOut ? 'idle' : 'max'}`,
          )
          child.kill('SIGTERM')
          killTimer = setTimeout(() => {
            child.kill('SIGKILL')
            logTurn(payload, `AI 子进程已强制终止 pid=${child.pid || 'unknown'}`)
          }, 5000)
          finishReject(new Error(timeoutReason))
          return
        }

        scheduleWatchdog()
      }, watchdogIntervalMs)
    }
    scheduleWatchdog()

    child.stdout.on('data', chunk => {
      const text = String(chunk)
      stdout += text
      lastLocalActivityAt = Date.now()
      if (stdoutChunkLogs < 8 && text.trim()) {
        stdoutChunkLogs += 1
        logTurnDebug(
          payload,
          `AI stdout chunk#${stdoutChunkLogs} len=${text.length} preview=${previewText(text, 360)}`,
        )
        if (stdoutChunkLogs === 8) {
          logTurnDebug(payload, 'AI stdout chunk 日志达到上限，后续 stdout 仅继续累计不再逐条打印')
        }
      }
    })
    child.stderr.on('data', chunk => {
      const text = String(chunk)
      stderr += text
      lastLocalActivityAt = Date.now()
      if (stderrChunkLogs < 8 && text.trim()) {
        stderrChunkLogs += 1
        logTurnDebug(
          payload,
          `AI stderr chunk#${stderrChunkLogs} len=${text.length} preview=${previewText(text, 360)}`,
        )
        if (stderrChunkLogs === 8) {
          logTurnDebug(payload, 'AI stderr chunk 日志达到上限，后续 stderr 仅继续累计不再逐条打印')
        }
      }
    })

    // Feed the turn prompt through stdin instead of argv. On this host a
    // globally preloaded libusranalyse.so crashes on long UTF-8 command-line
    // arguments; piping the prompt avoids that native segfault while keeping
    // the same claude-haha + MCP execution path.
    child.stdin.end(userPrompt)

    child.on('error', err => {
      if (watchdogTimer) clearTimeout(watchdogTimer)
      if (killTimer) clearTimeout(killTimer)
      logTurn(payload, `AI 子进程异常: ${err.message}`)
      finishReject(err)
    })
    child.on('exit', (code, signal) => {
      if (watchdogTimer) clearTimeout(watchdogTimer)
      if (killTimer) clearTimeout(killTimer)
      if (isTimeoutExit(code, signal, timedOut)) {
        logTurn(payload, `AI 回合结束 code=${String(code)} signal=${signal || 'unknown'} timeout=true reason=${timeoutReason}`)
        return
      }
      logTurn(
        payload,
        `AI 回合退出 code=${String(code)} signal=${signal || 'none'} stdout_len=${stdout.length} stderr_len=${stderr.length}`,
      )
      if (code !== 0) {
        const stderrText = stderr.trim()
        if (signal) {
          const suffix = stderrText ? `\n${stderrText}` : ''
          finishReject(
            attachTurnFailureDetails(
              new Error(`claude-haha exited with signal ${signal}${suffix}`),
              {
                stdout_output: stdout,
                stderr_output: stderr,
                exit_code: code,
                exit_signal: signal,
              },
            ),
          )
          return
        }
        finishReject(
          attachTurnFailureDetails(
            new Error(
              stderrText || `claude-haha exited with code ${code}`,
            ),
            {
              stdout_output: stdout,
              stderr_output: stderr,
              exit_code: code,
              exit_signal: signal,
            },
          ),
        )
        return
      }
      finishResolve(stdout)
    })
  })
}

async function processTurn(payload: InboundMessage): Promise<void> {
  const config = await loadRuntimeConfig()
  state.config = config
  const files = await writeRuntimeFiles(config)
  await ensureLiteLLM(config, files.litellmConfigPath)
  const session = await hydrateSessionRuntime(config, payload.session_key)
  const runtimeContext = await fetchBridgeRuntimeContext(config, payload.session_key)
  const contextFingerprint = computeRuntimeContextFingerprint(runtimeContext)
  const registeredCapabilityTurn = await looksLikeRegisteredCapabilityTurn(config, payload.text)
  const systemPrompt = await readFile(files.promptPath, 'utf8').catch(() => '')
  const userPrompt = buildUserPrompt(payload, config, runtimeContext, registeredCapabilityTurn)
  if (session.canResume && contextFingerprint && session.contextFingerprint && session.contextFingerprint !== contextFingerprint) {
    session.canResume = false
    session.generation += 1
    logTurn(payload, `检测到运行时上下文变化，已切换到 generation=${session.generation} 重新开始`)
  }
  logTurn(payload, `收到新回合 generation=${session.generation} canResume=${session.canResume ? 'true' : 'false'}`)

  if (!isStructuredAnalysisTurn(payload.text) && !looksLikeActionTurn(payload.text) && !registeredCapabilityTurn) {
    try {
      const directText = await runDirectChatTurn(config, payload)
      await sendFallbackReply(config, payload, directText)
      session.canResume = false
      session.contextFingerprint = contextFingerprint
      await persistSessionRuntime(config, payload.session_key, session)
      await writeTurnTrace(config, payload.message_id, {
        ok: true,
        payload,
        delivered: true,
        result_text: directText,
        raw_output: directText,
        session_generation: session.generation,
        fast_path: 'direct_chat',
      })
      logTurn(payload, `普通聊天快速路径已完成 text_len=${directText.length}`)
      return
    } catch (err) {
      if (config.fallbackProvider) {
        try {
          logTurn(payload, `普通聊天主 provider 失败，尝试 fallback=${config.fallbackProviderName || 'unknown'}`)
          const directText = await runDirectChatTurn(config, payload, config.fallbackProvider)
          await sendFallbackReply(config, payload, directText)
          session.canResume = false
          session.contextFingerprint = contextFingerprint
          await persistSessionRuntime(config, payload.session_key, session)
          await writeTurnTrace(config, payload.message_id, {
            ok: true,
            payload,
            delivered: true,
            result_text: directText,
            raw_output: directText,
            session_generation: session.generation,
            fast_path: `direct_chat_fallback:${config.fallbackProviderName || 'unknown'}`,
          })
          logTurn(payload, `普通聊天 fallback 路径已完成 provider=${config.fallbackProviderName || 'unknown'} text_len=${directText.length}`)
          return
        } catch (fallbackErr) {
          logTurn(payload, `普通聊天 fallback 失败，回退主链: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`)
        }
      } else {
        logTurn(payload, `普通聊天快速路径失败，回退主链: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  try {
    let raw = ''
    let retriedAfterCrash = false
    while (!raw) {
      try {
        raw = await runClaudeTurn(config, payload, {
          settingsPath: files.settingsPath,
          promptPath: files.promptPath,
        }, session, userPrompt, systemPrompt)
      } catch (err) {
        if (isSessionInUseError(err)) {
          session.canResume = false
          session.generation += 1
          await persistSessionRuntime(config, payload.session_key, session)
          logTurn(payload, `检测到 Session ID 冲突，已切换到 generation=${session.generation} 重试`)
          continue
        }
        if (!retriedAfterCrash && isCrashSignalError(err)) {
          retriedAfterCrash = true
          session.canResume = false
          session.generation += 1
          await persistSessionRuntime(config, payload.session_key, session)
          logTurn(payload, `检测到 AI 子进程崩溃，已切换到 generation=${session.generation} 重试`)
          continue
        }
        throw err
      }
    }

    const resultText = collectResultText(raw)
    const status = await queryTurnStatus(config, payload.message_id)
    session.canResume = true
    session.contextFingerprint = contextFingerprint
    await persistSessionRuntime(config, payload.session_key, session)
    await writeTurnTrace(config, payload.message_id, {
      ok: true,
      payload,
      delivered: status.delivered,
      result_text: resultText,
      raw_output: raw,
      user_prompt_preview: previewText(userPrompt, 2000),
      system_prompt_preview: previewText(systemPrompt, 2000),
      user_prompt_length: userPrompt.length,
      system_prompt_length: systemPrompt.length,
      session_generation: session.generation,
    })

    logTurn(
      payload,
      `AI 回合完成 delivered=${status.delivered ? 'true' : 'false'} bundle_count=${Array.isArray(status.bundle_ids) ? status.bundle_ids.length : 0} text_len=${resultText.length}`,
    )

    if (!status.delivered && (resultText || (status.bundle_ids || []).length)) {
      await sendFallbackReply(config, payload, resultText, status.bundle_ids || [])
      logTurn(payload, 'AI 结果未主动送达，已触发兜底回放')
    }
  } catch (err) {
    const handledTimeout = isTurnTimeoutError(err)
    const handledCrash = isCrashSignalError(err)
    const failureDetails = getTurnFailureDetails(err)
    const status = await queryTurnStatus(config, payload.message_id)
    if (!status.delivered && Array.isArray(status.bundle_ids) && status.bundle_ids.length) {
      await sendFallbackReply(config, payload, '', status.bundle_ids)
      if (handledCrash) {
        logTurn(payload, `AI 崩溃后检测到真实 bundle，已兜底回放 count=${status.bundle_ids.length}`)
      } else if (handledTimeout) {
        logTurn(payload, `AI 超时后检测到真实 bundle，已兜底回放 count=${status.bundle_ids.length}`)
      } else {
        logTurn(payload, `AI 失败后检测到真实 bundle，已兜底回放 count=${status.bundle_ids.length}`)
      }
    } else if (!status.delivered) {
      const fallbackText = handledCrash
        ? '这轮 AI 进程异常退出，我已重置会话，请再发一次，我会继续处理。'
        : handledTimeout
          ? '这轮处理超时了，请再发一次，我会继续处理。'
          : '这轮处理失败了，请再发一次，我会继续处理。'
      await sendFallbackReply(config, payload, fallbackText)
      if (handledCrash) {
        logTurn(payload, 'AI 崩溃且没有 bundle，已发送崩溃提示')
      } else if (handledTimeout) {
        logTurn(payload, 'AI 超时且没有 bundle，已发送超时提示')
      } else {
        logTurn(payload, 'AI 失败且没有 bundle，已发送失败提示')
      }
    }
    session.canResume = false
    session.contextFingerprint = contextFingerprint
    session.generation += 1
    await persistSessionRuntime(config, payload.session_key, session)
    await writeTurnTrace(config, payload.message_id, {
      ok: false,
      payload,
      error: err instanceof Error ? err.message : String(err),
      raw_output: failureDetails.stdout_output || '',
      stderr_output: failureDetails.stderr_output || '',
      user_prompt_preview: previewText(userPrompt, 2000),
      system_prompt_preview: previewText(systemPrompt, 2000),
      user_prompt_length: userPrompt.length,
      system_prompt_length: systemPrompt.length,
      exit_code: failureDetails.exit_code,
      exit_signal: failureDetails.exit_signal,
      session_generation: session.generation,
    })
    if (handledTimeout || handledCrash) return
    throw err
  }
}

function getOrCreateSessionRuntime(sessionKey: string): SessionRuntime {
  let session = state.sessions.get(sessionKey)
  if (!session) {
    session = {
      generation: 0,
      canResume: false,
      contextFingerprint: '',
      hydrated: false,
      queue: [],
      running: false,
    }
    state.sessions.set(sessionKey, session)
  }
  return session
}

async function drainSession(sessionKey: string): Promise<void> {
  const session = getOrCreateSessionRuntime(sessionKey)
  if (session.running) return
  session.running = true
  try {
    while (session.queue.length) {
      const next = session.queue.shift()
      if (!next) continue
      try {
        await processTurn(next)
      } catch (err) {
        process.stderr.write(`[qq-gateway] turn failed for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
  } finally {
    session.running = false
  }
}

function enqueueTurn(payload: InboundMessage): { accepted: boolean; dropped?: boolean } {
  const session = getOrCreateSessionRuntime(payload.session_key)
  let dropped = false
  if (session.queue.length >= MAX_QUEUE_SIZE) {
    session.queue.shift()
    dropped = true
  }
  session.queue.push(payload)
  void drainSession(payload.session_key)
  return { accepted: true, dropped }
}

function parseAuth(req: http.IncomingMessage): string {
  return String(req.headers.authorization || '').trim()
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readRequestBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

async function start(): Promise<void> {
  const config = await loadRuntimeConfig()
  state.config = config
  await writeRuntimeFiles(config)

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
      const runtimeConfig = await loadRuntimeConfig()
      state.config = runtimeConfig
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        const litellm = await ping(`http://127.0.0.1:${runtimeConfig.litellmPort}/health`)
        return json(res, 200, {
          ok: true,
          service: 'cc-haha-qq-gateway',
          time: nowIso(),
          litellm_ready: litellm,
          queue_sessions: state.sessions.size,
        })
      }

      if (parseAuth(req) !== `Bearer ${runtimeConfig.bridgeConfig.gateway_token}`) {
        return json(res, 401, { ok: false, error: 'unauthorized' })
      }

      if (req.method === 'POST' && url.pathname === '/v1/inbound-message') {
        const body = await readRequestBody(req) as Partial<InboundMessage>
        if (!body.session_key || !body.text || !body.bot_id || !body.user_id || !body.scope || !body.message_id) {
          return json(res, 400, { ok: false, error: 'invalid payload' })
        }
        const payload: InboundMessage = {
          session_key: String(body.session_key),
          bot_id: String(body.bot_id),
          user_id: String(body.user_id),
          group_id: body.group_id ? String(body.group_id) : '',
          scope: body.scope === 'group' ? 'group' : 'private',
          message_id: String(body.message_id),
          reply_to_message_id: body.reply_to_message_id ? String(body.reply_to_message_id) : '',
          text: String(body.text),
          sender_nickname: body.sender_nickname ? String(body.sender_nickname) : '',
          adapter: body.adapter ? String(body.adapter) : 'qq',
          network_enabled: body.network_enabled !== false,
          is_master: body.is_master === true,
        }
        const result = enqueueTurn(payload)
        return json(res, 202, {
          ok: true,
          ...result,
        })
      }

      return json(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      return json(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.gatewayPort, '127.0.0.1', () => resolve())
  })

  process.stdout.write(`[qq-gateway] listening on http://127.0.0.1:${config.gatewayPort}\n`)
}

await start()
