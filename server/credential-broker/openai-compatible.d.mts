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
