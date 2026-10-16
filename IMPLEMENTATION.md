# accounting-service — implementación

Contabilidad general (plugin `finance.general_ledger`). **Fase 1.1 del plan ERP** (`PLAN-ERP.md`, en la carpeta contenedora). Puerto 3016, rama `main`, base `accounting_db`. Escrito 2026-10-15.

## Estado

**Construido y verificado en local, sin desplegar.** 142 pruebas (dominio, casos de uso sobre repos en memoria, HTTP, guardias de código) más dos verificaciones contra MySQL y RabbitMQ reales (`scripts/verify-accounting.mjs`, 27 comprobaciones; `scripts/verify-automatic-posting.mjs`, 25; `scripts/verify-statements.mjs`, 10). CRM: 5 pantallas verificadas en el navegador (escritorio y teléfono).

Qué hace: plan de cuentas jerárquico con plantilla de Ecuador, centros de costo, ejercicios y periodos con cierre, asientos de partida doble (borrador → contabilizado → reversa), balance de comprobación y libro mayor.

**Fase 1.3 (estados financieros) también construida; ver la sección «Fase 1.3».** **Fase 1.2 (contabilización automática) también construida en local, sin desplegar** (sección «Fase 1.2» más abajo): las facturas, notas de crédito, anulaciones y movimientos de inventario generan asientos solos. La nota de débito y la retención emitida también generan asiento (Fase 1.4); todavía no hay compras ni cobros (fases 2 y 3).

## Decisiones que importan

1. **Contabilizado = inmutable.** No hay `UPDATE` ni `DELETE` de un asiento contabilizado. Se corrige con una **reversa** (otro asiento con debe y haber cambiados, enlazado con `reverses_entry_id`; el original queda marcado `reversed_by_entry_id`). Un borrador sí se edita y se borra.
2. **Número de asiento al contabilizar**, no al crear: `AS-<ejercicio>-<correlativo>`, sin huecos, contador por ejercicio en `entry_sequences`.
3. **Periodos mensuales con estado abierto/cerrado.** Se cierran en orden, sin borradores dentro; se reabren de atrás hacia adelante. Un periodo cerrado rechaza asientos con fecha dentro (409 `PERIOD_CLOSED`).
4. **Importes en centavos, `BIGINT` CON signo** (no `UNSIGNED`: los informes restan debe − haber y MySQL falla con «BIGINT UNSIGNED value is out of range»). La no negatividad la garantiza un `CHECK`.
5. **Cuentas:** el código con puntos lleva la jerarquía (un hijo empieza por el código del padre + `.`). Solo las cuentas **de detalle** reciben movimientos. Colgar una subcuenta de una de detalle sin movimientos la vuelve de agrupación. Costos y gastos comparten la raíz `5`.
6. **`system_role`:** marca la cuenta que usarán las reglas automáticas de la Fase 1.2 (clientes, IVA, costo de ventas…). Una por rol y organización (`UNIQUE`). Ya viene puesto en la plantilla.
7. **Dimensiones:** centro de costo, proyecto, establecimiento y tercero (cliente/proveedor/empleado) en cada línea. Hoy la pantalla solo usa el centro de costo; el resto ya está en el modelo y en la API.
8. **Moneda:** la organización tiene moneda base; una línea puede llevar moneda original, importe y tipo de cambio (se valida que coincidan con el importe base). Sin revalorización todavía (Fase 7).
9. **Balance de comprobación:** las cuentas de resultados (ingresos/costos/gastos) empiezan en cero cada ejercicio. Mientras no exista el asiento de cierre de ejercicio (Fase 7), lo de ejercicios anteriores sale en una fila `synthetic` «Resultados de ejercicios anteriores (sin cerrar)», para que saldo inicial y final sigan sumando cero.
10. **Separación de funciones** (permisos): `journal:create` prepara borradores; `journal:post` contabiliza; `journal:reverse` reversa; `period:manage` cierra; `account:manage` toca el plan. Por defecto el Supervisor prepara y el Administrador contabiliza.

## Concurrencia: lo que solo se vio con MySQL real

