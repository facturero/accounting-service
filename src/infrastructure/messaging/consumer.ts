import { EventHandler, InboxConsumer } from '@facturero/outbox-relay';
import type { Sequelize } from 'sequelize';
import { AutomaticPostingUseCase, POSTING_EVENT_TYPES } from '../../application/use-cases/automatic-posting.js';
import { SetAutoPostingByPluginUseCase } from '../../application/use-cases/posting-settings-use-cases.js';

/**
 * Eventos que consume accounting-service (ver asyncapi.yaml). Todo pasa por el InboxConsumer: idempotencia por `eventId`,
 * reintentos con espera y el estado `failed` en `processed_events`. Lo que es un asunto de negocio (periodo cerrado, cuenta sin
 * rol) NO es un fallo del consumidor: queda en `pending_postings` y el evento se da por procesado.
 */
export const CONSUMED_BINDINGS = [...POSTING_EVENT_TYPES, 'plugin.activated', 'plugin.deactivated'] as const;

export interface ConsumerDeps {
  posting: AutomaticPostingUseCase;
  pluginToggle: SetAutoPostingByPluginUseCase;
}

export function buildEventHandlers(deps: ConsumerDeps): EventHandler[] {
  const posting: EventHandler[] = POSTING_EVENT_TYPES.map((eventType) => ({
    eventType,
    handle: async (payload: unknown): Promise<void> => {
      const result = await deps.posting.handle(eventType, payload);
      if (result.outcome === 'pending') {
        console.warn(`[accounting-service] ${eventType} quedó pendiente (${result.reasonCode}): ${result.message}`);
      }
    },
  }));

  return [
    ...posting,
    {
      eventType: 'plugin.activated',
      handle: async (payload: unknown): Promise<void> => {
        const p = payload as { organizationId?: string; code?: string };
        if (p.organizationId && p.code) await deps.pluginToggle.execute({ organizationId: p.organizationId, code: p.code, active: true });
      },
    },
    {
      eventType: 'plugin.deactivated',
      handle: async (payload: unknown): Promise<void> => {
        const p = payload as { organizationId?: string; code?: string };
        if (p.organizationId && p.code) await deps.pluginToggle.execute({ organizationId: p.organizationId, code: p.code, active: false });
      },
    },
  ];
}

export async function startEventConsumers(params: {
  sequelize: Sequelize;
  rabbitmqUrl: string;
  exchange: string;
  queue: string;
  handlers: EventHandler[];
}): Promise<void> {
  const consumer = new InboxConsumer({
    sequelize: params.sequelize,
    rabbitmqUrl: params.rabbitmqUrl,
    exchange: params.exchange,
    queue: params.queue,
    bindings: [...CONSUMED_BINDINGS],
    handlers: params.handlers,
  });
  await consumer.start();
}
