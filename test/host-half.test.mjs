/**
 * Unit test for dsh-convo-mode's Host half.
 * Exercises the plugin with a fake Cordis context: projection folding, prompt section,
 * command handler, and per-agent tool restriction. Run with `node test/host-half.test.mjs`.
 */
import assert from 'node:assert/strict';

const plugin = await import('../index.js');
const { apply } = plugin;

function makeCtx() {
  const listeners = new Map();
  const effects = [];
  const registered = { projection: undefined, section: undefined, command: undefined };
  const restrictCalls = [];
  const steerCalls = [];
  const sections = [];
  const states = new Map();
  const changeListeners = [];
  const globalTools = {
    // Tools in this deployment are registered by the agent preset on an ANCESTOR
    // scope, not globally: the global view is nearly empty, and only the
    // scope-aware call sees what the agent can actually call.
    schemas: (scope) =>
      scope === undefined
        ? [{ name: 'cordis_inspect_list' }]
        : [
            { name: 'read' },
            { name: 'write' },
            { name: 'bash' },
            { name: 'web_search' },
            { name: 'ask_user_question' },
            { name: 'totally_unknown_tool' },
          ],
    restrict: (filter) => {
      restrictCalls.push(filter);
      return () => restrictCalls.push({ disposed: true });
    },
  };
  const agents = new Map();
  const ctx = {
    logger: { warn: (...args) => console.log('[warn]', ...args) },
    effect: (callback) => {
      const disposer = callback();
      effects.push(disposer);
      return disposer;
    },
    on: (event, listener) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    inject: (names, callback) => callback(ctx),
    get: (name) => {
      if (name === 'tools') return globalTools;
      if (name === 'agents') {
        return {
          list: () => [...agents.values()],
          get: (id) => [...agents.values()].find((agent) => agent.session.id === id),
        };
      }
      return undefined;
    },
    sessionProjections: {
      register: (definition) => {
        registered.projection = definition;
        return () => {};
      },
      stateOf: (session, key) => (key === 'conversation' ? states.get(session.id) : undefined),
      onChanged: (listener) => {
        changeListeners.push(listener);
        return () => {};
      },
    },
    systemPrompt: {
      section: (definition) => {
        sections.push(definition);
        registered.section = definition;
        return () => {};
      },
    },
    commands: {
      register: (definition) => {
        registered.command = definition;
        return () => {};
      },
    },
  };
  return {
    ctx,
    listeners,
    effects,
    registered,
    restrictCalls,
    steerCalls,
    sections,
    states,
    changeListeners,
    agents,
  };
}

function makeAgent(harness, sessionId) {
  const agent = {
    session: { id: sessionId },
    steer: (message) => harness.steerCalls.push(message),
    ctx: {
      get: () => harness.ctx.get('tools'),
      tools: harness.ctx.get('tools'),
    },
  };
  harness.agents.set(sessionId, agent);
  return agent;
}

function fold(harness, sessionId, events) {
  const definition = harness.registered.projection;
  let state = definition.init();
  for (const event of events) state = definition.apply(state, event);
  harness.states.set(sessionId, state);
  return state;
}

function view(harness, sessionId) {
  const definition = harness.registered.projection;
  return definition.wire.view(harness.states.get(sessionId));
}

// ── load ─────────────────────────────────────────────────────────────────────────────
assert.equal(plugin.name, 'conversation-mode');
assert.deepEqual(plugin.inject, ['sessionProjections', 'systemPrompt']);

const harness = makeCtx();
apply(harness.ctx, {});

assert.ok(harness.registered.projection, 'projection registered');
assert.equal(harness.registered.projection.key, 'conversation');
assert.equal(harness.registered.section.name, 'conversation:policy');
assert.equal(harness.registered.section.order, 550);
assert.equal(harness.registered.command.name, 'conversation');
assert.ok(harness.registered.command.input.attachments, 'command admits attachments');

// ── projection: bare entry, message entry, exit, failure ────────────────────────────
const entry = fold(harness, 's1', [
  { type: 'command/run', data: { commandId: 'c1', name: 'conversation', source: { kind: 'user' } } },
]);
assert.deepEqual(view(harness, 's1'), { active: true, pending: true }, 'entry is effective before it settles');
assert.deepEqual(
  fold(harness, 's1', [
    { type: 'command/run', data: { commandId: 'c1', name: 'conversation', source: { kind: 'user' } } },
    { type: 'command/done', data: { commandId: 'c1', kind: 'success' } },
  ]),
  { active: true, running: null },
);
assert.deepEqual(view(harness, 's1'), { active: true, pending: false });