Las pruebas en memoria no pueden probar esto. `scripts/verify-accounting.mjs` lanza peticiones simultáneas:

- **30 asientos contabilizados a la vez:** al principio 23 morían con interbloqueo. Causa: `INSERT IGNORE` sobre la fila contador **ya existente** toma un bloqueo compartido; dos transacciones lo tienen y ambas piden el exclusivo del `UPDATE`. Arreglo: el contador nace con el ejercicio (`saveYear`) y `nextNumber` hace **primero** el `UPDATE`. Ahora salen los 30, numerados 1…30.
- **`rollback()` tolerante:** si MySQL ya deshizo la transacción por el interbloqueo, un segundo `rollback` lanzaba «Transaction cannot be rolled back…» y tapaba el error real.
- **Interbloqueo o espera agotada → 409 `CONCURRENT_UPDATE`** (reintentable), no 500.
- **10 reversas simultáneas del mismo asiento:** gana una; las otras 9 dan 409 (el asiento se bloquea con `FOR UPDATE` y hay un `UNIQUE` sobre `reverses_entry_id`).
- **Cerrar un periodo mientras se contabiliza en él:** con 20 asientos escalonados y el cierre a mitad, 10 entran antes y 10 reciben `PERIOD_CLOSED`; el balance del periodo coincide con lo contabilizado y después del cierre nada entra. Se logra leyendo el periodo **con bloqueo** (compartido al contabilizar, exclusivo al cerrar), porque bajo REPEATABLE READ una lectura normal vería la «foto» anterior al cierre.

Guardias de código (`persistence-guard.test.ts`): sin `upsert`, lecturas que deciden con `lock`, orden del contador, `BIGINT` con signo.

## Eventos que publica (outbox → `crm.events`)

`accounting.setup.completed`, `accounting.account.created|updated`, `accounting.cost_center.upserted`, `accounting.fiscal_year.created`, `accounting.period.closed|reopened`, `accounting.journal_entry.saved|deleted|posted|reversed`. El de **posted** lleva las líneas (es el hecho que consumirán reportes y BI). Cada escritura publica uno (`audit-coverage.test.ts`); la bitácora ya los recoge porque consume `#`. Detalle en `asyncapi.yaml`; API en `openapi.yaml`.

## Cableado fuera de este repo

- `auth-service`: migración `20261015100000-add-accounting-permissions.js` (8 permisos).
- `plugin-catalog-service`: `finance.general_ledger` pasa a «hecho», **sin dependencia** de `finance.accounts_receivable_payable` (migración `20261015110000-enable-general-ledger.cjs`; seed e i18n actualizados). Se ajustó la prueba de precios del paquete «contabilidad completa» (pide los dos módulos).
- `api-gateway-node`: servicio `ACCOUNTING_SERVICE_URL`, rutas `/accounting/*` con `requiresPlugin: finance.general_ledger` y tope de 512 KB en los asientos (hasta 500 líneas). Prueba `accounting-routes.test.ts`.
- `frontend`: `src/{types,api,stores,utils}/accounting*`, `views/accounting/*` (plan de cuentas + centros de costo, libro diario, asiento, periodos, balance y mayor), `components/accounting/*`, ruta `/accounting/*`, ítem de menú, i18n es/en/fr. En teléfono las líneas del asiento son tarjetas apiladas.
- `docker-compose.yml` y `docker/mysql/init.sql`: servicio y base.

## Por hacer para desplegar

- [ ] Crear el repo `facturero/accounting-service` (rama `main`, secretos `NODE_AUTH_TOKEN` y los de SOPS) y subir la carpeta (no hay `git init` hecho).
- [ ] Base del clúster: `accounting_db` y `accounting_user` con sus `GRANT`; `config/secrets.production.enc` con `DB_*` y `RABBITMQ_URL` (no existe: hace falta la clave age).
- [ ] Orden de subida: `auth-service` → `plugin-catalog-service` → **`inventory-service` y `billing-service`** (el evento ya lleva `occurredAt` / `issueDate`; aditivo) → `accounting-service` → `api-gateway-node` → `frontend`.
- [ ] Decidir el precio (hoy 14,99 USD en `plugins-precios.json`, ya existente en el catálogo).
- [ ] Añadir `accounting-service` a `modelo-datos/verificar-dbml.mjs` y sus tablas a `crm.dbml` (restaurant-service tampoco está).

