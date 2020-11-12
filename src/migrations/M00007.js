export async function up(knex) {
	await knex.schema.table('app', (table) => {
		table.string('uuid');
		table.string('type');
		table.unique('uuid');
	});

	// All apps at the point of this execution will be supervised
	await knex('app').update({ type: 'supervised' });
}

export async function down() {
	throw new Error('Not implemented');
}
