import { NotSetUpError, ValidationError } from '../../domain/errors.js';
import { isLocalDate } from '../../domain/period.js';
import { COLLECTION_ROLES, DEFAULT_PAYMENT_METHOD_ROLES, type CollectionRole } from '../../domain/posting.js';
import type { AccountingSettings, UnitOfWork } from '../../domain/repositories.js';
import { postingSettingsUpdatedEvent } from '../events.js';
import type { UnitOfWorkGateway } from '../ports.js';
import { GENERAL_LEDGER_PLUGIN } from './automatic-posting.js';

export interface PostingSettingsView {
  settings: AccountingSettings;
  pendingCount: number;
  /** Los valores por defecto de cada forma de pago, para que la pantalla muestre qué pasa con las que no se tocaron. */
  defaultPaymentMethodRoles: Readonly<Record<string, CollectionRole>>;
}

export class GetPostingSettingsUseCase {
  constructor(private readonly repos: Pick<UnitOfWork, 'settings' | 'pendingPostings'>) {}

  async execute(organizationId: string): Promise<PostingSettingsView> {
    const settings = await this.repos.settings.find(organizationId);
    if (!settings) throw new NotSetUpError();
    return {
      settings,
      pendingCount: await this.repos.pendingPostings.countPending(organizationId),
      defaultPaymentMethodRoles: DEFAULT_PAYMENT_METHOD_ROLES,
    };
  }
}

function assertTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  } catch {
    throw new ValidationError([{ field: 'timezone', message: 'La zona horaria no es válida (p. ej. America/Guayaquil).' }]);
  }
}

export class UpdatePostingSettingsUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway) {}

  async execute(input: {
    organizationId: string;
    autoPosting?: boolean;
    /** `null` quita el límite (se contabiliza todo lo que llegue). */
    autoPostingFrom?: string | null;
    paymentMethodRoles?: Record<string, CollectionRole> | null;
    timezone?: string;
  }): Promise<AccountingSettings> {
    const uow = await this.gateway.begin();
    try {
      const settings = await uow.settings.find(input.organizationId);
      if (!settings) throw new NotSetUpError();
      const previous = { autoPosting: settings.autoPosting, autoPostingFrom: settings.autoPostingFrom };

      if (input.autoPosting !== undefined) settings.autoPosting = input.autoPosting;
      if (input.autoPostingFrom !== undefined) {
        if (input.autoPostingFrom !== null && !isLocalDate(input.autoPostingFrom)) {
          throw new ValidationError([{ field: 'autoPostingFrom', message: 'La fecha debe tener el formato YYYY-MM-DD.' }]);
        }
        settings.autoPostingFrom = input.autoPostingFrom;
      }
      if (input.timezone !== undefined) {
        assertTimeZone(input.timezone);
        settings.timezone = input.timezone;
      }
      if (input.paymentMethodRoles !== undefined) {
        if (input.paymentMethodRoles !== null) {
          for (const [code, role] of Object.entries(input.paymentMethodRoles)) {
            if (!/^\d{2}$/.test(code)) throw new ValidationError([{ field: 'paymentMethodRoles', message: `«${code}» no es un código de forma de pago del SRI (dos cifras).` }]);
            if (!COLLECTION_ROLES.includes(role)) throw new ValidationError([{ field: 'paymentMethodRoles', message: `El rol de «${code}» debe ser caja, bancos o por cobrar.` }]);
          }
        }
        settings.paymentMethodRoles = input.paymentMethodRoles;
      }

      await uow.settings.update(settings);
      await uow.outbox.add(postingSettingsUpdatedEvent(settings, previous));
      await uow.commit();
      return settings;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}

/**
 * El catálogo avisa cuando la organización activa o desactiva el módulo. Desactivarlo apaga la contabilización automática: los
 * eventos que lleguen mientras tanto quedan pendientes (no se pierden) y al reactivar se pueden reintentar.
 */
export class SetAutoPostingByPluginUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway) {}

  async execute(input: { organizationId: string; code: string; active: boolean }): Promise<void> {
    if (input.code !== GENERAL_LEDGER_PLUGIN) return;
    const uow = await this.gateway.begin();
    try {
      const settings = await uow.settings.find(input.organizationId);
      if (!settings || settings.autoPosting === input.active) {
        await uow.rollback();
        return;
      }
      const previous = { autoPosting: settings.autoPosting, autoPostingFrom: settings.autoPostingFrom };
      settings.autoPosting = input.active;
      await uow.settings.update(settings);
      await uow.outbox.add(postingSettingsUpdatedEvent(settings, previous));
      await uow.commit();
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}
