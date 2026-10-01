export interface OpenAICompatibleSecret {
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort: string;
  maxTokens: number;
}

export declare const OPENAI_COMPATIBLE_PROVIDER: 'openai-compatible';
export declare const OPENAI_COMPATIBLE_DEFAULT_REASONING_EFFORT: 'low';
export declare const OPENAI_COMPATIBLE_DEFAULT_MAX_TOKENS: number;
export declare const OPENAI_COMPATIBLE_MAX_TOKENS: number;
export declare const OPENAI_COMPATIBLE_TARGETS: readonly string[];
export declare const normalizeOpenAICompatibleBaseUrl: (value: unknown) => string | null;
export declare const parseOpenAICompatibleSecret: (value: unknown) => OpenAICompatibleSecret | null;
export declare const serializeOpenAICompatibleSecret: (value: unknown) => string;
export declare const openAICompatibleConfigFromFields: (value: Partial<OpenAICompatibleSecret>) => string;
export declare const openAICompatibleRequest: (value: unknown, values: string[], target: string, options?: { prompt?: string }) => Request;
export declare const parseOpenAICompatibleResponse: (body: unknown, expectedLength: number) => string[] | null;
export interface OpenAICompatibleModel {
  id: string;
  ownedBy: string | null;
  supportedEndpoints?: string[];
  reasoningEfforts?: string[];
}
export declare const parseOpenAICompatibleModels: (body: unknown) => OpenAICompatibleModel[] | null;
export declare const fetchOpenAICompatibleModelCatalog: (value: unknown, fetchImpl?: typeof fetch, signal?: AbortSignal) => Promise<{ models: OpenAICompatibleModel[]; baseUrl: string }>;
export declare const fetchOpenAICompatibleModels: (value: unknown, fetchImpl?: typeof fetch, signal?: AbortSignal) => Promise<OpenAICompatibleModel[]>;
export declare const translateOpenAICompatible: (value: unknown, values: string[], target: string, fetchImpl?: typeof fetch, signal?: AbortSignal, options?: { prompt?: string }) => Promise<string[]>;
export declare const openAICompatibleChatUrl: (baseUrl: string) => string;
export declare const openAICompatibleResponseContent: (body: unknown) => string;
export declare const OPENAI_COMPATIBLE_DIAGNOSTIC_VALUES: readonly string[];
export declare const OPENAI_COMPATIBLE_TIMEOUT_MS: number;
export interface OpenAICompatibleDiagnosticStep { kind: 'info' | 'success' | 'error' | 'data'; key: string; detail?: string }
export interface OpenAICompatibleDiagnostic {
  success: boolean;
  outcome: 'success' | 'request' | 'qps' | 'quota' | 'auth' | 'network' | 'invalid';
  code?: string;
  steps: OpenAICompatibleDiagnosticStep[];
  translations?: string[];
}
export declare const diagnoseOpenAICompatible: (value: unknown, options?: { mode?: 'chat' | 'translate'; prompt?: string }, fetchImpl?: typeof fetch) => Promise<OpenAICompatibleDiagnostic>;
export declare const openAICompatibleBaseHasVersion: (baseUrl: string) => boolean;
export declare const resolveOpenAICompatibleBaseUrl: (value: unknown, fetchImpl?: typeof fetch) => Promise<string | null>;
