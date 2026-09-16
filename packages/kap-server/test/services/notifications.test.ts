import {
  type AgentContext,
  IAgentLifecycleService,
  IConfigService,
  IEventBus,
  IFlagService,
  INTERACTION_TAG_SESSION_ID,
  ISessionActivityView,
  type IScopeHandle,
  LifecycleScope,
  MAIN_AGENT_ID,
  type Event2,
  type Interaction,
  type InteractionKind,
  type InteractionPendingChangedEvent,
  type InteractionQuery,
  type InteractionResolution,
  type ISessionScopeHandle,
  type Scope,
  type SessionActivityChangedEvent,
  type SessionActivityState,
} from '@moonshot-ai/agent-core-v2';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NOTIFICATIONS_CONFIG,
  NOTIFICATIONS_SECTION,
  type NotificationsConfig,
} from '../../src/services/notifications/configSection';
import { NOTIFICATIONS_FLAG_ID } from '../../src/services/notifications/flag';
import {
  NotificationsService,
  type InteractionSource,
  type SessionSource,
} from '../../src/services/notifications/notificationsService';
import {
  createHttpNtfyClient,
  type NtfyClient,
  type NtfyPublishOptions,
} from '../../src/services/notifications/ntfyClient';

class FakeNtfyClient {
  readonly published: NtfyPublishOptions[] = [];

  async publish(options: NtfyPublishOptions): Promise<void> {
    this.published.push(options);
  }
}

function satisfiesNtfyClient(client: FakeNtfyClient): NtfyClient {
  return client;
}

class FakeInteractions implements InteractionSource {
  readonly pendingListeners: Array<(event: InteractionPendingChangedEvent) => void> = [];
  readonly resolveListeners: Array<(event: InteractionResolution) => void> = [];
  private readonly records = new Map<string, Interaction>();

  findAll(query?: InteractionQuery): readonly Interaction[] {
    const all = [...this.records.values()];
    if (query === undefined) return all;
    return all.filter(
      (record) =>
        (query.id === undefined || record.id === query.id) &&
        (query.kind === undefined || record.kind === query.kind) &&
        (query.resolved === undefined || false === query.resolved) &&
        Object.entries(query.tags ?? {}).every(([key, value]) => record.tags[key] === value),
    );
  }

  get pendingSubscriptionCount(): number {
    return this.pendingListeners.length;
  }

  get resolveSubscriptionCount(): number {
    return this.resolveListeners.length;
  }

  onDidChangePending(listener: (event: InteractionPendingChangedEvent) => void): () => void {
    this.pendingListeners.push(listener);
    return () => {
      const index = this.pendingListeners.indexOf(listener);
      if (index >= 0) this.pendingListeners.splice(index, 1);
    };
  }

  onDidResolve(listener: (event: InteractionResolution) => void): () => void {
    this.resolveListeners.push(listener);
    return () => {
      const index = this.resolveListeners.indexOf(listener);
      if (index >= 0) this.resolveListeners.splice(index, 1);
    };
  }

  enqueue(interaction: Interaction): void {
    this.records.set(interaction.id, interaction);
    this.firePendingChanged();
  }

  respond(id: string, response: unknown): void {
    this.records.delete(id);
    for (const listener of [...this.resolveListeners]) listener({ id, response });
    this.firePendingChanged();
  }

  private firePendingChanged(): void {
    const pending = [...this.records.values()].filter(() => true).map((record) => record.id);
    for (const listener of [...this.pendingListeners]) listener({ pending });
  }
}

class FakeWorkView {
  subscriptionCount = 0;
  private readonly listeners = new Set<(change: SessionActivityChangedEvent) => void>();
  private current: SessionActivityState = {
    busy: false,
    mainTurnActive: false,
    pendingInteraction: 'none',
  };

  state(): SessionActivityState {
    return this.current;
  }

  onDidChange(listener: (change: SessionActivityChangedEvent) => void): { dispose(): void } {
    this.subscriptionCount += 1;
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  set(patch: Partial<SessionActivityState>): void {
    this.current = { ...this.current, ...patch };
    for (const listener of [...this.listeners]) listener({ state: this.current, cause: 'turn_ended' });
  }
}

class FakeAgentBus {
  subscribeCount = 0;
  private readonly handlers: Array<(event: Event2<any>) => void> = [];

