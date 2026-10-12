import type { Database } from '../database/database.mjs';

export interface DeepLCharacterBudget {
  used: number; limit: number; remaining: number; providerUsed: number; providerLimit: number;
  observedAt: string | null; resetAt: string | null; unit: 'characters';
}
export function isDeepLFreeKey(value: unknown): boolean;
export function characterCount(values: string[]): number;
export function deepLBudgetStatus(database: Database, credentialId: string): Promise<DeepLCharacterBudget>;
export function deepLBudgetStatuses(database: Database): Promise<Map<string, DeepLCharacterBudget>>;
export function deepLBudgetExhausted(budget: DeepLCharacterBudget | undefined | null): boolean;
export function deepLBudgetRecheckAt(budget: DeepLCharacterBudget | undefined | null): string | null;
export const deeplBudgetSchema: string;
