'use strict';

/**
 * Fase 1.2 (contabilización automática):
 *  - accounting_settings gana la zona horaria (de ella sale la fecha contable de un evento), el interruptor de la contabilización
 *    automática, la fecha desde la que cuenta y el mapa forma de pago → caja/bancos/por cobrar.
 *  - pending_postings: eventos que debían generar asiento y no pudieron (periodo cerrado, cuenta sin rol…), con su contenido para
 *    reintentarlos. UNIQUE por (organización, evento, origen): una reentrega del mismo evento no crea otra fila.
 *
 * Las organizaciones que ya tenían contabilidad (solo desarrollo) empiezan a contabilizar solas desde el día en que se configuraron.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('accounting_settings', 'timezone', { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'America/Guayaquil' });
    await queryInterface.addColumn('accounting_settings', 'auto_posting', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true });
    await queryInterface.addColumn('accounting_settings', 'auto_posting_from', { type: Sequelize.DATEONLY, allowNull: true });
    await queryInterface.addColumn('accounting_settings', 'payment_method_roles', { type: Sequelize.JSON, allowNull: true });
    await queryInterface.sequelize.query('UPDATE accounting_settings SET auto_posting_from = DATE(initialized_at) WHERE auto_posting_from IS NULL');

    await queryInterface.createTable('pending_postings', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      event_type: { type: Sequelize.STRING(100), allowNull: false },
      source_type: { type: Sequelize.STRING(50), allowNull: false },
      source_id: { type: Sequelize.STRING(64), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      reason_code: { type: Sequelize.STRING(60), allowNull: false },
      reason_message: { type: Sequelize.STRING(255), allowNull: false },
      status: { type: Sequelize.ENUM('pending', 'posted', 'discarded'), allowNull: false, defaultValue: 'pending' },
      attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      entry_id: { type: Sequelize.CHAR(36), allowNull: true },
      entry_date: { type: Sequelize.DATEONLY, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
      resolved_at: { type: Sequelize.DATE, allowNull: true },
    });
    await queryInterface.addIndex('pending_postings', ['organization_id', 'event_type', 'source_type', 'source_id'], { unique: true, name: 'pending_postings_source_uq' });
    await queryInterface.addIndex('pending_postings', ['organization_id', 'status', 'created_at'], { name: 'pending_postings_status_idx' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('pending_postings');
    for (const c of ['payment_method_roles', 'auto_posting_from', 'auto_posting', 'timezone']) {
      await queryInterface.removeColumn('accounting_settings', c);
    }
  },
};