  subscribe(handler: (event: Event2<any>) => void): { dispose(): void };
  subscribe(type: string, handler: (event: Event2<any>) => void): { dispose(): void };
  subscribe(
    typeOrHandler: string | ((event: Event2<any>) => void),
    handler?: (event: Event2<any>) => void,
  ): { dispose(): void } {
    const effective = typeof typeOrHandler === 'function' ? typeOrHandler : handler!;
    this.subscribeCount += 1;
    this.handlers.push(effective);
    return {
      dispose: () => {
        const index = this.handlers.indexOf(effective);
        if (index >= 0) this.handlers.splice(index, 1);
      },
    };
  }

  emit(event: Event2<any>): void {
    for (const handler of [...this.handlers]) handler(event);
  }
}

class FakeAgentLifecycle {
  readonly bus = new FakeAgentBus();
  private readonly createListeners: Array<(context: AgentContext) => void> = [];

  list(): readonly AgentContext[] {
    return [{ agentId: MAIN_AGENT_ID } as unknown as AgentContext];
  }

  handleOf(agentId: string): IScopeHandle | undefined {
    if (agentId !== MAIN_AGENT_ID) return undefined;
    return {
      id: agentId,
      kind: LifecycleScope.Agent,
      accessor: { get: (token: unknown) => (token === IEventBus ? this.bus : undefined) },
      dispose: () => {},
    } as unknown as IScopeHandle;
  }

  onDidCreate(listener: (context: AgentContext) => void): { dispose(): void } {
    this.createListeners.push(listener);
    return { dispose: () => {} };
  }

  onDidClose(_listener: (context: AgentContext) => void): { dispose(): void } {
    return { dispose: () => {} };
  }

  emitAgentCreated(agentId: string): void {
    for (const listener of [...this.createListeners]) {
      listener({ agentId } as unknown as AgentContext);
    }
  }
}

class FakeSessionHandle {
  readonly kind = LifecycleScope.Session;
  readonly workView = new FakeWorkView();
  readonly agents = new FakeAgentLifecycle();

  constructor(readonly id: string) {}

  get handle(): ISessionScopeHandle {
    return this as unknown as ISessionScopeHandle;
  }

  get accessor(): { get(token: unknown): unknown } {
    return {
      get: (token: unknown) => {
        if (token === ISessionActivityView) return this.workView;
        if (token === IAgentLifecycleService) return this.agents;
        return undefined;
      },
    };
  }

  dispose(): void {}
}

class FakeSessions implements SessionSource {
  private readonly handles: FakeSessionHandle[] = [];
  private readonly createListeners: Array<
    (event: { sessionId: string; handle: ISessionScopeHandle }) => unknown
  > = [];

  list(): readonly ISessionScopeHandle[] {
    return this.handles.map((handle) => handle.handle);
  }

  get createdCount(): number {
    return this.createListeners.length;
  }

  onDidCreateSession(
    listener: (event: { sessionId: string; handle: ISessionScopeHandle }) => unknown,
  ): { dispose(): void } {
    this.createListeners.push(listener);
    return { dispose: () => {} };
  }

  onDidCloseSession(_listener: (event: { sessionId: string }) => unknown): { dispose(): void } {
    return { dispose: () => {} };
  }