assert.deepEqual(
  fold(harness, 's2', [
    { type: 'command/run', data: { commandId: 'c2', name: 'conversation', args: 'off', source: { kind: 'user' } } },
    { type: 'command/done', data: { commandId: 'c2', kind: 'success' } },
  ]),
  { active: false, running: null },
);

// A failed command must not apply its selection.
assert.deepEqual(
  fold(harness, 's3', [
    { type: 'command/run', data: { commandId: 'c3', name: 'conversation', source: { kind: 'user' } } },
    { type: 'command/done', data: { commandId: 'c3', kind: 'error' } },
  ]),
  { active: false, running: null },
);

// Unrelated commands and unknown events keep the same reference (cheap folds).
const base = harness.states.get('s1');
assert.equal(harness.registered.projection.apply(base, { type: 'turn/start', data: { turn: 1 } }), base);
assert.equal(
  harness.registered.projection.apply(base, {
    type: 'command/run',
    data: { commandId: 'cx', name: 'plan', source: { kind: 'user' } },
  }),
  base,
);

// A message argument still enters the mode.
assert.deepEqual(
  fold(harness, 's4', [
    { type: 'command/run', data: { commandId: 'c4', name: 'conversation', args: 'hello there', source: { kind: 'user' } } },
    { type: 'command/done', data: { commandId: 'c4', kind: 'success' } },
  ]),
  { active: true, running: null },
);

// ── projection schemas accept own output and reject garbage ─────────────────────────
const definition = harness.registered.projection;
for (const id of ['s1', 's2', 's3', 's4']) {
  assert.deepEqual(definition.stateSchema.parse(harness.states.get(id)), harness.states.get(id));
  assert.deepEqual(definition.wire.viewSchema.parse(view(harness, id)), view(harness, id));
}
assert.throws(() => definition.stateSchema.parse({ active: 'yes', running: null }));
assert.throws(() => definition.stateSchema.parse(null));
assert.throws(() => definition.wire.viewSchema.parse({ active: true }));

// ── prompt section follows the mode ─────────────────────────────────────────────────
const agent1 = makeAgent(harness, 's1');
const agent2 = makeAgent(harness, 's2');
assert.match(harness.registered.section.text({ agent: agent1 }), /conversation mode/i);
assert.equal(harness.registered.section.text({ agent: agent2 }), '');
assert.equal(harness.registered.section.text({}), '');

// A live change is picked up for the agent that owns the session.
makeAgent(harness, 's2');
harness.states.set('s2', { active: false, running: null });
for (const listener of harness.changeListeners) listener({ id: 's2' }, 'conversation', { active: false, pending: true });
harness.states.set('s2', { active: false, running: { commandId: 'c2', wanted: true } });
for (const listener of harness.changeListeners) listener({ id: 's2' }, 'conversation', { active: true, pending: true });
assert.equal(harness.registered.section.text({ agent: agent2 }), harness.registered.section.text({ agent: agent2 }));
assert.match(harness.registered.section.text({ agent: agent2 }), /conversation mode/i);
const restrictedForAgent2 = harness.restrictCalls.filter((call) => call.allow !== undefined);
assert.ok(restrictedForAgent2.length >= 1, 'tool restriction registered for an agent that entered the mode');

// ── tool policy contents ────────────────────────────────────────────────────────────
const allow = restrictedForAgent2.at(-1).allow;
assert.ok(allow.includes('read'), 'read stays allowed');
assert.ok(allow.includes('web_search'), 'web search stays allowed');
assert.ok(!allow.includes('write'), 'write is denied');
assert.ok(!allow.includes('bash'), 'bash is denied');
assert.ok(!allow.includes('totally_unknown_tool'), 'unknown names are filtered out');

// Leaving the mode disposes the restriction.
const before = harness.restrictCalls.length;
harness.states.set('s2', { active: false, running: null });
for (const listener of harness.changeListeners) listener({ id: 's2' }, 'conversation', { active: false, pending: false });
assert.ok(harness.restrictCalls.slice(before).some((call) => call.disposed === true), 'restriction disposed on exit');

