'use strict';

/**
 * Dimensión «proyecto» para lo que se contabiliza solo.
 *
 * - source_projects: a qué proyecto pertenece un documento de otro servicio. Hoy, las facturas que se crean desde la pestaña
 *   «Facturación» de un proyecto: projects-service publica `projects.invoice.linked` (al crear el borrador, antes de emitir) y
 *   `projects.invoice.issued`, y al contabilizar `billing.invoice.issued` todas las líneas del asiento salen con ese proyecto. Así el
 *   estado de resultados filtrado por proyecto muestra lo que facturó cada uno. Clave primaria (organización, tipo, documento): un
 *   documento es de un solo proyecto.
 * - Índice en journal_lines (organization_id, project_id, entry_date) para los informes filtrados por proyecto.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('source_projects', {
      organization_id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      source_type: { type: Sequelize.STRING(50), allowNull: false, primaryKey: true },
      source_id: { type: Sequelize.STRING(64), allowNull: false, primaryKey: true },
      project_id: { type: Sequelize.CHAR(36), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('journal_lines', ['organization_id', 'project_id', 'entry_date'], { name: 'journal_lines_org_project_date_idx' });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('journal_lines', 'journal_lines_org_project_date_idx');
    await queryInterface.dropTable('source_projects');
  },
};