  add(handle: FakeSessionHandle): void {
    this.handles.push(handle);
    for (const listener of [...this.createListeners]) {
      listener({ sessionId: handle.id, handle: handle.handle });
    }
  }
}

function makeCore(config: NotificationsConfig, flagEnabled: boolean): Scope {
  return {
    accessor: {
      get: (token: unknown) => {
        if (token === IConfigService) {
          return {
            ready: Promise.resolve(),
            get: (domain: string) => (domain === NOTIFICATIONS_SECTION ? config : undefined),
          };
        }
        if (token === IFlagService) {
          return { enabled: (id: string) => id === NOTIFICATIONS_FLAG_ID && flagEnabled };
        }
        return undefined;
      },
    },
  } as unknown as Scope;
}

function makeConfig(overrides: Partial<NotificationsConfig> = {}): NotificationsConfig {
  return {
    ...DEFAULT_NOTIFICATIONS_CONFIG,
    enabled: true,
    topic: 'kc-test-topic',
    ...overrides,
  };
}

function interaction(
  id: string,
  kind: InteractionKind,
  sessionId: string,
  payload: unknown,
): Interaction {
  return {
    id,
    kind,
    payload,
    tags: { [INTERACTION_TAG_SESSION_ID]: sessionId },
    createdAt: 0,
  } as Interaction;
}

interface Harness {
  service: NotificationsService;
  client: FakeNtfyClient;
  interactions: FakeInteractions;
  sessions: FakeSessions;
  session: FakeSessionHandle;
}

function makeHarness(): Harness {
  const client = new FakeNtfyClient();
  const interactions = new FakeInteractions();
  const sessions = new FakeSessions();
  const session = new FakeSessionHandle('s1');
  const service = new NotificationsService({
    client: satisfiesNtfyClient(client),
    sources: { interactions, sessions },
  });
  return { service, client, interactions, sessions, session };
}

async function startHarness(
  overrides: { config?: Partial<NotificationsConfig>; flagEnabled?: boolean } = {},
): Promise<Harness> {
  const harness = makeHarness();
  await harness.service.start(makeCore(makeConfig(overrides.config), overrides.flagEnabled !== false));
  return harness;
}

describe('NotificationsService', () => {
  it('publishes the ntfy event set from the broadcaster sources', async () => {
    const harness = await startHarness();
    harness.sessions.add(harness.session);

    harness.interactions.enqueue(
      interaction('a1', 'approval', 's1', { toolName: 'Bash', toolInput: { command: 'rm -rf /' } }),
    );
    harness.interactions.enqueue(
      interaction('q1', 'question', 's1', { questions: [{ question: 'Pick one' }] }),
    );
    harness.session.workView.set({ busy: true, mainTurnActive: true });
    harness.session.workView.set({
      busy: false,
      mainTurnActive: false,
      lastTurnReason: 'failed',
    });
    harness.session.agents.bus.emit({ type: 'error', message: 'boom' } as unknown as Event2<any>);
    harness.service.onRemoteControlStatus('relay_connected');
    harness.service.onRemoteControlStatus('relay_disconnected');

    expect(harness.client.published.map((message) => [message.priority, message.title])).toEqual([
      [5, 'Approval requested'],
      [4, 'Question requested'],
      [3, 'Turn finished'],
      [4, 'Agent error'],
      [3, 'Remote control connected'],
      [2, 'Remote control disconnected'],
    ]);
    const finished = harness.client.published.find((message) => message.title === 'Turn finished');
    expect(finished?.message).toContain('s1');
    expect(finished?.message).toContain('failed');
  });

  it('carries generic text and ids only, never payload detail', async () => {
    const harness = await startHarness();
    harness.sessions.add(harness.session);
    const secretPath = '/home/georgefu/Projects/kimi-code';
    const secretInput = 'sk-toolkit-token-123';

    harness.interactions.enqueue(
      interaction('a1', 'approval', 's1', {
        toolName: 'Bash',
        toolInput: { command: `cat ${secretPath}/.env` },
      }),
    );
    harness.session.agents.bus.emit({
      type: 'error',
      message: `cannot read ${secretPath}/x token ${secretInput}`,
    } as unknown as Event2<any>);

    expect(harness.client.published).toHaveLength(2);
    for (const message of harness.client.published) {
      const rendered = JSON.stringify([message.message, message.title, message.click, message.tags]);
      expect(rendered).not.toContain(secretPath);
      expect(rendered).not.toContain(secretInput);
      expect(rendered).not.toContain('toolInput');
      expect(rendered).not.toContain('command');
    }
    const approval = harness.client.published[0]!;
    expect(approval.message).toBe('approval requested - session s1');
    expect(approval.click).toBe('kimi://session/s1/approval/a1');
  });

  it('publishes a dismissal marker on resolution without a clear field', async () => {
    const harness = await startHarness();
    harness.sessions.add(harness.session);
    harness.interactions.enqueue(interaction('a1', 'approval', 's1', {}));
    harness.interactions.respond('a1', { decision: 'approved', scope: 'session' });

    const resolution = harness.client.published.at(-1)!;
    expect(resolution).not.toHaveProperty('clear');
    expect(resolution.message).toContain('a1');
    expect(resolution.priority).toBe(1);
  });

  it('stays inert while the experimental flag is off', async () => {
    const harness = await startHarness({ flagEnabled: false });
    harness.sessions.add(harness.session);
    harness.interactions.enqueue(interaction('a1', 'approval', 's1', {}));
    harness.session.workView.set({ busy: true });
    harness.session.workView.set({ busy: false, lastTurnReason: 'completed' });
    harness.session.agents.bus.emit({ type: 'error' } as unknown as Event2<any>);
    harness.service.onRemoteControlStatus('relay_connected');

    expect(harness.client.published).toEqual([]);
    expect(harness.interactions.pendingSubscriptionCount).toBe(0);
    expect(harness.interactions.resolveSubscriptionCount).toBe(0);
    expect(harness.session.workView.subscriptionCount).toBe(0);
    expect(harness.session.agents.bus.subscribeCount).toBe(0);
    expect(harness.sessions.createdCount).toBe(0);
  });

  it('stays inert when the section is disabled or has no topic', async () => {
    for (const config of [makeConfig({ enabled: false }), makeConfig({ topic: undefined })]) {
      const inert = makeHarness();
      await inert.service.start(makeCore(config, true));
      inert.sessions.add(inert.session);
      inert.interactions.enqueue(interaction('a1', 'approval', 's1', {}));
      expect(inert.client.published).toEqual([]);
      expect(inert.interactions.pendingSubscriptionCount).toBe(0);
    }
  });

  it('drops events below min_priority', async () => {
    const harness = await startHarness({ config: { minPriority: 4 } });
    harness.sessions.add(harness.session);
    harness.session.workView.set({ busy: true });
    harness.session.workView.set({ busy: false, lastTurnReason: 'completed' });
    harness.service.onRemoteControlStatus('relay_connected');
    harness.service.onRemoteControlStatus('relay_disconnected');
    harness.interactions.enqueue(interaction('a1', 'approval', 's1', {}));

    expect(harness.client.published.map((message) => message.title)).toEqual([
      'Approval requested',
    ]);
  });

  it('publishes the dismissal marker even when min_priority filters its priority', async () => {
    const harness = await startHarness({ config: { minPriority: 4 } });
    harness.sessions.add(harness.session);
    harness.service.onRemoteControlStatus('relay_disconnected');
    harness.interactions.enqueue(interaction('a1', 'approval', 's1', {}));
    harness.interactions.respond('a1', { decision: 'approved', scope: 'session' });

    expect(harness.client.published.map((message) => message.title)).toEqual([
      'Approval requested',
      'Resolved',
    ]);
    const resolution = harness.client.published.at(-1)!;
    expect(resolution.priority).toBe(1);
  });

  it('drops events excluded by the events filter', async () => {
    const harness = await startHarness({
      config: { events: ['approval.requested', 'question.requested'] },
    });
    harness.sessions.add(harness.session);
    harness.session.workView.set({ busy: true });
    harness.session.workView.set({ busy: false, lastTurnReason: 'completed' });
    harness.session.agents.bus.emit({ type: 'error' } as unknown as Event2<any>);
    harness.service.onRemoteControlStatus('relay_connected');
    harness.interactions.enqueue(interaction('a1', 'approval', 's1', {}));

    expect(harness.client.published.map((message) => message.title)).toEqual(['Approval requested']);
  });

  it('ignores non-attention interaction kinds and remote device streams', async () => {
    const harness = await startHarness();
    harness.sessions.add(harness.session);
    harness.interactions.enqueue(interaction('t1', 'user_tool', 's1', {}));
    harness.service.onRemoteControlStatus('device_connected');
    harness.service.onRemoteControlStatus('device_disconnected');

    expect(harness.client.published).toEqual([]);
  });

  it('reports the busy edge only when a session turns idle', async () => {
    const harness = await startHarness();
    harness.sessions.add(harness.session);
    harness.session.workView.set({ busy: true, mainTurnActive: true });
    harness.session.workView.set({ busy: true, mainTurnActive: true, lastTurnReason: 'completed' });
    expect(harness.client.published).toEqual([]);
    harness.session.workView.set({ busy: false, mainTurnActive: false, lastTurnReason: 'completed' });
    expect(harness.client.published).toHaveLength(1);
  });

  it('stops publishing after close', async () => {
    const harness = await startHarness();
    harness.sessions.add(harness.session);
    harness.service.close();
    harness.interactions.enqueue(interaction('a1', 'approval', 's1', {}));

    expect(harness.client.published).toEqual([]);
  });
});

describe('createHttpNtfyClient', () => {
  it('omits the clear key from the published body', async () => {
    const bodies: string[] = [];
    const client = createHttpNtfyClient({
      baseUrl: 'https://ntfy.example.test',
      fetch: async (_input, init) => {
        const request = new Request('https://ntfy.example.test/', init);
        bodies.push(await request.text());
        return new Response(null, { status: 200 });
      },
    });
    const interactions = new FakeInteractions();
    const service = new NotificationsService({
      client,
      sources: { interactions, sessions: new FakeSessions() },
    });
    await service.start(makeCore(makeConfig(), true));
    interactions.enqueue(interaction('a1', 'approval', 's1', {}));
    interactions.respond('a1', { decision: 'approved', scope: 'session' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toContain('clear');
    const parsed = JSON.parse(bodies[1]!) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('clear');
    expect(parsed['priority']).toBe(1);
  });
});