## Fase 1.2 — contabilización automática

**Qué hace.** `accounting-service` consume `billing.invoice.issued|voided`, `inventory.stock.consumed|entered|adjusted` y `plugin.activated|deactivated` (cola `accounting-service.events`) y genera asientos `kind = automatic`, contabilizados, enlazados al documento (`source_type`/`source_id`). Las reglas son funciones puras (`domain/posting.ts`) que hablan de **roles** (`receivables`, `vat_payable`, `cogs`…), no de códigos: la organización decide qué cuenta lleva cada rol desde la pestaña «Automática» (`PATCH /accounting/accounts/:id` con `systemRole`; mover un rol deja sin él a la cuenta que lo tenía).

| Evento | Asiento |
|---|---|
| Factura (01) | Dr clientes (o **caja/bancos** si trae forma de pago) = total · Cr ventas = suma de subtotales · Cr IVA por pagar |
| Nota de crédito (04) | Dr devoluciones en ventas + IVA · Cr clientes (o caja/bancos) |
| Anulación de factura | Reversa del asiento automático (fecha = la de la anulación) |
| Venta (`consumed`, `sale_out`) | Dr costo de ventas · Cr inventario, por el **costo** (`totalCostCents`), no por el precio |
| Reposición por anulación (`entered`, `adjustment_in`) | Dr inventario · Cr costo de ventas |
| Saldo inicial (`opening_balance`) | Dr inventario · Cr ganancias acumuladas |
| Ajuste (`adjusted`) | sobrante → Dr inventario / Cr ganancia por ajuste · merma → Dr mermas / Cr inventario · uso interno → Dr otros gastos / Cr inventario |
| **Compra (`purchase_in`)** | **No se contabiliza aquí**: lo hará la factura del proveedor (Fase 2), contra proveedores. Hacerlo aquí duplicaría el inventario |
| Traslados, otros comprobantes (05/06/07) | Se ignoran |

Forma de pago del SRI → dónde se cobra (editable): 01 → caja; 16, 17, 18, 19, 20 → bancos; el resto o ninguna → por cobrar.

**Reglas de oro**

1. **Idempotente.** Un documento de origen genera como mucho un asiento automático (`UNIQUE (org, source_type, source_id, kind)` + comprobación previa). Un evento repetido, o el mismo documento con otro `eventId`, no duplica.
2. **No se pierde nada.** Lo que no se puede contabilizar (periodo cerrado o sin ejercicio, rol sin cuenta, cuenta inactiva, impuesto que no es IVA, el documento no cuadra, otra moneda, módulo apagado) queda en `pending_postings` con su contenido y el motivo, y publica `accounting.posting.pending`. Se arregla la causa y se reintenta (`POST /accounting/pending-postings/retry`, permiso `journal:post`) o se descarta con un motivo. Un fallo **técnico** (base de datos) sube al `InboxConsumer`, que reintenta con espera.
3. **Solo para quien tiene contabilidad, y desde una fecha.** Una organización sin configurar se ignora. Solo cuentan los documentos con fecha ≥ `auto_posting_from` (por defecto, el día del alta): lo anterior se carga como saldos iniciales; contarlo dos veces descuadraría los libros.
4. **Fecha contable en la zona horaria de la organización** (`timezone`, por defecto `America/Guayaquil`): una venta a las 20:00 del día 20 en Guayaquil llega con fecha del 21 en UTC.
5. **Desactivar el módulo apaga la contabilización** (`plugin.deactivated`); lo que llegue queda pendiente y se reintenta al reactivar.

**Lo que costó descubrir con RabbitMQ real**

