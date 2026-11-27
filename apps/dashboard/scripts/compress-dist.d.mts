// Types for compress-dist.mjs (used by src/test/compressDist.test.ts).
export declare const COMPRESSIBLE: Set<string>;
export declare const MIN_BYTES: number;
export declare function compressBuffer(buf: Uint8Array): Promise<{ br: Buffer; gz: Buffer }>;
export declare function compressDist(distDir: string): Promise<{ file: string; raw: number; gzip: number; brotli: number }[]>;
