// Minimal ambient types for better-sqlite3 11.10.0, which ships no .d.ts and
// whose DefinitelyTyped package would be a second source of truth to keep in
// sync. Only the surface src/main/bus.ts actually uses is declared — anything
// this file omits is a compile error at the call site rather than an `any`,
// which is the point.
declare module 'better-sqlite3' {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface Statement {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  interface Transaction<F extends (...args: never[]) => unknown> {
    (...args: Parameters<F>): ReturnType<F>;
    /** BEGIN IMMEDIATE — takes the write lock up front. */
    immediate(...args: Parameters<F>): ReturnType<F>;
    deferred(...args: Parameters<F>): ReturnType<F>;
    exclusive(...args: Parameters<F>): ReturnType<F>;
  }

  interface Options {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
    /** Absolute path to a specific .node binding — how bus-binding.ts pins the ABI. */
    nativeBinding?: string;
  }

  class Database {
    constructor(filename: string, options?: Options);
    readonly name: string;
    readonly open: boolean;
    readonly inTransaction: boolean;
    prepare(sql: string): Statement;
    exec(sql: string): this;
    pragma(source: string, options?: { simple?: boolean }): unknown;
    transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F>;
    close(): this;
  }

  export = Database;
}
