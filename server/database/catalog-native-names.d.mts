export const englishNativeCountries: Set<string>;
export function diacriticsOnly(native: string, name: string): boolean;
export function nativeNameMatches(left: string, right: string, options?: { exact?: boolean }): boolean;
export const catalogNativeCorrections: { regions: Record<string, string>; cities: Record<string, string> };
export function correctedNativeName(kind: 'regions' | 'cities', id: string | number, native: string): string;
