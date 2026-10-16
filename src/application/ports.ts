import type { UnitOfWork } from '../domain/repositories.js';

/** UnitOfWork que además sabe cerrar su transacción. Los casos de uso de escritura lo obtienen del gateway y hacen commit explícito. */
export interface WriteUnitOfWork extends UnitOfWork {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** Abre unidades de trabajo de escritura. La implementación real abre una transacción de Sequelize; en tests, repos en memoria. */
export interface UnitOfWorkGateway {
  begin(): Promise<WriteUnitOfWork>;
}

export type Clock = () => Date;
