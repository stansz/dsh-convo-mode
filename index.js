/**
 * dsh-convo-mode — a per-session "conversation mode" for DeepSeek Harness.
 *
 * The mode is a durable, logged stance, not a client-only toggle:
 *
 *   /conversation            enter (a bare entry is enough)
 *   /conversation <message>  enter and send that message as the next request
 *   /conversation off        leave
 *
 * While active the session gets one additive system-prompt section that reframes the
 * agent as a conversational assistant, and (unless configured otherwise) the agent
 * scope is restricted to read-only "look it up" tools, so coding tools are neither
 * presented to the model nor callable by it.
 *
 * State lives in the session log, never in plugin memory. `command/run`/`command/done`
 * pairs are already durable, logged events, so the `conversation` projection folds them
 * instead of appending a private event type (a plugin must never append an unknown
 * session event: `Session.append` cannot mark it ignorable, and the session would then
 * refuse to reopen). Because the projection folds the log, resume and fork restore the
 * mode exactly, and a cold session re-derives it without the plugin having run before.
 *
 * The tool policy is the one per-agent registration: `ctx.tools.restrict()` is registered
 * on the exact agent context while the mode is active and disposed when it leaves, so
 * other agents (teammates, subagents, other sessions) keep their full tool set.
 *
 * @module dsh-convo-mode
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'conversation-mode';

/** The registries this plugin contributes to. Read-only facts and the prompt section are required. */
export const inject = ['sessionProjections', 'systemPrompt'];

/** Session projection key. Host-only state; the wire view is `{ active, pending }`. */
const PROJECTION_KEY = 'conversation';

/** Slash command that enters, addresses, or leaves the mode. */
const COMMAND_NAME = 'conversation';

/** The exact argument that leaves the mode; anything else is a message. */
const OFF_ARGUMENT = 'off';

/**
 * Prompt placement: after plan policy (500) and before team policy (600). A named
 * repository order does not exist for a third-party collaboration mode, so a literal
 * slot in that gap keeps this section beside the other mode policies without colliding.
 */
const SECTION_ORDER = 550;

/**
 * Tools that stay callable in the default read-only policy. Every name is intersected
 * with the tools this deployment actually composes, because `restrict()` rejects
 * unknown names; the list is therefore safe across profiles with different tool sets.
 */
const DEFAULT_ALLOW = [
  'read',
  'glob',
  'grep',
  'read_image',
  'web_search',
  'web_fetch',
  'ask_user_question',
  'skill',
  'session_search',
  'session_event_read',
  'session_event_search',
  'session_event_trace',
];

/** Default model-facing guidance while the mode is active. */
const DEFAULT_GUIDANCE = `The user has turned on conversation mode for this session. Be an attentive conversational partner first, and a software engineer only when explicitly asked.

- Answer in natural, spoken-style prose. Match the length to the question: one warm sentence for a greeting or a simple fact, a few short paragraphs for something that deserves discussion. Use headings, tables, and long lists only when the content truly needs them.
- Lead with a direct answer or a genuine reaction, then add the useful context. Do not open with a summary of what you are about to say.
- Ask one clarifying question when the request is ambiguous, instead of guessing and producing a large artifact.
- Do not edit files, run commands, start builds, or take multi-step engineering action. Code belongs in the chat as an illustration, never as a change to the workspace. If the user clearly wants hands-on work, say so briefly and suggest leaving conversation mode with /conversation off, then wait.
- Treat this as a one-on-one conversation. Do not delegate to teammates, subagents, workflows, or jobs, and do not reach for capability tools beyond reading and looking things up.
- You may use read-only tools — reading a file, searching the web, looking at an image — when they make the answer more accurate, but do not narrate their use or turn the reply into a status report.
- Help the user think: explain, brainstorm, compare options, reflect back what you understood, and be honest about uncertainty.`;

/** Plugin defaults for every tunable value. */
const DEFAULTS = {
  section: DEFAULT_GUIDANCE,
  tools: 'readonly',
  allow: DEFAULT_ALLOW,
  defaultActive: false,
};

/**
 * Load schemastery defensively.
 *
 * This package installs as a `link:`, so the profile's plugin manager symlinks the
 * directory but never resolves ITS dependencies: a static `import z from
 * '@deepseek-ai/schemastery'` would fail the whole module load. Resolving it through
 * `createRequire` from each plausible root keeps the plugin loadable either way; when
 * every root fails, `Config` is simply undefined and every value keeps its code default.
 */
