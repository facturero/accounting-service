'use strict';

/**
 * Esquema inicial de accounting-service (Fase 1.1 del plan ERP).
 *
 * - accounting_settings: una fila por organización; existe = la contabilidad está configurada.
 * - accounts: plan de cuentas jerárquico. UNIQUE (organization_id, code) y (organization_id, system_role).
 * - cost_centers: dimensión analítica.
 * - fiscal_years / fiscal_periods: ejercicios y periodos mensuales con estado abierto/cerrado.
 * - journal_entries / journal_lines: asientos de partida doble. Las líneas llevan copia de la fecha y de «contabilizado» para que
 *   los informes recorran un solo índice sin unir con el encabezado.
 * - entry_sequences: contador por ejercicio; se bloquea al contabilizar para numerar sin huecos.
 * - outbox_messages / processed_events: patrón Outbox, esquema de @facturero/outbox-relay 0.2.x.
 *
 * Importes: centavos en BIGINT CON SIGNO (no UNSIGNED): restar dos UNSIGNED que dan negativo falla en MySQL con «BIGINT UNSIGNED
 * value is out of range», y los informes restan debe - haber. La no negatividad la garantiza un CHECK.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('accounting_settings', {
      organization_id: { type: Sequelize.CHAR(36), primaryKey: true },
      chart_template: { type: Sequelize.STRING(40), allowNull: false },
      base_currency: { type: Sequelize.CHAR(3), allowNull: false },
      fiscal_year_start_month: { type: Sequelize.TINYINT, allowNull: false, defaultValue: 1 },
      initialized_by: { type: Sequelize.CHAR(36), allowNull: false },
      initialized_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('accounts', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      code: { type: Sequelize.STRING(30), allowNull: false },
      name: { type: Sequelize.STRING(150), allowNull: false },
      type: { type: Sequelize.ENUM('asset', 'liability', 'equity', 'income', 'cost', 'expense'), allowNull: false },
      parent_id: { type: Sequelize.CHAR(36), allowNull: true },
      level: { type: Sequelize.INTEGER, allowNull: false },
      is_postable: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      status: { type: Sequelize.ENUM('active', 'inactive'), allowNull: false, defaultValue: 'active' },
      system_role: { type: Sequelize.STRING(40), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('accounts', ['organization_id', 'code'], { unique: true, name: 'accounts_org_code_uq' });
    await queryInterface.addIndex('accounts', ['organization_id', 'system_role'], { unique: true, name: 'accounts_org_role_uq' });
    await queryInterface.addIndex('accounts', ['organization_id', 'parent_id']);

    await queryInterface.createTable('cost_centers', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      code: { type: Sequelize.STRING(20), allowNull: false },
      name: { type: Sequelize.STRING(100), allowNull: false },
      status: { type: Sequelize.ENUM('active', 'inactive'), allowNull: false, defaultValue: 'active' },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('cost_centers', ['organization_id', 'code'], { unique: true, name: 'cost_centers_org_code_uq' });

    await queryInterface.createTable('fiscal_years', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      year: { type: Sequelize.INTEGER, allowNull: false },
      start_date: { type: Sequelize.DATEONLY, allowNull: false },
      end_date: { type: Sequelize.DATEONLY, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('fiscal_years', ['organization_id', 'year'], { unique: true, name: 'fiscal_years_org_year_uq' });

    await queryInterface.createTable('fiscal_periods', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      fiscal_year_id: { type: Sequelize.CHAR(36), allowNull: false },
      number: { type: Sequelize.TINYINT, allowNull: false },
      start_date: { type: Sequelize.DATEONLY, allowNull: false },
      end_date: { type: Sequelize.DATEONLY, allowNull: false },
      status: { type: Sequelize.ENUM('open', 'closed'), allowNull: false, defaultValue: 'open' },
      closed_at: { type: Sequelize.DATE, allowNull: true },
      closed_by: { type: Sequelize.CHAR(36), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('fiscal_periods', ['fiscal_year_id', 'number'], { unique: true, name: 'fiscal_periods_year_number_uq' });
    await queryInterface.addIndex('fiscal_periods', ['organization_id', 'start_date', 'end_date']);

    await queryInterface.createTable('journal_entries', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      number: { type: Sequelize.INTEGER, allowNull: true },
      fiscal_year: { type: Sequelize.INTEGER, allowNull: true },
      entry_date: { type: Sequelize.DATEONLY, allowNull: false },
      period_id: { type: Sequelize.CHAR(36), allowNull: true },
      description: { type: Sequelize.STRING(255), allowNull: false },
      reference: { type: Sequelize.STRING(60), allowNull: true },
      status: { type: Sequelize.ENUM('draft', 'posted'), allowNull: false, defaultValue: 'draft' },
      kind: { type: Sequelize.ENUM('manual', 'automatic', 'reversal', 'opening'), allowNull: false, defaultValue: 'manual' },
      source_type: { type: Sequelize.STRING(50), allowNull: true },
      source_id: { type: Sequelize.STRING(64), allowNull: true },
      currency_code: { type: Sequelize.CHAR(3), allowNull: false },
      total_debit_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      total_credit_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      reverses_entry_id: { type: Sequelize.CHAR(36), allowNull: true },
      reversed_by_entry_id: { type: Sequelize.CHAR(36), allowNull: true },
      reversal_reason: { type: Sequelize.STRING(255), allowNull: true },
      created_by: { type: Sequelize.CHAR(36), allowNull: false },
      posted_by: { type: Sequelize.CHAR(36), allowNull: true },
      posted_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    // Numeración sin repetidos por ejercicio (NULL en borradores no choca: MySQL permite varios NULL en un UNIQUE).
    await queryInterface.addIndex('journal_entries', ['organization_id', 'fiscal_year', 'number'], { unique: true, name: 'journal_entries_number_uq' });
    // Un documento de origen genera como mucho un asiento de cada clase: es lo que hace idempotentes las reglas automáticas.
    await queryInterface.addIndex('journal_entries', ['organization_id', 'source_type', 'source_id', 'kind'], { unique: true, name: 'journal_entries_source_uq' });
    // Un asiento se reversa una sola vez, incluso si dos peticiones lo intentan a la vez.
    await queryInterface.addIndex('journal_entries', ['reverses_entry_id'], { unique: true, name: 'journal_entries_reverses_uq' });
    await queryInterface.addIndex('journal_entries', ['organization_id', 'status', 'entry_date']);
    await queryInterface.addIndex('journal_entries', ['organization_id', 'entry_date']);

    await queryInterface.createTable('journal_lines', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      entry_id: { type: Sequelize.CHAR(36), allowNull: false, references: { model: 'journal_entries', key: 'id' }, onDelete: 'CASCADE' },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      line_no: { type: Sequelize.INTEGER, allowNull: false },
      account_id: { type: Sequelize.CHAR(36), allowNull: false },
      debit_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      credit_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      description: { type: Sequelize.STRING(255), allowNull: true },
      cost_center_id: { type: Sequelize.CHAR(36), allowNull: true },
      project_id: { type: Sequelize.CHAR(36), allowNull: true },
      establishment_id: { type: Sequelize.CHAR(36), allowNull: true },
      party_type: { type: Sequelize.ENUM('customer', 'supplier', 'employee'), allowNull: true },
      party_id: { type: Sequelize.CHAR(36), allowNull: true },
      currency_code: { type: Sequelize.CHAR(3), allowNull: true },
      amount_fc_cents: { type: Sequelize.BIGINT, allowNull: true },
      exchange_rate: { type: Sequelize.DECIMAL(18, 8), allowNull: true },
      entry_date: { type: Sequelize.DATEONLY, allowNull: false },
      is_posted: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    });
    await queryInterface.addIndex('journal_lines', ['entry_id', 'line_no'], { unique: true, name: 'journal_lines_entry_line_uq' });
    await queryInterface.addIndex('journal_lines', ['organization_id', 'account_id', 'is_posted', 'entry_date'], { name: 'journal_lines_account_idx' });
    await queryInterface.addIndex('journal_lines', ['organization_id', 'cost_center_id', 'is_posted', 'entry_date'], { name: 'journal_lines_cost_center_idx' });
    await queryInterface.addIndex('journal_lines', ['organization_id', 'party_type', 'party_id', 'is_posted']);
    await queryInterface.sequelize.query(
      'ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_amount_chk CHECK (debit_cents >= 0 AND credit_cents >= 0 AND ((debit_cents = 0) <> (credit_cents = 0)))',
    );

    await queryInterface.createTable('entry_sequences', {
      organization_id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      fiscal_year: { type: Sequelize.INTEGER, allowNull: false, primaryKey: true },
      last_number: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
    });

    await queryInterface.createTable('outbox_messages', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      aggregate_type: { type: Sequelize.STRING(50), allowNull: false },
      aggregate_id: { type: Sequelize.CHAR(36), allowNull: false },
      type: { type: Sequelize.STRING(100), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      processed_at: { type: Sequelize.DATE, allowNull: true },
    });
    await queryInterface.addIndex('outbox_messages', ['processed_at']);

    await queryInterface.createTable('processed_events', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      event_type: { type: Sequelize.STRING(100), allowNull: false },
      routing_key: { type: Sequelize.STRING(200), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'processed' },
      last_error: { type: Sequelize.TEXT, allowNull: true },
      processed_at: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    for (const t of [
      'processed_events', 'outbox_messages', 'entry_sequences', 'journal_lines', 'journal_entries',
      'fiscal_periods', 'fiscal_years', 'cost_centers', 'accounts', 'accounting_settings',
    ]) {
      await queryInterface.dropTable(t);
    }
  },
};
