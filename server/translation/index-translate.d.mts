export interface IndexTranslateSettings { enabled: boolean; concurrency: number; baseUrl: string; model: string }
export const INDEX_TRANSLATE_DEFAULTS: Readonly<IndexTranslateSettings>;
export function normalizeIndexTranslateSettings(input?: unknown, current?: IndexTranslateSettings): IndexTranslateSettings;
export function indexTranslatePrompt(values: string[], target: string): string;
export function parseIndexTranslateResponse(content: unknown, count: number): string[] | null;
export function indexTranslate(values: string[], target: string, settings?: IndexTranslateSettings, fetchImpl?: typeof fetch, signal?: AbortSignal): Promise<string[] | null>;
export const INDEX_TRANSLATE_SETTINGS_KEY: string;
export function readIndexTranslateSettings(database: { prepare(sql: string): any }): Promise<IndexTranslateSettings>;