const z = (() => {
  const roots = [
    // The bundle's own `node_modules`, when someone ran an install here.
    import.meta.url,
    // The profile directory: `$DSH_PROFILE_DIR` is set for profile-launched shells.
    process.env.DSH_PROFILE_DIR === undefined ? undefined : join(process.env.DSH_PROFILE_DIR, 'index.js'),
    // The profile directory reached through `$DSH_HOME/profiles/<profile>`.
    process.env.DSH_HOME === undefined || process.env.DSH_PROFILE === undefined
      ? undefined
      : join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE, 'index.js'),
    // The Harness installation that launched this process: its node_modules carries
    // schemastery as a dependency even when the profile does not (a linked bundle never
    // resolves its own dependencies, and the Host process has no profile env vars).
    process.argv[1],
    join(process.cwd(), 'index.js'),
  ];
  for (const root of roots) {
    if (root === undefined) continue;
    try {
      const loaded = createRequire(root)('@deepseek-ai/schemastery');
      const schema = loaded?.default ?? loaded;
      if (schema !== undefined) return schema;
    } catch {
      /* not resolvable from this root; try the next */
    }
  }
  return undefined;
})();

/** Settings page fields for this row; absent when schemastery is not reachable. */
export const Config = (() => {
  if (z === undefined) return undefined;
  try {
    return z.object({
      section: z
        .string()
        .default(DEFAULT_GUIDANCE)
        .description('System-prompt guidance used while conversation mode is active.'),
      tools: z
        .union(['readonly', 'unrestricted'])
        .default(DEFAULTS.tools)
        .description(
          'readonly hides coding and execution tools while the mode is active; unrestricted keeps every tool.',
        ),
      allow: z
        .array(z.string())
        .default(DEFAULT_ALLOW)
        .description('Tool names that stay callable under the read-only policy.'),
      defaultActive: z
        .boolean()
        .default(DEFAULTS.defaultActive)
        .description('Start sessions in conversation mode when they log no /conversation command.'),
    });
  } catch {
    return undefined;
  }
})();

/**
 * Validate the deployment-owned config, failing at load on a typo rather than
 * silently ignoring it.
 *
 * @param {unknown} config - The loader row's `config` value.
 * @returns {{section: string, tools: 'readonly'|'unrestricted', allow: string[], defaultActive: boolean}} detached values.
 */
function resolveConfig(config) {
  if (config === undefined || config === null) return { ...DEFAULTS, allow: DEFAULTS.allow.slice() };
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('ConversationModeConfig must be an object');
  }
  const unknown = Object.keys(config).filter(
    (key) => !Object.prototype.hasOwnProperty.call(DEFAULTS, key),
  );
  if (unknown.length > 0) {
    throw new Error(
      `ConversationModeConfig has unknown key(s) ${unknown.join(', ')} — config is { section, tools, allow, defaultActive }`,
    );
  }
  const section = config.section === undefined ? DEFAULTS.section : config.section;
  if (typeof section !== 'string' || section.trim() === '') {
    throw new Error('ConversationModeConfig.section must be a non-empty string');
  }
  const tools = config.tools === undefined ? DEFAULTS.tools : config.tools;
  if (tools !== 'readonly' && tools !== 'unrestricted') {
    throw new Error('ConversationModeConfig.tools must be "readonly" or "unrestricted"');
  }
  const allow = config.allow === undefined ? DEFAULTS.allow.slice() : config.allow;
  if (!Array.isArray(allow) || allow.some((entry) => typeof entry !== 'string' || entry === '')) {
    throw new Error('ConversationModeConfig.allow must be an array of non-empty tool names');
  }
  if (allow.length === 0) {
    throw new Error(
      'ConversationModeConfig.allow must name at least one tool; set tools: "unrestricted" to keep every tool',
    );
  }
  const defaultActive = config.defaultActive === undefined ? DEFAULTS.defaultActive : config.defaultActive;
  if (typeof defaultActive !== 'boolean') {
    throw new Error('ConversationModeConfig.defaultActive must be a boolean');
  }
  return { section, tools, allow: allow.slice(), defaultActive };
}

/**
 * Check a projection state value and return a detached copy. The projection registry
 * validates persisted checkpoint rows through the schema's `parse`, so this must be
 * total over everything `apply`/`init` can produce and reject anything else.
 *
 * @param {unknown} value - A stored or freshly folded state.
 * @returns {{active: boolean, running: null | {commandId: string, wanted: boolean}}} the state.
 */
function parseState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('conversation projection state must be an object');
  }
  const active = value.active;
  if (typeof active !== 'boolean') {
    throw new Error('conversation projection state.active must be a boolean');
  }
  const running = value.running;
  if (running === null) return { active, running: null };
  if (running === undefined) return { active, running: null };
  if (typeof running !== 'object' || Array.isArray(running)) {
    throw new Error('conversation projection state.running must be null or an object');
  }
  if (typeof running.commandId !== 'string' || typeof running.wanted !== 'boolean') {
    throw new Error('conversation projection state.running must be { commandId: string, wanted: boolean }');
  }
  return { active, running: { commandId: running.commandId, wanted: running.wanted } };
}

