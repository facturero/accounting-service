import { randomUUID } from 'node:crypto';
import { type ErrorDetail, ValidationError } from './errors.js';

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'cost' | 'expense';
export const ACCOUNT_TYPES: readonly AccountType[] = ['asset', 'liability', 'equity', 'income', 'cost', 'expense'];
export type EntityStatus = 'active' | 'inactive';

/** Lado en el que una cuenta de este tipo aumenta. */
export type NormalSide = 'debit' | 'credit';

export function normalSide(type: AccountType): NormalSide {
  return type === 'asset' || type === 'cost' || type === 'expense' ? 'debit' : 'credit';
}

/** Las cuentas de resultados (ingresos, costos, gastos) arrancan en cero cada ejercicio; las de balance arrastran su saldo. */
/** Costos y gastos conviven bajo la misma raíz del plan (5 Costos y gastos); el resto de tipos no se mezcla dentro de una rama. */
export function sameBranchType(a: AccountType, b: AccountType): boolean {
  return a === b || ((a === 'cost' || a === 'expense') && (b === 'cost' || b === 'expense'));
}

export function isResultType(type: AccountType): boolean {
  return type === 'income' || type === 'cost' || type === 'expense';
}

/**
 * Códigos con puntos: `1`, `1.1`, `1.1.01`, `1.1.01.01`. Un hijo SIEMPRE empieza por el código de su padre más un punto: así la
 * jerarquía se lee en el código y no puede contradecir a `parent_id`.
 */
const CODE_RE = /^[0-9]+(\.[0-9]+)*$/;

/** Roles de sistema: marcan la cuenta que las reglas automáticas (Fase 1.2) usan por defecto. Una cuenta por rol y organización. */
export const SYSTEM_ROLES = [
  'cash', 'bank', 'receivables', 'inventory', 'supplier_advances', 'vat_credit', 'vat_withheld_receivable',
  'income_tax_withheld_receivable', 'payables', 'customer_advances', 'vat_payable', 'vat_withholding_payable',
  'income_tax_withholding_payable', 'retained_earnings', 'current_result', 'sales_revenue', 'services_revenue',
  'sales_returns', 'other_income', 'inventory_gain', 'cogs', 'inventory_shrinkage', 'other_expense',
] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

