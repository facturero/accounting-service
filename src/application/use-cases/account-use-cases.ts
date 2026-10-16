import { Account, type AccountType, CostCenter, type EntityStatus, type SystemRole } from '../../domain/account.js';
import {
  AccountCodeExistsError,
  AccountInUseError,
  AccountNotFoundError,
  AccountParentInvalidError,
  CostCenterCodeExistsError,
  CostCenterNotFoundError,
  ValidationError,
} from '../../domain/errors.js';
import type { AccountListFilters, AccountRepository, CostCenterRepository } from '../../domain/repositories.js';
import { compareCodes } from '../../domain/reports.js';
import { accountCreatedEvent, accountUpdatedEvent, costCenterUpsertedEvent } from '../events.js';
import type { UnitOfWorkGateway } from '../ports.js';

export class ListAccountsUseCase {
  constructor(private readonly repos: { accounts: Pick<AccountRepository, 'list'> }) {}

  async execute(organizationId: string, filters?: AccountListFilters): Promise<Account[]> {
    const rows = await this.repos.accounts.list(organizationId, filters);
    return rows.sort((a, b) => compareCodes(a.code, b.code));
  }
}

export class GetAccountUseCase {
  constructor(private readonly repos: { accounts: Pick<AccountRepository, 'findById'> }) {}

  async execute(organizationId: string, accountId: string): Promise<Account> {
    const account = await this.repos.accounts.findById(organizationId, accountId);
    if (!account) throw new AccountNotFoundError();
    return account;
  }
}

export interface CreateAccountInput {
  organizationId: string;
  code: string;
  name: string;
  /** Obligatorio solo en una cuenta raíz; una subcuenta hereda el de su padre. */
  type?: AccountType;
  parentId?: string | null;
  isPostable?: boolean;
  systemRole?: SystemRole | null;
}

export class CreateAccountUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  async execute(input: CreateAccountInput): Promise<Account> {
    const uow = await this.uow.begin();
    try {
      let parent: Account | null = null;
      if (input.parentId) {
        parent = await uow.accounts.findById(input.organizationId, input.parentId);
        if (!parent) throw new AccountParentInvalidError('La cuenta padre no existe.');
        if (parent.status !== 'active') throw new AccountParentInvalidError('La cuenta padre está inactiva.');
      }
      const type = parent?.type ?? input.type;
      if (!type) throw new ValidationError([{ field: 'type', message: 'Una cuenta raíz necesita su tipo.' }]);

      if (await uow.accounts.findByCode(input.organizationId, input.code.trim())) throw new AccountCodeExistsError();

      if (input.systemRole) {
        const taken = (await uow.accounts.list(input.organizationId)).some((a) => a.systemRole === input.systemRole);
        if (taken) throw new ValidationError([{ field: 'systemRole', message: 'Otra cuenta ya tiene ese rol de sistema.' }]);
      }

      // Colgarle una subcuenta a una de detalle la convierte en agrupación: no puede tener movimientos propios.
      if (parent?.isPostable) {
        if (await uow.accounts.hasMovements(input.organizationId, parent.id)) {
          throw new AccountParentInvalidError('La cuenta padre ya tiene movimientos: no puede tener subcuentas.');
        }
        parent.becomeGroup();
        await uow.accounts.save(parent);
      }

      const account = Account.create({
        organizationId: input.organizationId,
        code: input.code,
        name: input.name,
        type,
        parent,
        isPostable: input.isPostable,
        systemRole: input.systemRole ?? null,
      });
      await uow.accounts.save(account);
      await uow.outbox.add(accountCreatedEvent(account));

      await uow.commit();
      return account;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}

export class UpdateAccountUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  /**
   * `systemRole` mueve el rol de sistema (la cuenta que usan las reglas automáticas) a esta cuenta; si otra lo tenía, la deja sin
   * rol en la misma transacción (un rol, una cuenta). `null` lo quita. `undefined` no lo toca.
   */
  async execute(input: { organizationId: string; accountId: string; name?: string; status?: EntityStatus; systemRole?: SystemRole | null }): Promise<Account> {
    const uow = await this.uow.begin();
    try {
      const account = await uow.accounts.findById(input.organizationId, input.accountId);
      if (!account) throw new AccountNotFoundError();
      const previous = { name: account.name, status: account.status, systemRole: account.systemRole };

      if (input.name !== undefined) account.rename(input.name);
      if (input.status !== undefined && input.status !== account.status) {
        if (input.status === 'inactive' && (await uow.accounts.countActiveChildren(input.organizationId, account.id)) > 0) {
          throw new AccountInUseError();
        }
        account.setStatus(input.status);
      }
      if (input.systemRole !== undefined && input.systemRole !== account.systemRole) {
        if (input.systemRole !== null) {
          const holder = (await uow.accounts.list(input.organizationId)).find((a) => a.systemRole === input.systemRole && a.id !== account.id);
          if (holder) {
            const holderPrevious = { name: holder.name, status: holder.status, systemRole: holder.systemRole };
            holder.assignRole(null);
            await uow.accounts.save(holder);
            await uow.outbox.add(accountUpdatedEvent(holder, holderPrevious));
          }
        }
        account.assignRole(input.systemRole);
      }
      await uow.accounts.save(account);
      await uow.outbox.add(accountUpdatedEvent(account, previous));

      await uow.commit();
      return account;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}

// ── Centros de costo ────────────────────────────────────────────────────────

export class ListCostCentersUseCase {
  constructor(private readonly repos: { costCenters: Pick<CostCenterRepository, 'list'> }) {}

  async execute(organizationId: string, status?: EntityStatus): Promise<CostCenter[]> {
    return this.repos.costCenters.list(organizationId, status);
  }
}

export class CreateCostCenterUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  async execute(input: { organizationId: string; code: string; name: string }): Promise<CostCenter> {
    const uow = await this.uow.begin();
    try {
      const cc = CostCenter.create(input);
      if (await uow.costCenters.findByCode(input.organizationId, cc.code)) throw new CostCenterCodeExistsError();
      await uow.costCenters.save(cc);
      await uow.outbox.add(costCenterUpsertedEvent(cc));
      await uow.commit();
      return cc;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}

export class UpdateCostCenterUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  async execute(input: { organizationId: string; id: string; name?: string; status?: EntityStatus }): Promise<CostCenter> {
    const uow = await this.uow.begin();
    try {
      const cc = await uow.costCenters.findById(input.organizationId, input.id);
      if (!cc) throw new CostCenterNotFoundError();
      cc.update({ name: input.name, status: input.status });
      await uow.costCenters.save(cc);
      await uow.outbox.add(costCenterUpsertedEvent(cc));
      await uow.commit();
      return cc;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}
