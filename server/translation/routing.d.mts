import type { Database } from '../database/database.mjs';

export type TranslationRouteProvider = 'openai-compatible' | 'deepl' | 'youdao' | 'google';

export interface TranslationRoute {
  id: string;
  provider: TranslationRouteProvider;
  credentialId: string | null;
  priority: number;
  enabled: boolean;
  prompt: string;
  status?: string;
  model?: string;
  updatedAt?: string;
}

export declare const TRANSLATION_ROUTE_PROVIDERS: readonly TranslationRouteProvider[];
export declare const OPENAI_TRANSLATION_ROUTE_PREFIX: 'openai:';
export declare const TRANSLATION_PROMPT_MAX_LENGTH: 4000;
export declare const TRANSLATION_PRIORITY_MIN: 1;
export declare const TRANSLATION_PRIORITY_MAX: 10000;
export declare const DEFAULT_TRANSLATION_ROUTE_PRIORITIES: Readonly<Record<TranslationRouteProvider, number>>;
export declare const translationRoutesSchema: string;
export declare const routeIdForCredential: (credentialId: string, provider?: string) => string;
export declare const translationRouteStatus: (status: string, cooldownUntil?: string | null, now?: Date | string) => string;
export declare const normalizeTranslationPrompt: (value: unknown) => string;
export declare const normalizeTranslationPriority: (value: unknown, fallback?: number) => number;
export declare const translationRouteRevision: (routes?: ReadonlyArray<TranslationRoute>) => string;
export declare const ensureTranslationRoutes: (database: Database, now?: Date | string | number) => Promise<void>;

export declare class TranslationRouteScheduler {
  order(routes?: ReadonlyArray<TranslationRoute>): TranslationRoute[];
}