- **La anulación puede adelantarse a la emisión** (RabbitMQ no garantiza el orden entre mensajes): la anulación de una factura recién emitida llegaba cuando su asiento aún no existía y se perdía. Ahora una anulación sin asiento original queda **pendiente** (`ORIGINAL_NOT_POSTED`) y se resuelve sola cuando se contabiliza la emisión (y, si la emisión se contabilizó entre medias, se reintenta al anotar el pendiente). Para no dejar esperando eternamente las anulaciones de facturas anteriores a la contabilidad, `billing-service` ahora incluye `issueDate` en `billing.invoice.voided`.
- **Dos entregas a la vez de la misma anulación:** la segunda, ya con el bloqueo del asiento, veía «ya reversado» y lo dejaba pendiente por error. Ahora es un duplicado.
- **40 facturas + 40 costos simultáneos:** 80 asientos, numeración sin huecos, balance cuadrado. **10 entregas simultáneas del mismo documento:** un asiento. **Mensaje basura:** el consumidor sigue.

**Cambios en otros servicios (aditivos)**

- `inventory-service`: `movementPayload` ahora lleva `occurredAt` (cuándo ocurrió el movimiento). Sin él, accounting usa la hora de llegada del mensaje.
- `billing-service`: `billing.invoice.voided` lleva `issueDate`.

**Pantalla del CRM** (`/accounting/automatic`, pestaña «Automática» con globo de pendientes): pendientes (reintentar, descartar con motivo), ajustes (interruptor, fecha de inicio, a dónde va cada forma de pago) y qué cuenta lleva cada rol (los que usan las reglas primero; los de módulos futuros en un desplegable). La lista de asientos tiene filtro y etiqueta de origen.

**Límites conocidos de la 1.2**

- Los ingresos van todos a `sales_revenue`: el evento de la factura no distingue bien de servicio (`services_revenue` existe como rol pero ninguna regla lo usa).
- Un impuesto que no es IVA (`special`, retenciones) deja la factura pendiente; hace falta decidir cuentas (Fase 1.4 trae las retenciones).
- Todo en la moneda base; una factura en otra moneda queda pendiente (`CURRENCY_MISMATCH`).
- El aviso de un pendiente sale como evento `accounting.posting.pending`, pero **todavía no suena la campana**: falta el proveedor y la plantilla en `notification-service`.
- No hay reproducción de documentos anteriores a la activación (solo su fecha de inicio); billing no ofrece un listado para reconstruirlos.

## Fase 1.3 — estados financieros

**Qué hay.** `GET /accounting/reports/balance-sheet` y `GET /accounting/reports/income-statement` (permiso `ledger:read`), con comparación opcional, filtro por centro de costo, nivel máximo y «incluir en cero». Pantalla `/accounting/statements` («Estados financieros») con las dos vistas, comparación (cierre del año anterior / misma fecha un año antes; periodo anterior / mismo periodo del año anterior), exportación a **CSV** (con BOM: Excel lo abre bien) e **impresión / PDF** (`styles/print.css` oculta el armazón de la aplicación).

**Decisiones**

1. **Signo natural.** Cada importe sale en el sentido de su cuenta (activo, costo y gasto por el debe; pasivo, patrimonio e ingreso por el haber): lo normal es positivo. Una regularizadora (depreciación acumulada, devoluciones en ventas) sale en negativo y resta. El balance se lee sin invertir signos.
2. **El resultado va DENTRO del patrimonio.** Mientras no exista el asiento de cierre de ejercicio (Fase 7), el balance muestra dos filas calculadas (`synthetic`): «Resultados de ejercicios anteriores (sin cerrar)» y «Resultado del ejercicio». Sin ellas el activo no igualaría a pasivo + patrimonio. `totals.differenceCents` debe ser 0; la pantalla lo anuncia con una etiqueta.
3. **Costos y gastos no se mezclan.** La plantilla los cuelga de la misma raíz (`5`); el estado de resultados suma cada cuenta de agrupación solo con sus hijas **del mismo tipo**: «Costos» incluye `5` y `5.1…`; «Gastos» empieza en `5.2`.
4. **Utilidad bruta** = ingresos − costos; **resultado neto** = utilidad bruta − gastos.
5. **Reutiliza `sumByAccount`**: el balance a una fecha es `from = to = fecha` (acumulado = `netBeforeFrom + debit − credit`), así que no hay consulta nueva. Las comparaciones piden las sumas otra vez con las otras fechas.
6. **Niveles:** `maxLevel` solo oculta filas; los totales salen de las cuentas de detalle y no cambian.

