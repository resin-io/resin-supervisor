export async function up(knex) {
	await knex.schema.table('app', (table) => {
		table.string('uuid');
		table.string('type');
		table.unique('uuid');
	});

	await knex.schema.table('image', (table) => {
		table.string('appUuid');
	});

	// All apps at the point of this execution will be supervised
	await knex('app').update({ type: 'supervised' });
}

export async function down() {
	throw new Error('Not implemented');
}
