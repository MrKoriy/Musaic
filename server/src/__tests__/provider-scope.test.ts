import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  clearSoundCloudConfig,
  clearVkConfig,
  clearYandexConfig,
  getProviderConfig,
  getSoundCloudConfig,
  getVkConfig,
  getYandexConfig,
  getDb,
  setProviderConfig,
  setSoundCloudConfig,
  setVkConfig,
  setYandexConfig,
} from "../db/index.js";
import { runWithRequestUser } from "../utils/request-scope.js";
import { setupTestDb, teardownTestDb } from "./setup.js";

describe("provider configuration request scopes", () => {
  let previousSecret: string | undefined;

  beforeEach(() => {
    previousSecret = process.env.MUSAIC_SECRET_KEY;
    process.env.MUSAIC_SECRET_KEY = "provider-scope-test-secret";
    setupTestDb();
    getDb().prepare("INSERT INTO users (id, username, password_hash) VALUES ('scope-a', 'scope-a', 'test'), ('scope-b', 'scope-b', 'test')").run();
  });

  afterEach(() => {
    clearSoundCloudConfig();
    runWithRequestUser("scope-a", () => {
      clearVkConfig();
      clearYandexConfig();
    });
    runWithRequestUser("scope-b", () => {
      clearVkConfig();
      clearYandexConfig();
    });
    if (previousSecret === undefined) delete process.env.MUSAIC_SECRET_KEY;
    else process.env.MUSAIC_SECRET_KEY = previousSecret;
    teardownTestDb();
  });

  it("keeps VK and Yandex credentials isolated across concurrent request scopes", async () => {
    const [scopeA, scopeB] = await Promise.all([
      runWithRequestUser("scope-a", async () => {
        setVkConfig({ username: "A VK", token: "vk-token-a", tokenExpiry: 111 });
        setYandexConfig({ username: "A Yandex", token: "yandex-token-a" });
        await Promise.resolve();
        return { vk: getVkConfig(), yandex: getYandexConfig() };
      }),
      runWithRequestUser("scope-b", async () => {
        setVkConfig({ username: "B VK", token: "vk-token-b", tokenExpiry: 222 });
        setYandexConfig({ username: "B Yandex", token: "yandex-token-b" });
        await Promise.resolve();
        return { vk: getVkConfig(), yandex: getYandexConfig() };
      }),
    ]);

    expect(scopeA).toEqual({
      vk: { username: "A VK", token: "vk-token-a", tokenExpiry: 111 },
      yandex: { username: "A Yandex", token: "yandex-token-a" },
    });
    expect(scopeB).toEqual({
      vk: { username: "B VK", token: "vk-token-b", tokenExpiry: 222 },
      yandex: { username: "B Yandex", token: "yandex-token-b" },
    });

    const stored = getDb().prepare(
      "SELECT provider, key, value FROM provider_config WHERE provider LIKE 'vk:%' OR provider LIKE 'yandex:%' ORDER BY provider, key",
    ).all() as Array<{ provider: string; key: string; value: string }>;
    expect(stored).toHaveLength(10);
    expect(stored.filter((row) => row.key === "token").every((row) => !row.value.includes("token-"))).toBe(true);

    runWithRequestUser("scope-a", () => {
      clearVkConfig();
      clearYandexConfig();
    });
    expect(runWithRequestUser("scope-a", () => ({ vk: getVkConfig(), yandex: getYandexConfig() }))).toEqual({
      vk: { username: null, token: null, tokenExpiry: null },
      yandex: { username: null, token: null },
    });
    expect(runWithRequestUser("scope-b", () => ({ vk: getVkConfig(), yandex: getYandexConfig() }))).toEqual({
      vk: { username: "B VK", token: "vk-token-b", tokenExpiry: 222 },
      yandex: { username: "B Yandex", token: "yandex-token-b" },
    });
  });

  it("keeps global SoundCloud config available but does not leak global account config to multi-user requests", () => {
    setSoundCloudConfig({ clientId: "soundcloud-global", fetchedAt: 123 });
    expect(getSoundCloudConfig()).toEqual({ clientId: "soundcloud-global", clientIdFetchedAt: 123 });

    setProviderConfig("yandex", "region", "global-region");
    expect(getProviderConfig("yandex", "region")).toBe("global-region");
    expect(runWithRequestUser("scope-a", () => getProviderConfig("yandex", "region"))).toBeNull();
    expect(runWithRequestUser("scope-b", () => getYandexConfig())).toEqual({ username: null, token: null });

    runWithRequestUser(null, () => setYandexConfig({ username: "Global", token: "global-token" }));
    expect(getYandexConfig()).toEqual({ username: "Global", token: "global-token" });
    expect(runWithRequestUser("scope-a", () => getYandexConfig())).toEqual({ username: null, token: null });
  });
});
