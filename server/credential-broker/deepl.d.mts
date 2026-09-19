import type { Database } from '../database/database.mjs';

export interface DeepLCharacterBudget {
  used: number; limit: number; remaining: number; providerUsed: number; providerLimit: number;
  observedAt: string | null; resetAt: string | null; unit: 'characters';
}
export function isDeepLFreeKey(value: unknown): boolean;
export function characterCount(values: string[]): number;
export function deepLBudgetStatus(database: Database): Promise<DeepLCharacterBudget>;
export const deeplBudgetSchema: string;
