import { LibsqlError } from '@libsql/client';
import { type SQL, sql } from 'drizzle-orm';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import { bold } from 'kleur/colors';
import {
	FOREIGN_KEY_DNE_ERROR,
	FOREIGN_KEY_REFERENCES_EMPTY_ERROR,
	FOREIGN_KEY_REFERENCES_LENGTH_ERROR,
	REFERENCE_DNE_ERROR,
	SEED_ERROR,
} from '../core/errors.js';
import type {
	BooleanColumn,
	ColumnType,
	DBColumn,
	DBTable,
	DBTables,
	DateColumn,
	JsonColumn,
	NumberColumn,
	TextColumn,
} from '../core/types.js';
import { type SqliteDB, hasPrimaryKey } from './index.js';
import { isSerializedSQL } from './types.js';

const sqlite = new SQLiteAsyncDialect();

export const SEED_DEV_FILE_NAME = ['seed.ts', 'seed.js', 'seed.mjs', 'seed.mts'];

export async function seedLocal({
	db,
	tables,
	// Glob all potential seed files to catch renames and deletions.
	fileGlob,
}: {
	db: SqliteDB;
	tables: DBTables;
	fileGlob: Record<string, () => Promise<void>>;
}) {
	await recreateTables({ db, tables });
	for (const fileName of SEED_DEV_FILE_NAME) {
		const key = Object.keys(fileGlob).find((f) => f.endsWith(fileName));
		if (key) {
			await fileGlob[key]().catch((e) => {
				if (e instanceof LibsqlError) {
					throw new Error(SEED_ERROR(e.message));
				}
				throw e;
			});
			return;
		}
	}
}

export async function recreateTables({ db, tables }: { db: SqliteDB; tables: DBTables }) {
	const setupQueries: SQL[] = [];
	for (const [name, table] of Object.entries(tables)) {
		const dropQuery = sql.raw(`DROP TABLE IF EXISTS ${sqlite.escapeName(name)}`);
		const createQuery = sql.raw(getCreateTableQuery(name, table));
		const indexQueries = getCreateIndexQueries(name, table);
		setupQueries.push(dropQuery, createQuery, ...indexQueries.map((s) => sql.raw(s)));
	}
	await db.batch([
		db.run(sql`pragma defer_foreign_keys=true;`),
		...setupQueries.map((q) => db.run(q)),
	]);
}

export function getDropTableIfExistsQuery(tableName: string) {
	return `DROP TABLE IF EXISTS ${sqlite.escapeName(tableName)}`;
}

export function getCreateTableQuery(tableName: string, table: DBTable) {
	let query = `CREATE TABLE ${sqlite.escapeName(tableName)} (`;

	const colQueries = [];
	const colHasPrimaryKey = Object.entries(table.columns).find(([, column]) =>
		hasPrimaryKey(column)
	);
	if (!colHasPrimaryKey) {
		colQueries.push('_id INTEGER PRIMARY KEY');
	}
	for (const [columnName, column] of Object.entries(table.columns)) {
		const colQuery = `${sqlite.escapeName(columnName)} ${schemaTypeToSqlType(
			column.type
		)}${getModifiers(columnName, column)}`;
		colQueries.push(colQuery);
	}

	colQueries.push(...getCreateForeignKeyQueries(tableName, table));

	query += colQueries.join(', ') + ')';
	return query;
}

export function getCreateIndexQueries(tableName: string, table: Pick<DBTable, 'indexes'>) {
	let queries: string[] = [];
	for (const [indexName, indexProps] of Object.entries(table.indexes ?? {})) {
		const onColNames = asArray(indexProps.on);
		const onCols = onColNames.map((colName) => sqlite.escapeName(colName));

		const unique = indexProps.unique ? 'UNIQUE ' : '';
		const indexQuery = `CREATE ${unique}INDEX ${sqlite.escapeName(
			indexName
		)} ON ${sqlite.escapeName(tableName)} (${onCols.join(', ')})`;
		queries.push(indexQuery);
	}
	return queries;
}