/**
 * Check a client wire view value and return a detached copy.
 *
 * @param {unknown} value - A view produced by `view`.
 * @returns {{active: boolean, pending: boolean}} the view.
 */
function parseView(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('conversation projection view must be an object');
  }
  if (typeof value.active !== 'boolean' || typeof value.pending !== 'boolean') {
    throw new Error('conversation projection view must be { active: boolean, pending: boolean }');
  }
  return { active: value.active, pending: value.pending };
}

/**
 * The effective stance: a command that has been logged but not yet settled already
 * counts, so the very message submitted with `/conversation <message>` is assembled
 * under the new policy without waiting for `command/done` to land.
 *
 * @param {{active: boolean, running: null | {wanted: boolean}}} state - Folded state.
 * @returns {boolean} whether the mode applies right now.
 */
function effectiveActive(state) {
  return state.running === null ? state.active : state.running.wanted;
}

/**
 * Build the projection unit. Kept as a factory because `defaultActive` is config.
 *
 * @param {boolean} defaultActive - Whether sessions without a recorded command start active.
 * @returns {object} a projection definition accepted by `ctx.sessionProjections.register`.
 */
function conversationProjection(defaultActive) {
  return {
    key: PROJECTION_KEY,
    stateVersion: 1,
    // The registry calls `.parse()` on persisted checkpoint rows and on produced views;
    // a small structural validator keeps this plugin free of a schema-library dependency
    // (a linked bundle never resolves its own dependencies).
    stateSchema: { parse: parseState },
    init: () => ({ active: defaultActive, running: null }),
    apply: (state, event) => {
      if (event.type === 'command/run' && event.data.name === COMMAND_NAME) {
        const args = event.data.args;
        const wanted = args === undefined ? true : args.trim().toLowerCase() !== OFF_ARGUMENT;
        return { ...state, running: { commandId: event.data.commandId, wanted } };
      }
      if (
        event.type === 'command/done' &&
        state.running !== null &&
        event.data.commandId === state.running.commandId
      ) {
        // A failed or aborted command changes nothing; only a success applies the selection.
        if (event.data.kind !== 'success') return { ...state, running: null };
        return { active: state.running.wanted, running: null };
      }
      return state;
    },
    wire: {
      viewSchema: { parse: parseView },
      view: (state) => {
        const active = effectiveActive(state);
        return {
          active,
          pending: state.running !== null && state.running.wanted !== state.active,
        };
      },
    },
  };
}

/**
 * Deep-freeze a value the way `createUserMessage` would, so the loop receives the same
 * immutable message shape it produces itself.
 *
 * @param {unknown} value - The value to freeze in place.
 * @returns {unknown} the same value.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

/**
 * Build one user message without importing the Host's LLM package (a linked bundle does
 * not resolve Harness package dependencies; the message is plain data).
 *
 * @param {Array<object>} content - Model-facing content blocks.
 * @returns {object} a frozen user message with a fresh id.
 */
function createUserMessage(content) {
  return deepFreeze({ id: randomUUID(), role: 'user', content, source: { kind: 'user' } });
}