// ── the command handler ─────────────────────────────────────────────────────────────
const command = harness.registered.command;
const idleAgent = makeAgent(harness, 's5');

const bare = command.handler({ agent: idleAgent, rawInput: '', attachments: [] });
assert.equal(bare.kind, 'success');
assert.match(bare.text, /Conversation mode on/);
assert.equal(harness.steerCalls.length, 0, 'a bare entry steers nothing');

const withMessage = command.handler({
  agent: idleAgent,
  rawInput: '  tell me a story  ',
  attachments: [{ type: 'image', attachment: { attachmentId: 'a1' } }],
});
assert.equal(withMessage.kind, 'success');
assert.equal(harness.steerCalls.length, 1);
const steered = harness.steerCalls[0];
assert.equal(steered.role, 'user');
assert.equal(steered.source.kind, 'user');
assert.ok(Object.isFrozen(steered), 'steered message is frozen');
assert.equal(steered.content[0].type, 'image');
assert.deepEqual(steered.content[1], { type: 'text', text: 'tell me a story' });

const off = command.handler({ agent: idleAgent, rawInput: 'off', attachments: [] });
assert.equal(off.kind, 'success');
assert.match(off.text, /Conversation mode off/);

const offWithAttachment = command.handler({
  agent: idleAgent,
  rawInput: 'off',
  attachments: [{ type: 'image', attachment: { attachmentId: 'a2' } }],
});
assert.equal(offWithAttachment.kind, 'error');
assert.equal(harness.steerCalls.length, 1, 'the rejection does not steer');

// `off` is case-insensitive, and a message that merely starts with "off" is not a leave.
assert.equal(command.handler({ agent: idleAgent, rawInput: 'OFF', attachments: [] }).kind, 'success');
command.handler({ agent: idleAgent, rawInput: 'offtopic question', attachments: [] });
assert.equal(harness.steerCalls.length, 2);

// A send failure must fail the command, not silently promise delivery.
const failingAgent = makeAgent(harness, 's6');
failingAgent.steer = () => {
  throw new Error('boom');
};
const failed = command.handler({ agent: failingAgent, rawInput: 'hi', attachments: [] });
assert.equal(failed.kind, 'error');
assert.match(failed.text, /not changed/);

// ── config validation ───────────────────────────────────────────────────────────────
const throws = (config, pattern) => {
  const fresh = makeCtx();
  assert.throws(() => apply(fresh.ctx, config), pattern);
};
throws({ section: '' });
throws({ section: 3 });
throws({ tools: 'everything' });
throws({ allow: 'read' });
throws({ allow: [3] });
throws({ allow: [] });
throws({ defaultActive: 'yes' });
throws({ unknownKey: true });

// `unrestricted` registers no restriction at all.
const permissive = makeCtx();
apply(permissive.ctx, { tools: 'unrestricted' });
permissive.states.set('s9', { active: true, running: null });
makeAgent(permissive, 's9');
const createdHandler = permissive.listeners.get('agent/created');
createdHandler({ agent: permissive.agents.get('s9') });
assert.equal(permissive.restrictCalls.length, 0, 'unrestricted keeps every tool');

// A custom allow list is intersected with available tools.
const custom = makeCtx();
apply(custom.ctx, { allow: ['read', 'nope_not_here'] });
custom.states.set('s10', { active: true, running: null });
const customAgent = makeAgent(custom, 's10');
custom.listeners.get('agent/created')({ agent: customAgent });
const customAllow = custom.restrictCalls.find((call) => call.allow !== undefined).allow;
assert.deepEqual(customAllow, ['read']);

// ── defaultActive ───────────────────────────────────────────────────────────────────
const defaultOn = makeCtx();
apply(defaultOn.ctx, { defaultActive: true });
assert.deepEqual(defaultOn.registered.projection.init(), { active: true, running: null });
const defaultOff = makeCtx();
apply(defaultOff.ctx, {});
assert.deepEqual(defaultOff.registered.projection.init(), { active: false, running: null });

// ── disposal disposes every agent policy ────────────────────────────────────────────
const disposed = harness.effects.map((disposer) => disposer).filter((d) => typeof d === 'function');
assert.ok(disposed.length > 0, 'effects are registered');

console.log('ALL HOST HALF TESTS PASSED');
