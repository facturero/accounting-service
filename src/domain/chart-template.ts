import type { AccountType, SystemRole } from './account.js';

/**
 * Plan de cuentas de partida para Ecuador, con la estructura de la Superintendencia de Compañías (NIIF para PYMES/completas):
 * 1 Activo, 2 Pasivo, 3 Patrimonio, 4 Ingresos y 5 Costos y gastos. Es un PUNTO DE PARTIDA: cada organización lo copia y puede
 * cambiarlo (añadir subcuentas, renombrar, desactivar); la plantilla no se vuelve a leer después del alta.
 *
 * Una cuenta es de detalle (recibe movimientos) si ninguna otra de la plantilla cuelga de ella. Los `role` marcan las cuentas que
 * las reglas automáticas de la Fase 1.2 usan por defecto (cuentas por cobrar, IVA, costo de ventas…).
 */
export interface TemplateAccount {
  code: string;
  name: string;
  type: AccountType;
  role?: SystemRole;
}

const A: AccountType = 'asset';
const L: AccountType = 'liability';
const E: AccountType = 'equity';
const I: AccountType = 'income';
const C: AccountType = 'cost';
const X: AccountType = 'expense';

export const EC_SUPERCIAS_TEMPLATE: readonly TemplateAccount[] = [
  { code: '1', name: 'ACTIVO', type: A },
  { code: '1.1', name: 'Activo corriente', type: A },
  { code: '1.1.01', name: 'Efectivo y equivalentes de efectivo', type: A },
  { code: '1.1.01.01', name: 'Caja', type: A, role: 'cash' },
  { code: '1.1.01.02', name: 'Bancos', type: A, role: 'bank' },
  { code: '1.1.01.03', name: 'Caja chica', type: A },
  { code: '1.1.02', name: 'Activos financieros', type: A },
  { code: '1.1.02.01', name: 'Clientes', type: A, role: 'receivables' },
  { code: '1.1.02.02', name: 'Otras cuentas por cobrar', type: A },
  { code: '1.1.02.03', name: 'Anticipos a empleados', type: A },
  { code: '1.1.02.04', name: '(-) Provisión para cuentas incobrables', type: A },
  { code: '1.1.03', name: 'Inventarios', type: A },
  { code: '1.1.03.01', name: 'Inventario de mercaderías', type: A, role: 'inventory' },
  { code: '1.1.03.02', name: 'Inventario de materia prima', type: A },
  { code: '1.1.03.03', name: 'Inventario de productos en proceso', type: A },
  { code: '1.1.03.04', name: 'Inventario de productos terminados', type: A },
  { code: '1.1.03.05', name: 'Importaciones en tránsito', type: A },
  { code: '1.1.04', name: 'Servicios y otros pagos anticipados', type: A },
  { code: '1.1.04.01', name: 'Seguros pagados por anticipado', type: A },
  { code: '1.1.04.02', name: 'Anticipos a proveedores', type: A, role: 'supplier_advances' },
  { code: '1.1.05', name: 'Activos por impuestos corrientes', type: A },
  { code: '1.1.05.01', name: 'Crédito tributario de IVA', type: A, role: 'vat_credit' },
  { code: '1.1.05.02', name: 'Crédito tributario de impuesto a la renta', type: A },
  { code: '1.1.05.03', name: 'Retenciones de IVA recibidas', type: A, role: 'vat_withheld_receivable' },
  { code: '1.1.05.04', name: 'Retenciones en la fuente de renta recibidas', type: A, role: 'income_tax_withheld_receivable' },
  { code: '1.2', name: 'Activo no corriente', type: A },
  { code: '1.2.01', name: 'Propiedad, planta y equipo', type: A },
  { code: '1.2.01.01', name: 'Terrenos', type: A },
  { code: '1.2.01.02', name: 'Edificios', type: A },
  { code: '1.2.01.03', name: 'Muebles y enseres', type: A },
  { code: '1.2.01.04', name: 'Maquinaria y equipo', type: A },
  { code: '1.2.01.05', name: 'Equipo de computación', type: A },
  { code: '1.2.01.06', name: 'Vehículos', type: A },
  { code: '1.2.01.07', name: '(-) Depreciación acumulada', type: A },
  { code: '1.2.02', name: 'Activos intangibles', type: A },
  { code: '1.2.02.01', name: 'Software y licencias', type: A },
  { code: '1.2.02.02', name: '(-) Amortización acumulada', type: A },

  { code: '2', name: 'PASIVO', type: L },
  { code: '2.1', name: 'Pasivo corriente', type: L },
  { code: '2.1.01', name: 'Cuentas y documentos por pagar', type: L },
  { code: '2.1.01.01', name: 'Proveedores', type: L, role: 'payables' },
  { code: '2.1.01.02', name: 'Documentos por pagar', type: L },
  { code: '2.1.01.03', name: 'Anticipos de clientes', type: L, role: 'customer_advances' },
  { code: '2.1.02', name: 'Obligaciones con instituciones financieras', type: L },
  { code: '2.1.02.01', name: 'Préstamos bancarios a corto plazo', type: L },
  { code: '2.1.03', name: 'Otras obligaciones corrientes', type: L },
  { code: '2.1.03.01', name: 'IVA cobrado en ventas', type: L, role: 'vat_payable' },
  { code: '2.1.03.02', name: 'Retenciones de IVA por pagar', type: L, role: 'vat_withholding_payable' },
  { code: '2.1.03.03', name: 'Retenciones en la fuente de renta por pagar', type: L, role: 'income_tax_withholding_payable' },
  { code: '2.1.03.04', name: 'Impuesto a la renta por pagar', type: L },
  { code: '2.1.03.05', name: 'Obligaciones con el IESS', type: L },
  { code: '2.1.03.06', name: 'Sueldos y beneficios sociales por pagar', type: L },
  { code: '2.1.03.07', name: 'Participación de trabajadores por pagar', type: L },
  { code: '2.2', name: 'Pasivo no corriente', type: L },
  { code: '2.2.01', name: 'Préstamos a largo plazo', type: L },
  { code: '2.2.01.01', name: 'Préstamos bancarios a largo plazo', type: L },
  { code: '2.2.02', name: 'Provisiones por beneficios a empleados', type: L },
  { code: '2.2.02.01', name: 'Jubilación patronal y desahucio', type: L },

  { code: '3', name: 'PATRIMONIO', type: E },
  { code: '3.1', name: 'Capital', type: E },
  { code: '3.1.01', name: 'Capital suscrito o asignado', type: E },
  { code: '3.2', name: 'Aportes para futuras capitalizaciones', type: E },
  { code: '3.2.01', name: 'Aportes de socios o accionistas', type: E },
  { code: '3.3', name: 'Reservas', type: E },
  { code: '3.3.01', name: 'Reserva legal', type: E },
  { code: '3.4', name: 'Resultados acumulados', type: E },
  { code: '3.4.01', name: 'Ganancias acumuladas', type: E, role: 'retained_earnings' },
  { code: '3.4.02', name: '(-) Pérdidas acumuladas', type: E },
  { code: '3.5', name: 'Resultados del ejercicio', type: E },
  { code: '3.5.01', name: 'Ganancia o pérdida neta del periodo', type: E, role: 'current_result' },

  { code: '4', name: 'INGRESOS', type: I },
  { code: '4.1', name: 'Ingresos de actividades ordinarias', type: I },
  { code: '4.1.01', name: 'Venta de bienes', type: I, role: 'sales_revenue' },
  { code: '4.1.02', name: 'Prestación de servicios', type: I, role: 'services_revenue' },
  { code: '4.1.03', name: '(-) Devoluciones y descuentos en ventas', type: I, role: 'sales_returns' },
  { code: '4.2', name: 'Otros ingresos', type: I },
  { code: '4.2.01', name: 'Intereses ganados', type: I },
  { code: '4.2.02', name: 'Ganancia por ajustes de inventario', type: I, role: 'inventory_gain' },
  { code: '4.2.03', name: 'Otros ingresos no operacionales', type: I, role: 'other_income' },

  { code: '5', name: 'COSTOS Y GASTOS', type: C },
  { code: '5.1', name: 'Costo de ventas', type: C },
  { code: '5.1.01', name: 'Costo de ventas de mercaderías', type: C, role: 'cogs' },
  { code: '5.1.02', name: 'Mermas y pérdidas de inventario', type: C, role: 'inventory_shrinkage' },
  { code: '5.2', name: 'Gastos', type: X },
  { code: '5.2.01', name: 'Sueldos, salarios y beneficios', type: X },
  { code: '5.2.02', name: 'Arrendamientos', type: X },
  { code: '5.2.03', name: 'Servicios básicos', type: X },
  { code: '5.2.04', name: 'Honorarios profesionales', type: X },
  { code: '5.2.05', name: 'Publicidad y promoción', type: X },
  { code: '5.2.06', name: 'Depreciaciones y amortizaciones', type: X },
  { code: '5.2.07', name: 'Transporte y movilización', type: X },
  { code: '5.2.08', name: 'Gastos bancarios', type: X },
  { code: '5.2.09', name: 'Intereses y gastos financieros', type: X },
  { code: '5.2.10', name: 'Impuestos, contribuciones y otros', type: X },
  { code: '5.2.99', name: 'Otros gastos', type: X, role: 'other_expense' },
];

export type ChartTemplateCode = 'ec-supercias' | 'empty';

export function chartTemplate(code: ChartTemplateCode): readonly TemplateAccount[] {
  return code === 'ec-supercias' ? EC_SUPERCIAS_TEMPLATE : [];
}
