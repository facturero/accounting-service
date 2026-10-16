import { type Context, type MiddlewareHandler } from 'hono';
import { runWithActor } from '@facturero/outbox-relay';
import {
  AppError,
  ForbiddenError,
  OrganizationContextRequiredError,
  UserContextRequiredError,
} from '../../domain/errors.js';

export type ContextVariables = {
  organizationId: string;
  userId: string;
  countryCode: string;
  permissions: string[];
};

export function contextMiddleware(): MiddlewareHandler<{
  Variables: ContextVariables;
}> {
  return async (c, next) => {
    const orgId = c.req.header('X-Organization-Id');
    const userId = c.req.header('X-User-Id');
    const countryCode = c.req.header('X-Country-Code');
    const perms = c.req.header('X-Permissions');

    if (orgId) c.set('organizationId', orgId);
    if (userId) c.set('userId', userId);
    if (countryCode) c.set('countryCode', countryCode);
    if (perms) c.set('permissions', perms.split(',').map((p) => p.trim()));

    // Quien actúa viaja en un contexto asíncrono hasta el outbox: así CADA
    // evento publicado durante esta petición lleva actor/ip/request-id sin que
    // los casos de uso tengan que arrastrarlos uno a uno.
    await runWithActor(
      {
        actorId: userId ?? null,
        actorEmail: c.req.header('X-User-Email') ?? null,
        actorIp: c.req.header('X-Client-Ip') ?? null,
        requestId: c.req.header('X-Request-Id') ?? null,
      },
      () => next(),
    );
  };
}

export function requireOrganization(): MiddlewareHandler<{
  Variables: ContextVariables;
}> {
  return async (c, next) => {
    const orgId = c.get('organizationId');
    if (!orgId) throw new OrganizationContextRequiredError();
    await next();
  };
}

export function requireUser(): MiddlewareHandler<{
  Variables: ContextVariables;
}> {
  return async (c, next) => {
    const userId = c.get('userId');
    if (!userId) throw new UserContextRequiredError();
    await next();
  };
}

export function requirePermission(perm: string): MiddlewareHandler<{
  Variables: ContextVariables;
}> {
  return async (c, next) => {
    const perms = c.get('permissions') ?? [];
    if (!perms.includes(perm)) throw new ForbiddenError();
    await next();
  };
}

/** Un UNIQUE de MySQL que no se anticipó en el caso de uso (p. ej. dos nombres
 *  que difieren solo en acentos y que la colación considera iguales) no debe
 *  salir como 500: se mapea a 409. */
function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'SequelizeUniqueConstraintError';
}

/** Interbloqueo o espera de bloqueo agotada: dos operaciones tocaron lo mismo a la vez. Es reintentable, no un fallo del servidor. */
function isConcurrencyError(err: unknown): boolean {
  const e = err as { parent?: { code?: string }; original?: { code?: string } } | null;
  const code = e?.parent?.code ?? e?.original?.code;
  return code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT';
}

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    // `@hono/otel` marca como error del span todo lo que llega a `onError`,
    // incluso un 404 o una validación fallida. En el servidor solo los 5xx son
    // error; el 4xx normal de negocio se limpia aquí.
    if (err.httpStatus < 500) c.error = undefined;
    return c.json(
      {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
      err.httpStatus as 400,
    );
  }

  if (isUniqueConstraintError(err)) {
    c.error = undefined;
    return c.json({ code: 'CONFLICT', message: 'Ya existe un registro con esos datos.' }, 409);
  }

  if (isConcurrencyError(err)) {
    c.error = undefined;
    return c.json({ code: 'CONCURRENT_UPDATE', message: 'Otra operación estaba modificando lo mismo. Vuelve a intentarlo.' }, 409);
  }

  console.error('[accounting-service] error no controlado:', err);
  return c.json({ code: 'INTERNAL_ERROR', message: 'Error interno del servidor.' }, 500);
}
