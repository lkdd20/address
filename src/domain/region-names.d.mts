export declare const foldName: (value: string | null | undefined) => string;
export declare const nameVariants: (value: string | null | undefined) => Set<string>;
export declare const regionSpellingKey: (admin1: string) => string;
export declare const variantRegionIndex: <T extends { name: string; native_name: string; zh_name: string; code: string }, R>(
  regions: T[], rootOf: (region: T) => R) => (value: string | null | undefined) => R | undefined;
