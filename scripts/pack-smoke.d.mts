/** Type declarations for `./pack-smoke.mjs` (imported by `test/pack-smoke.test.ts`). */
export declare const REQUIRED_PACKAGE_FILES: readonly string[];
export declare const UNPACKED_SIZE_CEILING_BYTES: number;
export declare function assessPackFileList(files: readonly string[]): string[];
export declare function checkUnpackedSize(unpackedBytes: number): string | null;
