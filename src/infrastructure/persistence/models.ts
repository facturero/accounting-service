import { DataTypes, type InferAttributes, type InferCreationAttributes, Model } from 'sequelize';
import { sequelize } from './sequelize.js';

// BIGINT y DECIMAL llegan como texto desde mysql2: los mappers de repositories.ts los convierten con Number().

export class SettingsModel extends Model<InferAttributes<SettingsModel>, InferCreationAttributes<SettingsModel>> {
  declare organization_id: string;
  declare chart_template: string;
  declare base_currency: string;
  declare fiscal_year_start_month: number;
  declare initialized_by: string;
  declare initialized_at: Date;
  declare timezone: string;
  declare auto_posting: boolean;
  declare auto_posting_from: string | null;
  declare payment_method_roles: Record<string, string> | null;
}

SettingsModel.init(
  {
    organization_id: { type: DataTypes.CHAR(36), primaryKey: true },
    chart_template: { type: DataTypes.STRING(40), allowNull: false },
    base_currency: { type: DataTypes.CHAR(3), allowNull: false },
    fiscal_year_start_month: { type: DataTypes.TINYINT, allowNull: false },
    initialized_by: { type: DataTypes.CHAR(36), allowNull: false },
    initialized_at: { type: DataTypes.DATE, allowNull: false },
    timezone: { type: DataTypes.STRING(64), allowNull: false },
    auto_posting: { type: DataTypes.BOOLEAN, allowNull: false },
    auto_posting_from: { type: DataTypes.DATEONLY, allowNull: true },
    payment_method_roles: { type: DataTypes.JSON, allowNull: true },
  },
  { sequelize, tableName: 'accounting_settings', timestamps: false },
);

export class AccountModel extends Model<InferAttributes<AccountModel>, InferCreationAttributes<AccountModel>> {
  declare id: string;
  declare organization_id: string;
  declare code: string;
  declare name: string;
  declare type: 'asset' | 'liability' | 'equity' | 'income' | 'cost' | 'expense';
  declare parent_id: string | null;
  declare level: number;
  declare is_postable: boolean;
  declare status: 'active' | 'inactive';
  declare system_role: string | null;
  declare created_at: Date;
  declare updated_at: Date;
}

AccountModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    code: { type: DataTypes.STRING(30), allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    type: { type: DataTypes.ENUM('asset', 'liability', 'equity', 'income', 'cost', 'expense'), allowNull: false },
    parent_id: { type: DataTypes.CHAR(36), allowNull: true },
    level: { type: DataTypes.INTEGER, allowNull: false },
    is_postable: { type: DataTypes.BOOLEAN, allowNull: false },
    status: { type: DataTypes.ENUM('active', 'inactive'), allowNull: false },
    system_role: { type: DataTypes.STRING(40), allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  { sequelize, tableName: 'accounts', timestamps: false },
);

export class CostCenterModel extends Model<InferAttributes<CostCenterModel>, InferCreationAttributes<CostCenterModel>> {
  declare id: string;
  declare organization_id: string;
  declare code: string;
  declare name: string;
  declare status: 'active' | 'inactive';
  declare created_at: Date;
  declare updated_at: Date;
}

CostCenterModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    code: { type: DataTypes.STRING(20), allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false },
    status: { type: DataTypes.ENUM('active', 'inactive'), allowNull: false },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  { sequelize, tableName: 'cost_centers', timestamps: false },
);

export class FiscalYearModel extends Model<InferAttributes<FiscalYearModel>, InferCreationAttributes<FiscalYearModel>> {
  declare id: string;
  declare organization_id: string;
  declare year: number;
  declare start_date: string;
  declare end_date: string;
  declare created_at: Date;
}

FiscalYearModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    year: { type: DataTypes.INTEGER, allowNull: false },
    start_date: { type: DataTypes.DATEONLY, allowNull: false },
    end_date: { type: DataTypes.DATEONLY, allowNull: false },
    created_at: DataTypes.DATE,
  },
  { sequelize, tableName: 'fiscal_years', timestamps: false },
);

