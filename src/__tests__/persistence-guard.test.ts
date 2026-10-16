import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function leerCodigo(ruta: string): string {
  return readFileSync(ruta, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const codigo = leerCodigo(join(process.cwd(), 'src', 'infrastructure', 'persistence', 'repositories.ts'));

function cuerpo(metodo: string): string {
  const inicio = codigo.indexOf(`async ${metodo}(`);
  expect(inicio, `no se encontró ${metodo}`).toBeGreaterThan(-1);
  const fin = codigo.indexOf('\n    async ', inicio + 10);
  return codigo.slice(inicio, fin === -1 ? undefined : fin);
}

/**
 * En MySQL, `INSERT … ON DUPLICATE KEY UPDATE` —lo que Sequelize genera con `upsert`— reacciona a CUALQUIER índice único, no solo a
 * la clave primaria. Una cuenta con el código de otra no daría 409: pisaría en silencio la fila ajena.
 */
describe('los repositorios guardan por clave primaria', () => {
  it('`repositories.ts` no usa `upsert`', () => {
    expect(/.upsert\(/.test(codigo), 'hay un `upsert` en los repositorios').toBe(false);
  });
});

/**
 * Guardia de la contabilización concurrente. Bajo REPEATABLE READ una lectura normal dentro de la transacción ve la «foto» de
 * cuando empezó, no lo que otra transacción confirmó mientras esta esperaba un bloqueo. Por eso las lecturas que DECIDEN —el
 * periodo (abierto o cerrado), el asiento a contabilizar o reversar y el contador— son lecturas con bloqueo.
 */
describe('las lecturas que deciden una contabilización son lecturas con bloqueo', () => {
  it('el periodo se lee con bloqueo compartido al contabilizar y exclusivo al cerrar', () => {
    const lock = codigo.slice(codigo.indexOf('async function lockedPeriod'), codigo.indexOf('return {', codigo.indexOf('async function lockedPeriod')));
    expect(lock).toMatch(/lock:\s*mode === 'share' \? tx\.LOCK\.SHARE : tx\.LOCK\.UPDATE/);
    expect(cuerpo('lockPeriodForDate')).toMatch(/'share'/);
    expect(cuerpo('lockPeriodById')).toMatch(/'update'/);
  });

  it('el asiento y sus líneas se bloquean al contabilizar o reversar', () => {
    expect(cuerpo('lockById')).toMatch(/lock:\s*tx\.LOCK\.UPDATE/);
    expect(codigo).toMatch(/\.\.\.\(lock && tx \? \{ lock: tx\.LOCK\.UPDATE \}/);
  });

  it('la numeración hace el UPDATE del contador ANTES que cualquier INSERT IGNORE', () => {
    // Un INSERT IGNORE sobre una fila que ya existe toma un bloqueo compartido; con dos transacciones a la vez, el UPDATE que sigue
    // se interbloquea. Se vio contra MySQL real: 23 de 30 contabilizaciones simultáneas morían.
    const n = cuerpo('nextNumber');
    expect(n).toMatch(/UPDATE entry_sequences SET last_number = last_number \+ 1/);
    expect(n.indexOf('await bump()')).toBeGreaterThan(-1);
    expect(n.indexOf('await bump()')).toBeLessThan(n.indexOf('INSERT IGNORE'));
  });

  it('el contador del ejercicio nace con el ejercicio', () => {
    const y = cuerpo('saveYear');
    expect(y).toMatch(/INSERT IGNORE INTO entry_sequences/);
  });

  it('el rollback no falla si MySQL ya deshizo la transacción (interbloqueo)', () => {
    expect(codigo).toMatch(/finished/);
  });
});

/**
 * Los importes se restan (debe - haber) en SQL. Con columnas UNSIGNED, un resultado negativo falla en MySQL con «BIGINT UNSIGNED
 * value is out of range»: las migraciones usan BIGINT con signo y un CHECK de no negatividad.
 */
describe('los importes son BIGINT con signo', () => {
  it('la migración no usa UNSIGNED y tiene el CHECK de importes', () => {
    const migracion = readFileSync(join(process.cwd(), 'migrations', '20261015100000-create-accounting-tables.cjs'), 'utf8');
    expect(/unsigned/i.test(migracion.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''))).toBe(false);
    expect(migracion).toMatch(/journal_lines_amount_chk/);
  });
});