/**
 * Mount the mode: projection, prompt section, tool policy, and the `/conversation` command.
 *
 * @param {object} ctx - The plugin's Cordis context.
 * @param {unknown} [config] - The loader row's config.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);

  /**
   * Read this session's folded mode state, or `undefined` when the projection is not
   * registered (the plugin is being unloaded) or the session is not readable.
   *
   * @param {object} session - The session to read.
   * @returns {object | undefined} the state.
   */
  const readState = (session) => {
    try {
      return ctx.sessionProjections.stateOf(session, PROJECTION_KEY);
    } catch (error) {
      ctx.logger?.warn?.('conversation-mode: cannot read the conversation projection: %o', error);
      return undefined;
    }
  };

  /**
   * Whether the mode currently applies to one session.
   *
   * @param {object} session - The session to check.
   * @returns {boolean} true while active.
   */
  const isActive = (session) => {
    const state = readState(session);
    return state !== undefined && effectiveActive(state);
  };

  ctx.effect(
    () => ctx.sessionProjections.register(conversationProjection(resolved.defaultActive)),
    'conversation-mode: projection',
  );

  // The policy is additive: inactive sessions contribute an empty string, so the section
  // never appears in their prompt.
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'conversation:policy',
        order: SECTION_ORDER,
        text: (context) => {
          const agent = context.agent;
          if (agent === undefined) return '';
          return isActive(agent.session) ? resolved.section : '';
        },
      }),
    'conversation-mode: policy section',
  );

  // ── per-agent tool policy ────────────────────────────────────────────────────────────
  /** @type {Map<object, {active: boolean, dispose: (() => void) | undefined}>} */
  const policies = new Map();

  /**
   * Register the read-only restriction in one exact agent scope.
   *
   * @param {object} agent - The agent whose scope the policy covers.
   * @returns {(() => void) | undefined} the restriction disposer.
   */
  const restrictAgent = (agent) => {
    const tools = agent.ctx.get('tools') ?? ctx.get('tools');
    if (tools === undefined) return undefined;
    let available;
    try {
      // Ask for this agent's own view: preset composition may register tools on the
      // agent plane, so the global view alone would under-report what it can call.
      available = new Set(tools.schemas(agent).map((schema) => schema.name));
    } catch (error) {
      ctx.logger?.warn?.('conversation-mode: cannot list tools for the policy: %o', error);
      return undefined;
    }
    const allow = resolved.allow.filter((toolName) => available.has(toolName));
    if (allow.length === 0) return undefined;
    try {
      return agent.ctx.tools.restrict({ allow });
    } catch (error) {
      ctx.logger?.warn?.('conversation-mode: cannot restrict tools for this agent: %o', error);
      return undefined;
    }
  };

  /**
   * Make one agent's tool policy match its session's current mode. Idempotent: the
   * restriction is only registered or disposed when the stance changes.
   *
   * @param {object} agent - The agent to sync.
   */
  const syncPolicy = (agent) => {
    if (resolved.tools !== 'readonly') return;
    let entry = policies.get(agent);
    if (entry === undefined) {
      entry = { active: false, dispose: undefined };
      policies.set(agent, entry);
    }
    const wanted = isActive(agent.session);
    if (wanted === entry.active) return;
    entry.dispose?.();
    entry.dispose = wanted ? restrictAgent(agent) : undefined;
    entry.active = wanted;
  };

  /** The live agents this plugin currently knows about. @returns {object[]} agents. */
  const liveAgents = () => {
    const agents = ctx.get('agents');
    if (agents === undefined) return [];
    try {
      return agents.list();
    } catch {
      return [];
    }
  };

  for (const agent of liveAgents()) {
    try {
      syncPolicy(agent);
    } catch (error) {
      ctx.logger?.warn?.('conversation-mode: initial policy sync failed: %o', error);
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    try {
      syncPolicy(agent);
    } catch (error) {
      ctx.logger?.warn?.('conversation-mode: policy sync on agent creation failed: %o', error);
    }
  });

  ctx.on('agent/disposed', ({ agent }) => {
    const entry = policies.get(agent);
    if (entry === undefined) return;
    entry.dispose?.();
    policies.delete(agent);
  });

  // The projection is the one place a mode change becomes visible from the log, so this
  // is where a live agent picks it up (including a change made from another tab).
  ctx.sessionProjections.onChanged((session, key) => {
    if (key !== PROJECTION_KEY) return;
    const agents = ctx.get('agents');
    if (agents === undefined) return;
    let agent;
    try {
      agent = agents.get(session.id);
    } catch {
      agent = undefined;
    }
    if (agent === undefined) return;
    try {
      syncPolicy(agent);
    } catch (error) {
      ctx.logger?.warn?.('conversation-mode: policy sync on mode change failed: %o', error);
    }
  });

  ctx.effect(
    () => () => {
      for (const entry of policies.values()) entry.dispose?.();
      policies.clear();
    },
    'conversation-mode: dispose agent tool policies',
  );

  // ── the human command ────────────────────────────────────────────────────────────────
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: COMMAND_NAME,
      description:
        'Enter or leave conversation mode: chat-first replies with read-only tools. Add a message to enter and send it in one step, or "off" to leave.',
      input: { hint: '[off|message]', attachments: true },
      handler: ({ agent, rawInput, attachments }) => {
        const text = rawInput.trim();
        const leaving = text.toLowerCase() === OFF_ARGUMENT;
        if (leaving && attachments.length > 0) {
          return { kind: 'error', text: 'Attachments cannot accompany /conversation off.' };
        }
        if (leaving) {
          return {
            kind: 'success',
            text:
              resolved.tools === 'readonly'
                ? 'Conversation mode off. Coding tools are available again.'
                : 'Conversation mode off.',
          };
        }
        if (text !== '' || attachments.length > 0) {
          const content = [
            ...attachments,
            ...(text === '' ? [] : [{ type: 'text', text }]),
          ];
          try {
            agent.steer(createUserMessage(content));
          } catch (error) {
            ctx.logger?.warn?.('conversation-mode: cannot steer the /conversation message: %o', error);
            return {
              kind: 'error',
              text: 'Conversation mode was not changed: the message could not be sent. Send it again as a normal message.',
            };
          }
        }
        return {
          kind: 'success',
          text:
            resolved.tools === 'readonly'
              ? 'Conversation mode on — chat-first replies, read-only tools. Use /conversation off to leave.'
              : 'Conversation mode on — chat-first replies. Use /conversation off to leave.',
        };
      },
    });
  });
}
