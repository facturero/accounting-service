export interface ErrorDetail {
  field: string;
  message: string;
}

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly details?: ErrorDetail[];

  constructor(message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR';
  readonly httpStatus = 422;
  constructor(details: ErrorDetail[], message = 'La petición no es válida.') {
    super(message, details);
  }
}

export class OrganizationContextRequiredError extends AppError {
  readonly code = 'ORG_CONTEXT_REQUIRED';
  readonly httpStatus = 401;
  constructor(message = 'Falta el contexto de organización.') { super(message); }
}

export class UserContextRequiredError extends AppError {
  readonly code = 'USER_CONTEXT_REQUIRED';
  readonly httpStatus = 401;
  constructor(message = 'Falta el contexto de usuario.') { super(message); }
}

export class ForbiddenError extends AppError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;
  constructor(message = 'Permiso insuficiente.') { super(message); }
}

// ── Configuración inicial ───────────────────────────────────────────────────

export class AlreadySetUpError extends AppError {
  readonly code = 'ACCOUNTING_ALREADY_SET_UP';
  readonly httpStatus = 409;
  constructor(message = 'La contabilidad de esta organización ya está configurada.') { super(message); }
}

export class NotSetUpError extends AppError {
  readonly code = 'ACCOUNTING_NOT_SET_UP';
  readonly httpStatus = 409;
  constructor(message = 'Configura primero la contabilidad (plan de cuentas y ejercicio fiscal).') { super(message); }
}

// ── Plan de cuentas ─────────────────────────────────────────────────────────

export class AccountNotFoundError extends AppError {
  readonly code = 'ACCOUNT_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Cuenta no encontrada.') { super(message); }
}

export class AccountCodeExistsError extends AppError {
  readonly code = 'ACCOUNT_CODE_EXISTS';
  readonly httpStatus = 409;
  constructor(message = 'Ya existe una cuenta con ese código.') { super(message); }
}

export class AccountParentInvalidError extends AppError {
  readonly code = 'ACCOUNT_PARENT_INVALID';
  readonly httpStatus = 422;
  constructor(message = 'La cuenta padre no es válida.') { super(message); }
}

export class AccountHasMovementsError extends AppError {
  readonly code = 'ACCOUNT_HAS_MOVEMENTS';
  readonly httpStatus = 409;
  constructor(message = 'La cuenta ya tiene movimientos: no se puede convertir en cuenta de agrupación.') { super(message); }
}

export class AccountNotPostableError extends AppError {
  readonly code = 'ACCOUNT_NOT_POSTABLE';
  readonly httpStatus = 422;
  constructor(message = 'Solo se puede contabilizar en cuentas de detalle y activas.') { super(message); }
}

export class AccountInUseError extends AppError {
  readonly code = 'ACCOUNT_IN_USE';
  readonly httpStatus = 409;
  constructor(message = 'La cuenta tiene subcuentas activas: desactívalas primero.') { super(message); }
}

// ── Centros de costo ────────────────────────────────────────────────────────

export class CostCenterNotFoundError extends AppError {
  readonly code = 'COST_CENTER_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Centro de costo no encontrado.') { super(message); }
}

export class CostCenterCodeExistsError extends AppError {
  readonly code = 'COST_CENTER_CODE_EXISTS';
  readonly httpStatus = 409;
  constructor(message = 'Ya existe un centro de costo con ese código.') { super(message); }
}

// ── Periodos ────────────────────────────────────────────────────────────────

export class FiscalYearExistsError extends AppError {
  readonly code = 'FISCAL_YEAR_EXISTS';
  readonly httpStatus = 409;
  constructor(message = 'Ese ejercicio fiscal ya existe.') { super(message); }
}

export class PeriodNotFoundError extends AppError {
  readonly code = 'PERIOD_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'No hay un periodo contable para esa fecha. Crea primero el ejercicio fiscal.') { super(message); }
}

export class PeriodClosedError extends AppError {
  readonly code = 'PERIOD_CLOSED';
  readonly httpStatus = 409;
  constructor(message = 'El periodo contable está cerrado.') { super(message); }
}

export class PeriodHasDraftsError extends AppError {
  readonly code = 'PERIOD_HAS_DRAFTS';
  readonly httpStatus = 409;
  constructor(message = 'El periodo tiene asientos en borrador: contabilízalos o elimínalos antes de cerrarlo.') { super(message); }
}

export class PeriodAlreadyInStateError extends AppError {
  readonly code = 'PERIOD_ALREADY_IN_STATE';
  readonly httpStatus = 409;
  constructor(message = 'El periodo ya está en ese estado.') { super(message); }
}

export class PreviousPeriodOpenError extends AppError {
  readonly code = 'PREVIOUS_PERIOD_OPEN';
  readonly httpStatus = 409;
  constructor(message = 'Hay un periodo anterior abierto: ciérralo primero.') { super(message); }
}

export class NextPeriodClosedError extends AppError {
  readonly code = 'NEXT_PERIOD_CLOSED';
  readonly httpStatus = 409;
  constructor(message = 'Hay un periodo posterior cerrado: reábrelo primero.') { super(message); }
}

// ── Asientos ────────────────────────────────────────────────────────────────

export class JournalEntryNotFoundError extends AppError {
  readonly code = 'JOURNAL_ENTRY_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Asiento no encontrado.') { super(message); }
}

export class JournalEntryNotDraftError extends AppError {
  readonly code = 'JOURNAL_ENTRY_NOT_DRAFT';
  readonly httpStatus = 409;
  constructor(message = 'Solo se puede modificar o eliminar un asiento en borrador. Uno contabilizado se corrige con un asiento de reversa.') { super(message); }
}

export class JournalEntryNotPostedError extends AppError {
  readonly code = 'JOURNAL_ENTRY_NOT_POSTED';
  readonly httpStatus = 409;
  constructor(message = 'El asiento no está contabilizado.') { super(message); }
}

export class JournalEntryAlreadyReversedError extends AppError {
  readonly code = 'JOURNAL_ENTRY_ALREADY_REVERSED';
  readonly httpStatus = 409;
  constructor(message = 'El asiento ya fue reversado.') { super(message); }
}

export class JournalEntryNotReversibleError extends AppError {
  readonly code = 'JOURNAL_ENTRY_NOT_REVERSIBLE';
  readonly httpStatus = 409;
  constructor(message = 'Un asiento de reversa no se puede reversar: crea un asiento nuevo.') { super(message); }
}

export class UnbalancedEntryError extends AppError {
  readonly code = 'JOURNAL_ENTRY_UNBALANCED';
  readonly httpStatus = 422;
  constructor(debit: number, credit: number) {
    super('El asiento no cuadra: el debe y el haber deben ser iguales.', [
      { field: 'lines', message: `Debe ${debit} ≠ Haber ${credit} (centavos).` },
    ]);
  }
}

export class DuplicateSourceError extends AppError {
  readonly code = 'JOURNAL_SOURCE_ALREADY_POSTED';
  readonly httpStatus = 409;
  constructor(message = 'Ese documento de origen ya tiene un asiento.') { super(message); }
}