export interface AccountProps {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  /** Nivel en el árbol: 1 para las raíces. */
  level: number;
  /** Solo las cuentas de detalle reciben movimientos; las de agrupación suman a sus hijas. */
  isPostable: boolean;
  status: EntityStatus;
  systemRole: SystemRole | null;
  createdAt: Date;
  updatedAt: Date;
}

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export class Account {
  private constructor(private props: AccountProps) {}

  static create(params: {
    id?: string;
    organizationId: string;
    code: string;
    name: string;
    type: AccountType;
    parent: Account | null;
    isPostable?: boolean;
    systemRole?: SystemRole | null;
  }): Account {
    const now = new Date();
    const account = new Account({
      id: params.id ?? randomUUID(),
      organizationId: params.organizationId,
      code: params.code.trim(),
      name: cleanName(params.name),
      type: params.type,
      parentId: params.parent?.id ?? null,
      level: params.parent ? params.parent.level + 1 : 1,
      isPostable: params.isPostable ?? true,
      status: 'active',
      systemRole: params.systemRole ?? null,
      createdAt: now,
      updatedAt: now,
    });
    account.validate(params.parent);
    return account;
  }

  static fromPersistence(props: AccountProps): Account {
    return new Account({ ...props });
  }

  get id(): string { return this.props.id; }
  get organizationId(): string { return this.props.organizationId; }
  get code(): string { return this.props.code; }
  get name(): string { return this.props.name; }
  get type(): AccountType { return this.props.type; }
  get parentId(): string | null { return this.props.parentId; }
  get level(): number { return this.props.level; }
  get isPostable(): boolean { return this.props.isPostable; }
  get status(): EntityStatus { return this.props.status; }
  get systemRole(): SystemRole | null { return this.props.systemRole; }
  get createdAt(): Date { return this.props.createdAt; }
  get updatedAt(): Date { return this.props.updatedAt; }

  canReceiveMovements(): boolean {
    return this.props.isPostable && this.props.status === 'active';
  }

  rename(name: string): void {
    this.props.name = cleanName(name);
    if (this.props.name.length < 1 || this.props.name.length > 150) {
      throw new ValidationError([{ field: 'name', message: 'El nombre debe tener entre 1 y 150 caracteres.' }]);
    }
    this.props.updatedAt = new Date();
  }

  setStatus(status: EntityStatus): void {
    this.props.status = status;
    this.props.updatedAt = new Date();
  }

  /** Cambia el rol de sistema (la cuenta que usan las reglas automáticas). Solo una cuenta de detalle puede llevarlo. */
  assignRole(role: SystemRole | null): void {
    if (role !== null && !(SYSTEM_ROLES as readonly string[]).includes(role)) {
      throw new ValidationError([{ field: 'systemRole', message: 'El rol de sistema no es válido.' }]);
    }
    if (role !== null && !this.props.isPostable) {
      throw new ValidationError([{ field: 'systemRole', message: 'Un rol de sistema solo puede ir en una cuenta de detalle.' }]);
    }
    this.props.systemRole = role;
    this.props.updatedAt = new Date();
  }

  /** Al colgarle una subcuenta deja de ser de detalle. El caso de uso comprueba antes que no tenga movimientos. */
  becomeGroup(): void {
    this.props.isPostable = false;
    this.props.systemRole = null;
    this.props.updatedAt = new Date();
  }

  toPersistence(): AccountProps {
    return { ...this.props };
  }

  private validate(parent: Account | null): void {
    const details: ErrorDetail[] = [];
    if (!CODE_RE.test(this.props.code) || this.props.code.length > 30) {
      details.push({ field: 'code', message: 'El código solo lleva números separados por puntos (p. ej. 1.1.01.01).' });
    }
    if (this.props.name.length < 1 || this.props.name.length > 150) {
      details.push({ field: 'name', message: 'El nombre debe tener entre 1 y 150 caracteres.' });
    }
    if (!ACCOUNT_TYPES.includes(this.props.type)) {
      details.push({ field: 'type', message: 'El tipo de cuenta no es válido.' });
    }
    if (parent) {
      if (!this.props.code.startsWith(`${parent.code}.`)) {
        details.push({ field: 'code', message: `El código debe empezar por el de la cuenta padre (${parent.code}.).` });
      }
      if (!sameBranchType(parent.type, this.props.type)) {
        details.push({ field: 'type', message: 'La cuenta debe ser del mismo tipo que su cuenta padre.' });
      }
    } else if (this.props.code.includes('.')) {
      details.push({ field: 'code', message: 'Una cuenta raíz no lleva puntos en el código.' });
    }
    if (this.props.systemRole && !(SYSTEM_ROLES as readonly string[]).includes(this.props.systemRole)) {
      details.push({ field: 'systemRole', message: 'El rol de sistema no es válido.' });
    }
    if (this.props.systemRole && !this.props.isPostable) {
      details.push({ field: 'systemRole', message: 'Un rol de sistema solo puede ir en una cuenta de detalle.' });
    }
    if (details.length > 0) throw new ValidationError(details);
  }
}

export interface CostCenterProps {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  status: EntityStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Dimensión analítica: permite ver el mayor y el balance por departamento, sucursal o línea de negocio. */
export class CostCenter {
  private constructor(private props: CostCenterProps) {}

  static create(params: { id?: string; organizationId: string; code: string; name: string }): CostCenter {
    const now = new Date();
    const cc = new CostCenter({
      id: params.id ?? randomUUID(),
      organizationId: params.organizationId,
      code: params.code.trim().toUpperCase(),
      name: cleanName(params.name),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    cc.validate();
    return cc;
  }

  static fromPersistence(props: CostCenterProps): CostCenter {
    return new CostCenter({ ...props });
  }

  get id(): string { return this.props.id; }
  get organizationId(): string { return this.props.organizationId; }
  get code(): string { return this.props.code; }
  get name(): string { return this.props.name; }
  get status(): EntityStatus { return this.props.status; }
  get createdAt(): Date { return this.props.createdAt; }
  get updatedAt(): Date { return this.props.updatedAt; }

  update(params: { name?: string; status?: EntityStatus }): void {
    if (params.name !== undefined) this.props.name = cleanName(params.name);
    if (params.status !== undefined) this.props.status = params.status;
    this.validate();
    this.props.updatedAt = new Date();
  }

  toPersistence(): CostCenterProps {
    return { ...this.props };
  }

  private validate(): void {
    const details: ErrorDetail[] = [];
    if (!/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(this.props.code)) {
      details.push({ field: 'code', message: 'El código admite letras, números, punto, guion y guion bajo (máx. 20).' });
    }
    if (this.props.name.length < 1 || this.props.name.length > 100) {
      details.push({ field: 'name', message: 'El nombre debe tener entre 1 y 100 caracteres.' });
    }
    if (details.length > 0) throw new ValidationError(details);
  }
}