export class FiscalPeriodModel extends Model<InferAttributes<FiscalPeriodModel>, InferCreationAttributes<FiscalPeriodModel>> {
  declare id: string;
  declare organization_id: string;
  declare fiscal_year_id: string;
  declare number: number;
  declare start_date: string;
  declare end_date: string;
  declare status: 'open' | 'closed';
  declare closed_at: Date | null;
  declare closed_by: string | null;
  declare created_at: Date;
  declare updated_at: Date;
}

FiscalPeriodModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    fiscal_year_id: { type: DataTypes.CHAR(36), allowNull: false },
    number: { type: DataTypes.TINYINT, allowNull: false },
    start_date: { type: DataTypes.DATEONLY, allowNull: false },
    end_date: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.ENUM('open', 'closed'), allowNull: false },
    closed_at: { type: DataTypes.DATE, allowNull: true },
    closed_by: { type: DataTypes.CHAR(36), allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  { sequelize, tableName: 'fiscal_periods', timestamps: false },
);

export class JournalEntryModel extends Model<InferAttributes<JournalEntryModel>, InferCreationAttributes<JournalEntryModel>> {
  declare id: string;
  declare organization_id: string;
  declare number: number | null;
  declare fiscal_year: number | null;
  declare entry_date: string;
  declare period_id: string | null;
  declare description: string;
  declare reference: string | null;
  declare status: 'draft' | 'posted';
  declare kind: 'manual' | 'automatic' | 'reversal' | 'opening';
  declare source_type: string | null;
  declare source_id: string | null;
  declare currency_code: string;
  declare total_debit_cents: string | number;
  declare total_credit_cents: string | number;
  declare reverses_entry_id: string | null;
  declare reversed_by_entry_id: string | null;
  declare reversal_reason: string | null;
  declare created_by: string;
  declare posted_by: string | null;
  declare posted_at: Date | null;
  declare created_at: Date;
  declare updated_at: Date;
}

JournalEntryModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    number: { type: DataTypes.INTEGER, allowNull: true },
    fiscal_year: { type: DataTypes.INTEGER, allowNull: true },
    entry_date: { type: DataTypes.DATEONLY, allowNull: false },
    period_id: { type: DataTypes.CHAR(36), allowNull: true },
    description: { type: DataTypes.STRING(255), allowNull: false },
    reference: { type: DataTypes.STRING(60), allowNull: true },
    status: { type: DataTypes.ENUM('draft', 'posted'), allowNull: false },
    kind: { type: DataTypes.ENUM('manual', 'automatic', 'reversal', 'opening'), allowNull: false },
    source_type: { type: DataTypes.STRING(50), allowNull: true },
    source_id: { type: DataTypes.STRING(64), allowNull: true },
    currency_code: { type: DataTypes.CHAR(3), allowNull: false },
    total_debit_cents: { type: DataTypes.BIGINT, allowNull: false },
    total_credit_cents: { type: DataTypes.BIGINT, allowNull: false },
    reverses_entry_id: { type: DataTypes.CHAR(36), allowNull: true },
    reversed_by_entry_id: { type: DataTypes.CHAR(36), allowNull: true },
    reversal_reason: { type: DataTypes.STRING(255), allowNull: true },
    created_by: { type: DataTypes.CHAR(36), allowNull: false },
    posted_by: { type: DataTypes.CHAR(36), allowNull: true },
    posted_at: { type: DataTypes.DATE, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  { sequelize, tableName: 'journal_entries', timestamps: false },
);

