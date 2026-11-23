import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function normalizeParam(value) {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return value;
}

function toPlainRow(row) {
    if (!row || typeof row !== 'object') return null;
    return Object.assign({}, row);
}

function statementReturnsRows(stmt, sql) {
    if (typeof stmt.columns === 'function') {
        return stmt.columns().length > 0;
    }
    return /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
}

class SqliteD1Statement {
    constructor(db, sql, params = []) {
        this._db = db;
        this._sql = sql;
        this._params = params;
    }

    bind(...params) {
        return new SqliteD1Statement(this._db, this._sql, params.map(normalizeParam));
    }

    async first(columnName) {
        const stmt = this._db.prepare(this._sql);
        const row = toPlainRow(stmt.get(...this._params));
        if (!row) return null;
        if (columnName !== undefined) {
            return Object.prototype.hasOwnProperty.call(row, columnName) ? row[columnName] : null;
        }
        return row;
    }

    async all() {
        const stmt = this._db.prepare(this._sql);
        const rows = stmt.all(...this._params).map(toPlainRow);
        return {
            results: rows,
            success: true,
            meta: { changes: 0, last_row_id: 0 },
        };
    }

    async run() {
        const stmt = this._db.prepare(this._sql);
        const info = stmt.run(...this._params);
        return {
            results: [],
            success: true,
            meta: {
                changes: Number(info?.changes || 0),
                last_row_id: Number(info?.lastInsertRowid || 0),
            },
        };
    }

    async raw() {
        const stmt = this._db.prepare(this._sql);
        const rows = stmt.all(...this._params);
        return rows.map(row => Object.values(row));
    }

    _executeSync() {
        const stmt = this._db.prepare(this._sql);
        if (statementReturnsRows(stmt, this._sql)) {
            return {
                results: stmt.all(...this._params).map(toPlainRow),
                success: true,
                meta: { changes: 0, last_row_id: 0 },
            };
        }
        const info = stmt.run(...this._params);
        return {
            results: [],
            success: true,
            meta: {
                changes: Number(info?.changes || 0),
                last_row_id: Number(info?.lastInsertRowid || 0),
            },
        };
    }
}

export function createSqliteD1(dbPath) {
    if (dbPath !== ':memory:') {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');

    return {
        prepare(sql) {
            return new SqliteD1Statement(db, sql);
        },

        async batch(statements = []) {
            if (!Array.isArray(statements) || statements.length === 0) return [];
            db.exec('BEGIN IMMEDIATE');
            try {
                const results = statements.map(statement => statement._executeSync());
                db.exec('COMMIT');
                return results;
            } catch (error) {
                try { db.exec('ROLLBACK'); } catch {}
                throw error;
            }
        },

        async exec(sql) {
            const started = Date.now();
            db.exec(sql);
            return { count: 1, duration: Date.now() - started };
        },

        close() {
            db.close();
        },
    };
}
