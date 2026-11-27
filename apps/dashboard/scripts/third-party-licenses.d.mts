// Types for third-party-licenses.mjs (used by vite.config.ts and src/test/thirdPartyLicenses.test.ts).
export declare function novncSourceUrl(version: string): string;
export declare function leadingComment(source: string): string;
export declare function collectLicenseFiles(projectDir: string): Record<string, string>;