export class JournalLineModel extends Model<InferAttributes<JournalLineModel>, InferCreationAttributes<JournalLineModel>> {
  declare id: string;
  declare entry_id: string;
  declare organization_id: string;
  declare line_no: number;
  declare account_id: string;
  declare debit_cents: string | number;
  declare credit_cents: string | number;
  declare description: string | null;
  declare cost_center_id: string | null;
  declare project_id: string | null;
  declare establishment_id: string | null;
  declare party_type: 'customer' | 'supplier' | 'employee' | null;
  declare party_id: string | null;
  declare currency_code: string | null;
  declare amount_fc_cents: string | number | null;
  declare exchange_rate: string | number | null;
  declare entry_date: string;
  declare is_posted: boolean;
}

JournalLineModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    entry_id: { type: DataTypes.CHAR(36), allowNull: false },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    line_no: { type: DataTypes.INTEGER, allowNull: false },
    account_id: { type: DataTypes.CHAR(36), allowNull: false },
    debit_cents: { type: DataTypes.BIGINT, allowNull: false },
    credit_cents: { type: DataTypes.BIGINT, allowNull: false },
    description: { type: DataTypes.STRING(255), allowNull: true },
    cost_center_id: { type: DataTypes.CHAR(36), allowNull: true },
    project_id: { type: DataTypes.CHAR(36), allowNull: true },
    establishment_id: { type: DataTypes.CHAR(36), allowNull: true },
    party_type: { type: DataTypes.ENUM('customer', 'supplier', 'employee'), allowNull: true },
    party_id: { type: DataTypes.CHAR(36), allowNull: true },
    currency_code: { type: DataTypes.CHAR(3), allowNull: true },
    amount_fc_cents: { type: DataTypes.BIGINT, allowNull: true },
    exchange_rate: { type: DataTypes.DECIMAL(18, 8), allowNull: true },
    entry_date: { type: DataTypes.DATEONLY, allowNull: false },
    is_posted: { type: DataTypes.BOOLEAN, allowNull: false },
  },
  { sequelize, tableName: 'journal_lines', timestamps: false },
);

export class OutboxModel extends Model<InferAttributes<OutboxModel>, InferCreationAttributes<OutboxModel>> {
  declare id: string;
  declare aggregate_type: string;
  declare aggregate_id: string;
  declare type: string;
  declare payload: unknown;
  declare occurred_at: Date;
  declare processed_at: Date | null;
}

OutboxModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    aggregate_type: { type: DataTypes.STRING(50), allowNull: false },
    aggregate_id: { type: DataTypes.CHAR(36), allowNull: false },
    type: { type: DataTypes.STRING(100), allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false },
    occurred_at: { type: DataTypes.DATE, allowNull: false },
    processed_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'outbox_messages', timestamps: false },
);

export class PendingPostingModel extends Model<InferAttributes<PendingPostingModel>, InferCreationAttributes<PendingPostingModel>> {
  declare id: string;
  declare organization_id: string;
  declare event_type: string;
  declare source_type: string;
  declare source_id: string;
  declare payload: Record<string, unknown>;
  declare reason_code: string;
  declare reason_message: string;
  declare status: 'pending' | 'posted' | 'discarded';
  declare attempts: number;
  declare entry_id: string | null;
  declare entry_date: string | null;
  declare created_at: Date;
  declare updated_at: Date;
  declare resolved_at: Date | null;
}

PendingPostingModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    event_type: { type: DataTypes.STRING(100), allowNull: false },
    source_type: { type: DataTypes.STRING(50), allowNull: false },
    source_id: { type: DataTypes.STRING(64), allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false },
    reason_code: { type: DataTypes.STRING(60), allowNull: false },
    reason_message: { type: DataTypes.STRING(255), allowNull: false },
    status: { type: DataTypes.ENUM('pending', 'posted', 'discarded'), allowNull: false },
    attempts: { type: DataTypes.INTEGER, allowNull: false },
    entry_id: { type: DataTypes.CHAR(36), allowNull: true },
    entry_date: { type: DataTypes.DATEONLY, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    resolved_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'pending_postings', timestamps: false },
);
