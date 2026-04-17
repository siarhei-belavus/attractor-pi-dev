import { afterEach, describe, expect, it, vi } from "vitest";

type ProviderProfileModule = typeof import("../src/provider-profile.js");
type GetModel = typeof import("@mariozechner/pi-ai").getModel;

const cwd = process.cwd();

const builderCases = [
  {
    name: "OpenAI",
    exportName: "createOpenAIProfile",
    provider: "openai-codex",
    modelId: "missing-openai-model",
  },
  {
    name: "Anthropic",
    exportName: "createAnthropicProfile",
    provider: "anthropic",
    modelId: "missing-anthropic-model",
  },
  {
    name: "Gemini",
    exportName: "createGeminiProfile",
    provider: "google",
    modelId: "missing-gemini-model",
  },
] as const;

function missingModelMessage(provider: string, modelId: string, detail?: string): string {
  return `Requested Pi provider/model could not be resolved: provider="${provider}" model="${modelId}". This pair is unavailable in the active Pi model registry. Check the requested values and ensure @mariozechner/pi-ai, @mariozechner/pi-agent-core, and @mariozechner/pi-coding-agent are synchronized to the same release.${detail ? ` Upstream lookup error: ${detail}` : ""}`;
}

async function importProviderProfileModule(): Promise<ProviderProfileModule> {
  vi.resetModules();
  vi.doUnmock("@mariozechner/pi-ai");
  return import("../src/provider-profile.js");
}

async function importProviderProfileWithMock(
  implementation: GetModel,
): Promise<{
  module: ProviderProfileModule;
  getModelMock: ReturnType<typeof vi.fn<GetModel>>;
}> {
  vi.resetModules();
  vi.doMock("@mariozechner/pi-ai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
    return {
      ...actual,
      getModel: vi.fn<GetModel>(implementation),
    };
  });

  const module = await import("../src/provider-profile.js");
  const piAi = await import("@mariozechner/pi-ai");

  return {
    module,
    getModelMock: piAi.getModel as ReturnType<typeof vi.fn<GetModel>>,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@mariozechner/pi-ai");
});

describe("provider profile model resolution", () => {
  it("resolves openai-codex / gpt-5.4 from the synchronized Pi registry", async () => {
    const { createOpenAIProfile } = await importProviderProfileModule();

    const profile = createOpenAIProfile({
      cwd,
      provider: "openai-codex",
      modelId: "gpt-5.4",
    });

    expect(profile.contextWindowSize).toBeGreaterThan(0);
    expect(profile.model).toBeDefined();
  });

  it.each(builderCases)(
    "fails fast without fallback when lookup returns undefined for $name",
    async ({ exportName, provider, modelId }) => {
      const { module, getModelMock } = await importProviderProfileWithMock(
        ((requestedProvider: string, requestedModelId: string) => {
          expect(requestedProvider).toBe(provider);
          expect(requestedModelId).toBe(modelId);
          return undefined as never;
        }) as GetModel,
      );

      const createProfile = module[exportName] as (
        opts: { cwd: string; provider: string; modelId: string },
      ) => unknown;

      expect(() => createProfile({ cwd, provider, modelId })).toThrowError(
        missingModelMessage(provider, modelId),
      );
      expect(getModelMock).toHaveBeenCalledTimes(1);
      expect(getModelMock).toHaveBeenCalledWith(provider, modelId);
    },
  );

  it.each(builderCases)(
    "fails fast without fallback when lookup throws for $name",
    async ({ exportName, provider, modelId }) => {
      const upstreamDetail = `upstream miss for ${provider}/${modelId}`;
      const { module, getModelMock } = await importProviderProfileWithMock(
        ((requestedProvider: string, requestedModelId: string) => {
          expect(requestedProvider).toBe(provider);
          expect(requestedModelId).toBe(modelId);
          throw new Error(upstreamDetail);
        }) as GetModel,
      );

      const createProfile = module[exportName] as (
        opts: { cwd: string; provider: string; modelId: string },
      ) => unknown;

      expect(() => createProfile({ cwd, provider, modelId })).toThrowError(
        missingModelMessage(provider, modelId, upstreamDetail),
      );
      expect(getModelMock).toHaveBeenCalledTimes(1);
      expect(getModelMock).toHaveBeenCalledWith(provider, modelId);
    },
  );
});
