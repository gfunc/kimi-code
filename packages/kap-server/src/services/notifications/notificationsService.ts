import type {
  IDisposable,
  Interaction,
  InteractionKind,
  InteractionPendingChangedEvent,
  InteractionQuery,
  InteractionResolution,
  ISessionScopeHandle,
  Scope,
  SessionActivityState,
} from '@moonshot-ai/agent-core-v2';
import {
  IAgentLifecycleService,
  IConfigService,
  IEventBus,
  IFlagService,
  INTERACTION_TAG_SESSION_ID,
  ISessionActivityView,
  ISessionManager,
  MAIN_AGENT_ID,
  interactions,
  toDisposable,
} from '@moonshot-ai/agent-core-v2';
import type { RemoteControlStatus } from '@moonshot-ai/remote-control';

import type { ServerLogger } from '../pinoLoggerService';
import { NOTIFICATIONS_FLAG_ID } from './flag';
import {
  NOTIFICATIONS_SECTION,
  type NotificationEvent,
  type NotificationsConfig,
} from './configSection';
import { createHttpNtfyClient, type NtfyClient, type NtfyPublishOptions } from './ntfyClient';

export interface InteractionSource {
  findAll(query?: InteractionQuery): readonly Interaction[];
  onDidChangePending(
    listener: (event: InteractionPendingChangedEvent) => void,
  ): () => void;
  onDidResolve(listener: (event: InteractionResolution) => void): () => void;
}

export interface SessionSource {
  list(): readonly ISessionScopeHandle[];
  onDidCreateSession?: (
    listener: (event: { readonly sessionId: string; readonly handle: ISessionScopeHandle }) => unknown,
  ) => IDisposable;
  onDidCloseSession?: (
    listener: (event: { readonly sessionId: string }) => unknown,
  ) => IDisposable;
}

export interface NotificationSources {
  readonly interactions: InteractionSource;
  readonly sessions: SessionSource;
}

export interface NotificationsServiceOptions {
  readonly logger?: Pick<ServerLogger, 'info' | 'warn'>;
  readonly client?: NtfyClient;
  readonly sources?: NotificationSources;
}

interface SessionAttachment {
  readonly disposables: IDisposable[];
}

interface KnownInteraction {
  readonly kind: InteractionKind;
  readonly sessionId?: string;
}

const APPROVAL_PRIORITY = 5;
const QUESTION_PRIORITY = 4;
const WORK_FINISHED_PRIORITY = 3;
const AGENT_ERROR_PRIORITY = 4;
const REMOTE_CONNECTED_PRIORITY = 3;
const REMOTE_DISCONNECTED_PRIORITY = 2;
const RESOLVED_PRIORITY = 1;

export class NotificationsService {
  private active = false;
  private closed = false;
  private config: NotificationsConfig | undefined;
  private client: NtfyClient | undefined;
  private readonly attachments = new Map<string, SessionAttachment>();
  private readonly knownInteractions = new Map<string, KnownInteraction>();
  private readonly disposables: IDisposable[] = [];

  constructor(private readonly opts: NotificationsServiceOptions) {}

  async start(core: Scope): Promise<void> {
    if (this.closed || this.active) return;
    const config = core.accessor.get(IConfigService);
    await config.ready;
    if (this.closed) return;
    if (!core.accessor.get(IFlagService).enabled(NOTIFICATIONS_FLAG_ID)) return;
    const section = config.get<NotificationsConfig>(NOTIFICATIONS_SECTION);
    if (!section.enabled || section.topic === undefined || section.topic.length === 0) {
      return;
    }
    this.config = section;
    this.client = this.opts.client ?? createHttpNtfyClient({
      baseUrl: section.ntfyUrl,
      token: section.token,
    });
    const sources =
      this.opts.sources ??
      ({ interactions, sessions: core.accessor.get(ISessionManager) } satisfies NotificationSources);
    this.active = true;

    for (const interaction of sources.interactions.findAll({ resolved: false })) {
      this.rememberInteraction(interaction);
    }
    this.disposables.push(
      toDisposable(
        sources.interactions.onDidChangePending(() => {
          this.onPendingChanged(sources.interactions);
        }),
      ),
    );
    this.disposables.push(
      toDisposable(
        sources.interactions.onDidResolve((event) => {
          this.onResolved(event);
        }),
      ),
    );

    for (const handle of sources.sessions.list()) {
      this.attachSession(handle.id, handle);
    }
    if (sources.sessions.onDidCreateSession !== undefined) {
      this.disposables.push(
        sources.sessions.onDidCreateSession((event) => {
          this.attachSession(event.sessionId, event.handle);
        }),
      );
    }
    if (sources.sessions.onDidCloseSession !== undefined) {
      this.disposables.push(
        sources.sessions.onDidCloseSession((event) => {
          this.detachSession(event.sessionId);
        }),
      );
    }
    this.opts.logger?.info({ topic: section.topic }, 'ntfy notifications enabled');
  }