**Verificación.** Pruebas de dominio/caso de uso (escenario de dos ejercicios con cifras a mano, regularizadoras, comparaciones, centro de costo, validación, HTTP) y `scripts/verify-statements.mjs` contra MySQL real: el mismo escenario más una **propiedad**: tras 300 asientos aleatorios en tres ejercicios, en seis fechas de corte activo = pasivo + patrimonio, los resultados anteriores suman los de 2025 y 2026, y el activo coincide con el balance de comprobación. En el navegador: balance y estado de resultados con datos reales de la contabilización automática, y comparación.

**Límites conocidos.** Es la presentación por plan de cuentas (agrupa por la estructura de códigos), no el formato oficial de la Superintendencia de Compañías ni los formularios del SRI (esos son de la Fase 6). Sin estado de flujos de efectivo ni de cambios en el patrimonio (el flujo de caja es la Fase 3). Los totales por centro de costo en el balance general existen pero rara vez tienen sentido (el patrimonio no se reparte por centros).

## Fase 1.4 — retenciones y nota de débito

**Nota de débito (05).** Una nota de débito cobra de más sobre una factura (intereses de mora, gastos de cobranza): se contabiliza **como una factura** (Dr clientes o caja/bancos / Cr ingreso / Cr IVA) pero el ingreso va al rol nuevo **`other_income`** («Otros ingresos no operacionales», 4.2.03 en la plantilla), no a ventas. Las organizaciones que ya tenían el plan cargado deben asignar el rol a la cuenta que corresponda (migración `20261015130000-role-other-income.cjs` lo hace donde la cuenta 4.2.03 existe).

**Retención emitida (`fiscal.ec.withholding.issued`).** Lo publica fiscal-ecuador al autorizarse el comprobante. Regla: Dr `payables` (total retenido) / Cr `income_tax_withholding_payable` (renta) / Cr `vat_withholding_payable` (IVA). Idempotente por retención (`source_type = 'withholding'`). Casos que quedan **pendientes** en vez de asentarse mal: ISD (sin cuenta todavía: `UNMAPPED_TAX_KIND`), total que no cuadra (`UNBALANCED_SOURCE`), otra moneda, rol sin cuenta.

**Supuesto importante.** La regla da por hecho que **la compra ya está en proveedores** (módulo de compras, Fase 2, o un asiento manual). Hasta entonces la retención deja el saldo del proveedor transitoriamente deudor. Las retenciones **recibidas** (que nos hacen los clientes) no se emiten aquí: llegan con la tesorería/cobros (Fase 3).

**Corrección de inventario (otro servicio).** `inventory-service` trataba toda factura emitida como venta: una nota de crédito (clon de las líneas) habría descontado stock otra vez. Ahora solo `documentTypeCode '01'` mueve el kardex (la devolución de mercadería por nota de crédito es una decisión de la Fase 5).

Pruebas: reglas puras y casos de uso (151 en total); la pantalla de roles muestra los tres roles nuevos como activos.

## Siguiente

Fase 2 (compras y cuentas por pagar): la factura del proveedor crea el pasivo contra el que se asientan las retenciones; después, tesorería y cobros (Fase 3), con las retenciones recibidas y el ISD.

Consumir `billing.invoice.issued|voided`, `inventory.stock.*` y generar asientos con **reglas de contabilización** configurables (cuenta por rol, IVA por tarifa, costo de ventas). Idempotencia por `(source_type, source_id, kind)` — el `UNIQUE` y `findBySource` ya están. Hay que decidir qué hace una regla cuando el periodo está cerrado o no existe (propuesta: cola de pendientes, no perder el evento) y reproducir lo anterior a la activación del módulo.
