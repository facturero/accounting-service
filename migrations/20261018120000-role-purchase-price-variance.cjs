'use strict';

/**
 * Rol `purchase_price_variance` (diferencias de precio en compras): la factura de compra con override
 * por variación de precio lleva la diferencia aquí en lugar de a inventario (el stock se valúa al costo de la orden).
 * La plantilla de Ecuador ya lo trae en la cuenta 5.2.11; esto se lo pone a las organizaciones que ya se habían dado
 * de alta con la plantilla anterior, SOLO si esa cuenta existe, es de detalle, no tiene ya otro rol y la organización
 * no usa el rol en otra cuenta. Si no, queda sin asignar y el asiento esperará en "Pendientes" hasta que alguien lo asigne.
 *
 * Ojo: NO crea la cuenta 5.2.11. Una organización dada de alta con la plantilla anterior no la tiene; su administrador la crea
 * (gasto, de detalle) y le asigna el rol desde el plan de cuentas. Mientras tanto solo se queda en pendientes la factura de
 * compra aprobada con diferencia de precio; las demás se asientan con normalidad.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE accounts a
          SET a.system_role = 'purchase_price_variance', a.updated_at = NOW()
        WHERE a.code = '5.2.11' AND a.is_postable = 1 AND a.system_role IS NULL
          AND NOT EXISTS (SELECT 1 FROM (SELECT organization_id FROM accounts WHERE system_role = 'purchase_price_variance') x
                           WHERE x.organization_id = a.organization_id)`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query("UPDATE accounts SET system_role = NULL WHERE system_role = 'purchase_price_variance' AND code = '5.2.11'");
  },
};