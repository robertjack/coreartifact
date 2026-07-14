// Minimal ambient declarations for the Node.js builtins used by src/core and
// src/cli. @types/node is unreachable in this environment (no registry
// access), so this hand-rolled shim covers exactly the surface exercised
// here rather than pulling in the full package.

declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
  interface ErrnoException extends Error {
    code?: string;
  }
  type Signals = string;
}

declare const process: {
  env: NodeJS.ProcessEnv;
  argv: string[];
  pid: number;
  exit(code?: number): never;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
  kill(pid: number, signal?: string | number): boolean;
  on(event: string, listener: (...args: any[]) => void): void;
  removeListener(event: string, listener: (...args: any[]) => void): void;
};

declare function setTimeout(callback: () => void, ms?: number): unknown;

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
  export function resolve(...parts: string[]): string;
}

declare module 'node:os' {
  export function homedir(): string;
}

declare module 'node:fs' {
  export function realpathSync(path: string): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function unlinkSync(path: string): void;
  export function statSync(path: string): { mtimeMs: number };
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:fs/promises' {
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function writeFile(path: string, data: string): Promise<void>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function link(existingPath: string, newPath: string): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function unlink(path: string): Promise<void>;
}

declare module 'node:child_process' {
  export interface ExecFileSyncOptions {
    cwd?: string;
    encoding?: string;
    stdio?: unknown;
  }
  export function execFileSync(command: string, args?: string[], options?: ExecFileSyncOptions): string;
}

declare module 'node:sqlite' {
  export interface DatabaseSyncOptions {
    readOnly?: boolean;
  }
  export class StatementSync {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