  onRemoteControlStatus(status: RemoteControlStatus): void {
    if (status === 'relay_connected') {
      this.publish('remote_control.connected', REMOTE_CONNECTED_PRIORITY, {
        title: 'Remote control connected',
        message: 'remote control connected',
        tags: ['satellite'],
      });
      return;
    }
    if (status === 'relay_disconnected') {
      this.publish('remote_control.disconnected', REMOTE_DISCONNECTED_PRIORITY, {
        title: 'Remote control disconnected',
        message: 'remote control disconnected',
        tags: ['satellite'],
      });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.active = false;
    for (const attachment of this.attachments.values()) {
      for (const disposable of attachment.disposables) disposable.dispose();
    }
    this.attachments.clear();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.knownInteractions.clear();
  }

  private onPendingChanged(source: InteractionSource): void {
    for (const interaction of source.findAll({ resolved: false })) {
      if (this.knownInteractions.has(interaction.id)) continue;
      this.rememberInteraction(interaction);
      this.publishInteractionRequested(interaction);
    }
  }

  private onResolved(event: InteractionResolution): void {
    const known = this.knownInteractions.get(event.id);
    if (known === undefined) return;
    this.knownInteractions.delete(event.id);
    this.publishResolved(known, event.id);
  }

  private rememberInteraction(interaction: Interaction): void {
    this.knownInteractions.set(interaction.id, {
      kind: interaction.kind,
      sessionId: sessionTagOf(interaction),
    });
  }

  private publishInteractionRequested(interaction: Interaction): void {
    const sessionId = sessionTagOf(interaction);
    if (interaction.kind === 'approval') {
      this.publish('approval.requested', APPROVAL_PRIORITY, {
        title: 'Approval requested',
        message: `approval requested - session ${sessionId ?? 'unknown'}`,
        tags: ['rotating_light'],
        click: sessionId === undefined ? undefined : `kimi://session/${sessionId}/approval/${interaction.id}`,
      });
      return;
    }
    if (interaction.kind === 'question') {
      this.publish('question.requested', QUESTION_PRIORITY, {
        title: 'Question requested',
        message: `question requested - session ${sessionId ?? 'unknown'}`,
        tags: ['question'],
        click: sessionId === undefined ? undefined : `kimi://session/${sessionId}/question/${interaction.id}`,
      });
    }
  }

  private publishResolved(known: KnownInteraction, id: string): void {
    this.publish(
      kindEventOf(known.kind),
      RESOLVED_PRIORITY,
      {
        title: 'Resolved',
        message: `interaction resolved - session ${known.sessionId ?? 'unknown'} - ${id}`,
        tags: ['white_check_mark'],
      },
      true,
    );
  }

  private attachSession(sessionId: string, handle: ISessionScopeHandle): void {
    if (this.closed || !this.active || this.attachments.has(sessionId)) return;
    const disposables: IDisposable[] = [];
    let busy = false;
    const workView = handle.accessor.get(ISessionActivityView);
    if (workView !== undefined) {
      busy = workView.state().busy;
      disposables.push(
        workView.onDidChange(({ state }) => {
          const wasBusy = busy;
          busy = state.busy;
          if (wasBusy && !state.busy) {
            this.publishWorkFinished(sessionId, state);
          }
        }),
      );
    }
    const agents = handle.accessor.get(IAgentLifecycleService);
    if (agents !== undefined) {
      const attachMainAgent = (): void => {
        const agentHandle = agents.handleOf(MAIN_AGENT_ID);
        if (agentHandle === undefined || agentHandle.kind !== 'agent') return;
        const bus = agentHandle.accessor.get(IEventBus);
        if (bus === undefined) return;
        disposables.push(
          bus.subscribe('error', () => {
            this.publishAgentError(sessionId);
          }),
        );
      };
      for (const agent of agents.list()) {
        if (agent.agentId === MAIN_AGENT_ID) attachMainAgent();
      }
      disposables.push(agents.onDidCreate((context) => {
        if (context.agentId === MAIN_AGENT_ID) attachMainAgent();
      }));
    }
    this.attachments.set(sessionId, { disposables });
  }

  private detachSession(sessionId: string): void {
    const attachment = this.attachments.get(sessionId);
    if (attachment === undefined) return;
    this.attachments.delete(sessionId);
    for (const disposable of attachment.disposables) disposable.dispose();
  }

  private publishWorkFinished(sessionId: string, state: SessionActivityState): void {
    const reason = state.lastTurnReason === undefined ? '' : ` - ${state.lastTurnReason}`;
    this.publish('work.finished', WORK_FINISHED_PRIORITY, {
      title: 'Turn finished',
      message: `session ${sessionId} idle${reason}`,
      tags: ['white_check_mark'],
      click: `kimi://session/${sessionId}`,
    });
  }

  private publishAgentError(sessionId: string): void {
    this.publish('agent.error', AGENT_ERROR_PRIORITY, {
      title: 'Agent error',
      message: `agent error - session ${sessionId}`,
      tags: ['skull'],
      click: `kimi://session/${sessionId}`,
    });
  }

  private publish(
    event: NotificationEvent,
    priority: number,
    message: Omit<NtfyPublishOptions, 'topic' | 'priority'>,
    control = false,
  ): void {
    if (!this.active || this.config === undefined || this.client === undefined) return;
    if (!this.config.events.includes(event)) return;
    if (!control && priority < this.config.minPriority) return;
    const topic = this.config.topic;
    if (topic === undefined) return;
    void this.client
      .publish({
        topic,
        priority,
        message: message.message,
        title: message.title,
        tags: message.tags,
        click: message.click,
      })
      .catch((error: unknown) => {
        this.opts.logger?.warn(
          { err: error instanceof Error ? error.message : String(error), event },
          'ntfy publish failed',
        );
      });
  }
}

function sessionTagOf(interaction: Interaction): string | undefined {
  const tag = interaction.tags[INTERACTION_TAG_SESSION_ID];
  return typeof tag === 'string' && tag.length > 0 ? tag : undefined;
}

function kindEventOf(kind: InteractionKind): NotificationEvent {
  return kind === 'question' ? 'question.requested' : 'approval.requested';
}
