import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import type { Model, ProviderStreams } from "@earendil-works/pi-ai";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Config } from "./config.ts";

// Pi still owns generation and recovery; only provider requests share one slot.
export function singleStream(api: ProviderStreams): ProviderStreams {
  let tail = Promise.resolve();
  const wrap = (start: ProviderStreams["stream"]): ProviderStreams["stream"] =>
    (model, context, options) => {
      const previous = tail;
      const stream = lazyStream(model, async () => {
        await awaitWithContext(previous, options?.signal
          ? withAbortSignal(options.signal, BACKGROUND_CONTEXT)
          : BACKGROUND_CONTEXT);
        return start(model, context, options);
      });
      // An aborted queued request must still wait its turn before releasing the slot.
      tail = previous.then(() => stream.result()).then(() => {});
      return stream;
    };
  return { stream: wrap(api.stream), streamSimple: wrap(api.streamSimple) };
}

export async function localModels(config: Config) {
  const api = openAICompletionsApi();
  const describe = (id: string, vision = false): Model<"openai-completions"> => ({
    id,
    name: id,
    provider: "local",
    api: "openai-completions",
    baseUrl: config.baseUrl,
    reasoning: true,
    // The endpoint's chat template must support these reasoning levels.
    thinkingLevelMap: {
      off: "none", minimal: null, low: "low", medium: "medium",
      high: null, xhigh: "xhigh", max: null,
    },
    input: vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      thinkingTokenBudgetField: "thinking_budget_tokens",
      supportsStore: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "chat-template",
      chatTemplateKwargs: {
        enable_thinking: { $var: "thinking.enabled" },
        reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
      },
    },
  });
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "local",
      name: "llama.cpp",
      baseUrl: config.baseUrl,
      auth: {
        apiKey: {
          name: "Local server",
          resolve: async () => ({ auth: { apiKey: config.apiKey || "local" } }),
        },
      },
      models: [],
      fetchModels: async ({ signal }) => {
        try {
          const response = await fetch(config.baseUrl + "/models", {
            headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
            signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json() as { data?: { id?: unknown }[] };
          const ids = data.data?.map((model) => model.id)
            .filter((id): id is string => typeof id === "string" && id.length > 0);
          if (!ids?.length) throw new Error("No models advertised");
          let vision = false;
          try {
            const props = await fetch(new URL("/props", config.baseUrl), {
              headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
              signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
            });
            if (props.ok) vision = (await props.json() as { modalities?: { vision?: boolean } }).modalities?.vision === true;
          } catch { /* Older llama.cpp servers may not expose modalities. */ }
          return [...new Set(ids)].map((id) => describe(id, vision));
        } catch (error) {
          if (signal.aborted) throw error;
          console.warn("llama.cpp model discovery unavailable; using LLM_MODEL.");
          return [describe(config.modelId)];
        }
      },
      api: singleStream({
        ...api,
        streamSimple: (model, context, options) => api.streamSimple(model, context, {
          ...options,
          thinkingBudgets: { low: 512, medium: 2048, high: 6144, ...options?.thinkingBudgets },
        }),
      }),
    }),
  );
  await models.refresh({ providers: ["local"] });
  return models;
}
