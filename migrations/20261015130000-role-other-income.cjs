'use strict';

/**
 * Rol `other_income` (otros ingresos): la nota de débito reconoce lo cobrado de más (intereses de mora, gastos de cobranza) ahí y
 * no en ventas. La plantilla de Ecuador ya lo trae en la cuenta 4.2.03; esto se lo pone a las organizaciones que ya se habían dado
 * de alta con la plantilla anterior, SOLO si esa cuenta existe, es de detalle, no tiene ya otro rol y la organización no usa el rol
 * en otra cuenta. Si no, queda sin asignar y la nota de débito esperará en «Pendientes» hasta que alguien lo asigne.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE accounts a
          SET a.system_role = 'other_income', a.updated_at = NOW()
        WHERE a.code = '4.2.03' AND a.is_postable = 1 AND a.system_role IS NULL
          AND NOT EXISTS (SELECT 1 FROM (SELECT organization_id FROM accounts WHERE system_role = 'other_income') x
                           WHERE x.organization_id = a.organization_id)`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query("UPDATE accounts SET system_role = NULL WHERE system_role = 'other_income' AND code = '4.2.03'");
  },
};