export function getCreateForeignKeyQueries(tableName: string, table: DBTable) {
	let queries: string[] = [];
	for (const foreignKey of table.foreignKeys ?? []) {
		const columns = asArray(foreignKey.columns);
		const references = asArray(foreignKey.references);

		if (columns.length !== references.length) {
			throw new Error(FOREIGN_KEY_REFERENCES_LENGTH_ERROR(tableName));
		}
		const firstReference = references[0];
		if (!firstReference) {
			throw new Error(FOREIGN_KEY_REFERENCES_EMPTY_ERROR(tableName));
		}
		const referencedTable = firstReference.schema.collection;
		if (!referencedTable) {
			throw new Error(FOREIGN_KEY_DNE_ERROR(tableName));
		}
		const query = `FOREIGN KEY (${columns
			.map((f) => sqlite.escapeName(f))
			.join(', ')}) REFERENCES ${sqlite.escapeName(referencedTable)}(${references
			.map((r) => sqlite.escapeName(r.schema.name!))
			.join(', ')})`;
		queries.push(query);
	}
	return queries;
}

function asArray<T>(value: T | T[]) {
	return Array.isArray(value) ? value : [value];
}

export function schemaTypeToSqlType(type: ColumnType): 'text' | 'integer' {
	switch (type) {
		case 'date':
		case 'text':
		case 'json':
			return 'text';
		case 'number':
		case 'boolean':
			return 'integer';
	}
}

export function getModifiers(columnName: string, column: DBColumn) {
	let modifiers = '';
	if (hasPrimaryKey(column)) {
		return ' PRIMARY KEY';
	}
	if (!column.schema.optional) {
		modifiers += ' NOT NULL';
	}
	if (column.schema.unique) {
		modifiers += ' UNIQUE';
	}
	if (hasDefault(column)) {
		modifiers += ` DEFAULT ${getDefaultValueSql(columnName, column)}`;
	}
	const references = getReferencesConfig(column);
	if (references) {
		const { collection: tableName, name } = references.schema;
		if (!tableName || !name) {
			throw new Error(REFERENCE_DNE_ERROR(columnName));
		}

		modifiers += ` REFERENCES ${sqlite.escapeName(tableName)} (${sqlite.escapeName(name)})`;
	}
	return modifiers;
}

export function getReferencesConfig(column: DBColumn) {
	const canHaveReferences = column.type === 'number' || column.type === 'text';
	if (!canHaveReferences) return undefined;
	return column.schema.references;
}

// Using `DBColumn` will not narrow `default` based on the column `type`
// Handle each column separately
type WithDefaultDefined<T extends DBColumn> = T & {
	schema: Required<Pick<T['schema'], 'default'>>;
};
type DBColumnWithDefault =
	| WithDefaultDefined<TextColumn>
	| WithDefaultDefined<DateColumn>
	| WithDefaultDefined<NumberColumn>
	| WithDefaultDefined<BooleanColumn>
	| WithDefaultDefined<JsonColumn>;

// Type narrowing the default fails on union types, so use a type guard
export function hasDefault(column: DBColumn): column is DBColumnWithDefault {
	if (column.schema.default !== undefined) {
		return true;
	}
	if (hasPrimaryKey(column) && column.type === 'number') {
		return true;
	}
	return false;
}

function toDefault<T>(def: T | SQL<any>): string {
	const type = typeof def;
	if (type === 'string') {
		return sqlite.escapeString(def as string);
	} else if (type === 'boolean') {
		return def ? 'TRUE' : 'FALSE';
	} else {
		return def + '';
	}
}

function getDefaultValueSql(columnName: string, column: DBColumnWithDefault): string {
	if (isSerializedSQL(column.schema.default)) {
		return column.schema.default.sql;
	}

	switch (column.type) {
		case 'boolean':
		case 'number':
		case 'text':
		case 'date':
			return toDefault(column.schema.default);
		case 'json': {
			let stringified = '';
			try {
				stringified = JSON.stringify(column.schema.default);
			} catch (e) {
				// eslint-disable-next-line no-console
				console.log(
					`Invalid default value for column ${bold(
						columnName
					)}. Defaults must be valid JSON when using the \`json()\` type.`
				);
				process.exit(0);
			}

			return sqlite.escapeString(stringified);
		}
	}
}
