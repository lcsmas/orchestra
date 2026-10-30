// Types for scripts/lib/fuse-wire.cjs (imported by src/main/cookie-fuse-state.ts).
export const SENTINEL: string;
export const V1_NAMES: readonly string[];
export type FuseWireResult = { ok: true; version: number; offset: number; fuses: Record<string, 'enabled' | 'disabled' | 'removed'> } | { ok: false; reason: string };
export function parseFuseWire(buf: Buffer): FuseWireResult;
export function readFuseWireFile(file: string): FuseWireResult;
export function cookieFuseOffset(buf: Buffer): number;
export function expectCookieFuse(wire: FuseWireResult | null, shipped: boolean): { ok: boolean; message: string };
