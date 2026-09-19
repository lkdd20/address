import type { AddressComponents, Locale } from './types';

export const semanticAddressFields: ReadonlyArray<keyof AddressComponents>;
export function foreignAddressScriptPattern(locale: Locale): string;
export function componentLooksLocalized(text: string, locale: Locale): boolean;
export function storedVariantLooksLocalized(components: AddressComponents, locale: Locale): boolean;
export function preservesAddressNumbers(original: string, translated: string): boolean;
export function preservesAddressIdentifiers(original: string, translated: string): boolean;
export function normalizeAddressDigits(value: string): string;
