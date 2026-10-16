import './infrastructure/telemetry/otel.js';
import { serve } from '@hono/node-server';
import { OutboxRelay } from '@facturero/outbox-relay';
import { config } from './infrastructure/config.js';
import { sequelize } from './infrastructure/persistence/sequelize.js';
import './infrastructure/persistence/models.js';
import { readOnlyRepositories, SequelizeUnitOfWorkFactory } from './infrastructure/persistence/repositories.js';
import { GetSettingsUseCase, SetupAccountingUseCase } from './application/use-cases/setup.js';
import {
  CreateAccountUseCase,
  CreateCostCenterUseCase,
  GetAccountUseCase,
  ListAccountsUseCase,
  ListCostCentersUseCase,
  UpdateAccountUseCase,
  UpdateCostCenterUseCase,
} from './application/use-cases/account-use-cases.js';
import {
  ClosePeriodUseCase,
  CreateFiscalYearUseCase,
  ListFiscalYearsUseCase,
  ReopenPeriodUseCase,
} from './application/use-cases/period-use-cases.js';
import {
  CreateJournalEntryUseCase,
  DeleteJournalEntryUseCase,
  GetJournalEntryUseCase,
  ListJournalEntriesUseCase,
  PostJournalEntryUseCase,
  ReverseJournalEntryUseCase,
  UpdateJournalEntryUseCase,
} from './application/use-cases/journal-use-cases.js';
import { BalanceSheetUseCase, IncomeStatementUseCase, LedgerUseCase, TrialBalanceUseCase } from './application/use-cases/report-use-cases.js';
import { AutomaticPostingUseCase, DiscardPendingPostingUseCase, ListPendingPostingsUseCase } from './application/use-cases/automatic-posting.js';
import {
  GetPostingSettingsUseCase,
  SetAutoPostingByPluginUseCase,
  UpdatePostingSettingsUseCase,
} from './application/use-cases/posting-settings-use-cases.js';
import { buildEventHandlers, startEventConsumers } from './infrastructure/messaging/consumer.js';
import { createApp } from './interface/http/app.js';

async function main(): Promise<void> {
  // NO se llama a `sequelize.sync()`: la migración (initContainer accounting-migrate) es la fuente de verdad del esquema.
  await sequelize.authenticate();

  let relay: OutboxRelay | undefined;
  const uow = new SequelizeUnitOfWorkFactory((tx) => relay?.attachToTransaction(tx));
  const repos = readOnlyRepositories;
  const clock = () => new Date();
  const posting = new AutomaticPostingUseCase(uow, clock, config.INTERNAL_USER_ID);

  const app = createApp({
    useCases: {
      getSettings: new GetSettingsUseCase(repos),
      setup: new SetupAccountingUseCase(uow, clock),
      listAccounts: new ListAccountsUseCase(repos),
      getAccount: new GetAccountUseCase(repos),
      createAccount: new CreateAccountUseCase(uow),
      updateAccount: new UpdateAccountUseCase(uow),
      listCostCenters: new ListCostCentersUseCase(repos),
      createCostCenter: new CreateCostCenterUseCase(uow),
      updateCostCenter: new UpdateCostCenterUseCase(uow),
      listFiscalYears: new ListFiscalYearsUseCase(repos),
      createFiscalYear: new CreateFiscalYearUseCase(uow),
      closePeriod: new ClosePeriodUseCase(uow, clock),
      reopenPeriod: new ReopenPeriodUseCase(uow, clock),
      listEntries: new ListJournalEntriesUseCase(repos),
      getEntry: new GetJournalEntryUseCase(repos),
      createEntry: new CreateJournalEntryUseCase(uow, clock),
      updateEntry: new UpdateJournalEntryUseCase(uow),
      deleteEntry: new DeleteJournalEntryUseCase(uow),
      postEntry: new PostJournalEntryUseCase(uow, clock),
      reverseEntry: new ReverseJournalEntryUseCase(uow, clock),
      trialBalance: new TrialBalanceUseCase(repos),
      ledger: new LedgerUseCase(repos),
      balanceSheet: new BalanceSheetUseCase(repos),
      incomeStatement: new IncomeStatementUseCase(repos),
      postingSettings: new GetPostingSettingsUseCase(repos),
      updatePostingSettings: new UpdatePostingSettingsUseCase(uow),
      listPending: new ListPendingPostingsUseCase(repos),
      retryPending: posting,
      discardPending: new DiscardPendingPostingUseCase(uow, clock),
    },
    corsOrigin: config.CORS_ORIGIN,
  });

  serve({ fetch: app.fetch, port: config.PORT });
  console.log(`[accounting-service] corriendo en puerto ${config.PORT}`);

  if (config.RABBITMQ_URL) {
    relay = new OutboxRelay({ sequelize, rabbitmqUrl: config.RABBITMQ_URL, exchange: 'crm.events' });
    await relay.start();
    await startEventConsumers({
      sequelize,
      rabbitmqUrl: config.RABBITMQ_URL,
      exchange: 'crm.events',
      queue: 'accounting-service.events',
      handlers: buildEventHandlers({ posting, pluginToggle: new SetAutoPostingByPluginUseCase(uow) }),
    });
    console.log('[accounting-service] outbox relay + consumidor de eventos (contabilización automática) activos');
  } else {
    console.warn('[accounting-service] RABBITMQ_URL no configurado: los eventos NO se publican');
  }
}

main().catch((err) => {
  console.error('[accounting-service] error al iniciar:', err);
  process.exit(1);
});
