import assert from "node:assert/strict";
import test from "node:test";

import {
  clearScriptSourceIndex,
  getCachedScriptSourcesByScriptHash,
  getScriptSourceIndex,
  upsertScriptSources,
} from "../dist/bridge/handlers/shared/script-source-store.js";
import {
  clearDecompilerHealthForClient,
  getDecompilerHealthSnapshot,
  recordDecompilerProviderObservation,
  recordDecompilerProviderFailure,
  recordDecompilerProviderSuccess,
  shouldSkipDecompilerProvider,
} from "../dist/decompiler/health.js";
import { decompileBytecode, resolveDecompilerProviders } from "../dist/decompiler/run.js";
import {
  cleanupInactiveHttpClients,
  getClientById,
  registerClient,
  resetRegistry,
} from "../dist/bridge/handlers/shared/registry.js";
import {
  DEFAULT_DECOMPILER_SETTINGS,
  DEFAULT_DECOMPILER_RUNTIME_SETTINGS,
} from "../dist/decompiler/settings.js";
import {
  semanticIndexReadyMessage,
  semanticPartialIndexWarning,
} from "../dist/semantic/index-status.js";

function identity(name) {
  return { clientId: name, placeId: 1, jobId: "job" };
}

test("mapping revisions ignore stale progress without dropping source payloads", () => {
  const id = identity("revision-ordering");
  upsertScriptSources(id, {
    beginMappingSession: true,
    mappingSessionId: "session-a",
    mappingSessionStartedAt: 100,
    mappingRevision: 1,
    sourcesToMap: 2,
    processedSources: 0,
    hasFinishedMapping: false,
  });
  upsertScriptSources(id, {
    mappingSessionId: "session-a",
    mappingRevision: 3,
    sourcesToMap: 2,
    processedSources: 2,
    skippedSources: 1,
    hasFinishedMapping: true,
    scripts: [{ debugId: "one", path: "A", source: "return 1", scriptHash: "h1" }],
  });

  const stale = upsertScriptSources(id, {
    mappingSessionId: "session-a",
    mappingRevision: 2,
    sourcesToMap: 99,
    processedSources: 0,
    skippedSources: 0,
    hasFinishedMapping: false,
    scripts: [{ debugId: "two", path: "B", source: "return 2", scriptHash: "h2" }],
  });
  assert.equal(stale.acceptedMappingRevision, 3);

  const afterStale = getScriptSourceIndex(id);
  assert.equal(afterStale.scripts.length, 2, "stale metadata must not discard source data");
  assert.equal(afterStale.sourcesToMap, 2);
  assert.equal(afterStale.processedSources, 2);
  assert.equal(afterStale.skippedSources, 1);
  assert.equal(afterStale.hasFinishedMapping, true);

  const healed = upsertScriptSources(id, {
    mappingSessionId: "session-a",
    mappingRevision: 4,
    sourcesToMap: 2,
    processedSources: 2,
    skippedSources: 0,
    hasFinishedMapping: true,
  });
  assert.equal(healed.sourceGap, 0);
  assert.equal(healed.sourceIndexComplete, true);
  clearScriptSourceIndex(id.clientId);
});

test("a different mapping session cannot replace progress without an explicit begin", () => {
  const id = identity("session-handoff");
  upsertScriptSources(id, {
    beginMappingSession: true,
    mappingSessionId: "current",
    mappingSessionStartedAt: 200,
    mappingRevision: 1,
    sourcesToMap: 4,
    processedSources: 2,
  });

  const rejected = upsertScriptSources(id, {
    mappingSessionId: "other",
    mappingRevision: 10,
    sourcesToMap: 100,
    processedSources: 100,
    hasFinishedMapping: true,
  });
  assert.equal(rejected.acceptedMappingRevision, 1);
  assert.equal(getScriptSourceIndex(id).sourcesToMap, 4);

  const staleBegin = upsertScriptSources(id, {
    beginMappingSession: true,
    mappingSessionId: "older",
    mappingSessionStartedAt: 100,
    mappingRevision: 99,
    sourcesToMap: 999,
    processedSources: 999,
    hasFinishedMapping: true,
  });
  assert.equal(staleBegin.acceptedMappingRevision, 1);
  assert.equal(getScriptSourceIndex(id).sourcesToMap, 4);

  const equalTimestampBegin = upsertScriptSources(id, {
    beginMappingSession: true,
    mappingSessionId: "same-time-late",
    mappingSessionStartedAt: 200,
    mappingRevision: 100,
    sourcesToMap: 999,
    processedSources: 999,
    hasFinishedMapping: true,
  });
  assert.equal(equalTimestampBegin.acceptedMappingRevision, 1);
  assert.equal(getScriptSourceIndex(id).sourcesToMap, 4);

  const accepted = upsertScriptSources(id, {
    beginMappingSession: true,
    mappingSessionId: "other",
    mappingSessionStartedAt: 300,
    mappingRevision: 11,
    sourcesToMap: 0,
    processedSources: 0,
    hasFinishedMapping: true,
  });
  assert.equal(accepted.acceptedMappingRevision, 11);
  assert.equal(accepted.sourceIndexComplete, true, "a finished empty source set is complete");
  clearScriptSourceIndex(id.clientId);
});

test("script hash cache retains historical hashes and indexes replacements", () => {
  const id = identity("hash-index");
  upsertScriptSources(id, {
    scripts: [
      { debugId: "one", path: "A", source: "one", scriptHash: "shared" },
      { debugId: "two", path: "B", source: "two", scriptHash: "shared" },
    ],
  });
  assert.equal(getCachedScriptSourcesByScriptHash(id, ["shared"])[0]?.debugId, "two");

  upsertScriptSources(id, {
    scripts: [{ debugId: "two", path: "B", source: "changed", scriptHash: "other" }],
  });
  assert.equal(getCachedScriptSourcesByScriptHash(id, ["shared"])[0]?.debugId, "two");
  assert.equal(getCachedScriptSourcesByScriptHash(id, ["other"])[0]?.debugId, "two");
  clearScriptSourceIndex(id.clientId);
});

test("new mapping sessions retain hash cache entries without indexing stale scripts", () => {
  const id = identity("active-session-cache");
  upsertScriptSources(id, {
    beginMappingSession: true,
    mappingSessionId: "old",
    mappingSessionStartedAt: 100,
    mappingRevision: 1,
    sourcesToMap: 1,
    processedSources: 1,
    hasFinishedMapping: true,
    scripts: [{ debugId: "old-script", path: "Old", source: "old", scriptHash: "old-hash" }],
  });
  upsertScriptSources(id, {
    beginMappingSession: true,
    mappingSessionId: "new",
    mappingSessionStartedAt: 200,
    mappingRevision: 1,
    sourcesToMap: 1,
    processedSources: 1,
    hasFinishedMapping: true,
    scripts: [{ debugId: "new-script", path: "New", source: "new", scriptHash: "new-hash" }],
  });

  const current = getScriptSourceIndex(id);
  assert.deepEqual(current.scripts.map((script) => script.debugId), ["new-script"]);
  assert.equal(getCachedScriptSourcesByScriptHash(id, ["old-hash"])[0]?.debugId, "old-script");
  clearScriptSourceIndex(id.clientId);
});

test("revisioned tombstones remove active scripts and stale uploads cannot resurrect them", () => {
  const id = identity("script-removal-ordering");
  upsertScriptSources(id, {
    beginMappingSession: true,
    mappingSessionId: "session",
    mappingSessionStartedAt: 100,
    mappingRevision: 1,
    sourcesToMap: 1,
    processedSources: 1,
    scripts: [{ debugId: "gone", path: "Gone", source: "old", scriptHash: "gone-hash" }],
  });
  upsertScriptSources(id, {
    mappingSessionId: "session",
    mappingRevision: 3,
    sourcesToMap: 0,
    processedSources: 0,
    hasFinishedMapping: true,
    removedScriptIds: ["gone"],
  });
  upsertScriptSources(id, {
    mappingSessionId: "session",
    mappingRevision: 2,
    scripts: [{ debugId: "gone", path: "Gone", source: "late", scriptHash: "gone-hash" }],
  });

  const current = getScriptSourceIndex(id);
  assert.equal(current.scripts.length, 0);
  assert.equal(current.sourceIndexComplete, true);
  assert.equal(
    getCachedScriptSourcesByScriptHash(id, ["gone-hash"])[0]?.source,
    "late",
    "late payloads may refresh the reusable cache without rejoining the active index"
  );
  clearScriptSourceIndex(id.clientId);
});

test("stale source payloads can refresh cache without overwriting newer active source", () => {
  const id = identity("active-source-ordering");
  upsertScriptSources(id, {
    beginMappingSession: true,
    mappingSessionId: "session",
    mappingSessionStartedAt: 100,
    mappingRevision: 1,
    scripts: [{ debugId: "x", path: "X", source: "v1", scriptHash: "hash-v1" }],
  });
  upsertScriptSources(id, {
    mappingSessionId: "session",
    mappingRevision: 3,
    scripts: [{ debugId: "x", path: "X", source: "v3", scriptHash: "hash-v3" }],
  });
  upsertScriptSources(id, {
    mappingSessionId: "session",
    mappingRevision: 2,
    scripts: [{ debugId: "x", path: "X", source: "v2", scriptHash: "hash-v2" }],
  });

  assert.equal(getScriptSourceIndex(id).scripts[0]?.source, "v3");
  assert.equal(getCachedScriptSourcesByScriptHash(id, ["hash-v2"])[0]?.source, "v2");
  assert.equal(getCachedScriptSourcesByScriptHash(id, ["hash-v3"])[0]?.source, "v3");

  upsertScriptSources(id, {
    mappingSessionId: "session",
    scripts: [{ debugId: "x", path: "X", source: "invalid", scriptHash: "hash-invalid" }],
  });
  assert.equal(getScriptSourceIndex(id).scripts[0]?.source, "v3");
  assert.equal(
    getCachedScriptSourcesByScriptHash(id, ["hash-invalid"])[0]?.source,
    "invalid",
    "invalid revisions may populate reusable cache but cannot mutate active source"
  );
  clearScriptSourceIndex(id.clientId);
});

test("sustained fast successes remain healthy and cooldowns affect resolved plans", () => {
  for (let index = 0; index < 1000; index += 1) {
    recordDecompilerProviderSuccess(
      "konstant",
      108,
      DEFAULT_DECOMPILER_RUNTIME_SETTINGS,
      "health-test"
    );
  }
  assert.equal(getDecompilerHealthSnapshot().providers.konstant?.status, "healthy");

  recordDecompilerProviderFailure({
    id: "fission",
    errorMessage: "provider failed",
    runtime: DEFAULT_DECOMPILER_RUNTIME_SETTINGS,
    clientId: "health-test",
  });
  const settings = structuredClone(DEFAULT_DECOMPILER_SETTINGS);
  settings.providerOrder = ["fission", "builtin", "luaexpert", "shiny", "oracle", "konstant"];
  settings.providers.fission.enabled = true;
  assert.notEqual(
    resolveDecompilerProviders(settings, { clientId: "health-test" }).orderedProviders[0],
    "fission"
  );
});

test("an explicitly requested original provider stays first before ordered fallbacks", () => {
  const settings = structuredClone(DEFAULT_DECOMPILER_SETTINGS);
  settings.providerOrder = ["builtin", "luaexpert", "shiny", "oracle", "konstant", "fission"];
  for (const provider of Object.values(settings.providers)) provider.enabled = true;

  recordDecompilerProviderFailure({
    id: "oracle",
    errorMessage: "Timed out after 1s.",
    timedOut: true,
    runtime: settings.runtime,
    clientId: "provider-preference",
  });
  recordDecompilerProviderFailure({
    id: "oracle",
    errorMessage: "Timed out after 1s.",
    timedOut: true,
    runtime: settings.runtime,
    clientId: "provider-preference",
  });

  const ordinary = resolveDecompilerProviders(settings, {
    clientId: "provider-preference",
  });
  assert.equal(ordinary.orderedProviders.includes("oracle"), false, "oracle must actually be cooling down");

  const resolved = resolveDecompilerProviders(settings, {
    clientId: "provider-preference",
    requestedProvider: "oracle",
  });
  assert.deepEqual(resolved.orderedProviders, ["oracle", ...ordinary.orderedProviders]);
});

test("an unavailable built-in is not reported as an attempted retry provider", async () => {
  const settings = structuredClone(DEFAULT_DECOMPILER_SETTINGS);
  for (const [id, provider] of Object.entries(settings.providers)) {
    provider.enabled = id === "builtin";
  }
  const result = await decompileBytecode(settings, {
    bytecodeBase64: Buffer.from("bytecode").toString("base64"),
    builtinAvailable: false,
    requestedProvider: "builtin",
    clientId: "attempted-provider-contract",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.attemptedProviders, []);
});

test("a built-in handshake is reported as an attempted provider", async () => {
  const settings = structuredClone(DEFAULT_DECOMPILER_SETTINGS);
  for (const [id, provider] of Object.entries(settings.providers)) {
    provider.enabled = id === "builtin";
  }
  const result = await decompileBytecode(settings, {
    bytecodeBase64: Buffer.from("bytecode").toString("base64"),
    builtinAvailable: true,
    requestedProvider: "builtin",
    clientId: "attempted-builtin-handshake",
  });
  assert.equal(result.needsBuiltin, true);
  assert.deepEqual(result.attemptedProviders, ["builtin"]);
});

test("built-in health is client scoped and stale observations are rejected", () => {
  const runtime = DEFAULT_DECOMPILER_RUNTIME_SETTINGS;
  const failureAccepted = recordDecompilerProviderObservation({
    id: "builtin",
    clientId: "client-a",
    runtime,
    observationSessionId: "session-a",
    observationSessionStartedAt: 200,
    observationRevision: 2,
    beginObservationSession: true,
    latencyMs: 8000,
    errorMessage: "timed out",
    timedOut: true,
  });
  const staleSuccessAccepted = recordDecompilerProviderObservation({
    id: "builtin",
    clientId: "client-a",
    runtime,
    observationSessionId: "session-a",
    observationSessionStartedAt: 200,
    observationRevision: 1,
    beginObservationSession: true,
    latencyMs: 20,
    successCount: 1,
  });
  const revisionSeedAccepted = recordDecompilerProviderObservation({
    id: "builtin",
    clientId: "client-ordering",
    runtime,
    observationSessionId: "session-ordering",
    observationSessionStartedAt: 300,
    observationRevision: 1,
    beginObservationSession: true,
    latencyMs: 20,
    successCount: 1,
  });
  const invalidHighRevisionAccepted = recordDecompilerProviderObservation({
    id: "builtin",
    clientId: "client-ordering",
    runtime,
    observationSessionId: "session-ordering",
    observationSessionStartedAt: 300,
    observationRevision: 4,
    beginObservationSession: true,
    successCount: 0,
  });
  const validOlderRevisionAccepted = recordDecompilerProviderObservation({
    id: "builtin",
    clientId: "client-ordering",
    runtime,
    observationSessionId: "session-ordering",
    observationSessionStartedAt: 300,
    observationRevision: 3,
    beginObservationSession: true,
    latencyMs: 20,
    successCount: 1,
  });
  const otherClientAccepted = recordDecompilerProviderObservation({
    id: "builtin",
    clientId: "client-b",
    runtime,
    observationSessionId: "session-b",
    observationSessionStartedAt: 200,
    observationRevision: 1,
    beginObservationSession: true,
    latencyMs: 20,
    successCount: 1,
  });
  const equalTimestampSessionAccepted = recordDecompilerProviderObservation({
    id: "builtin",
    clientId: "client-a",
    runtime,
    observationSessionId: "session-equal-late",
    observationSessionStartedAt: 200,
    observationRevision: 99,
    beginObservationSession: true,
    latencyMs: 20,
    successCount: 1,
  });

  assert.equal(failureAccepted, true);
  assert.equal(staleSuccessAccepted, false);
  assert.equal(revisionSeedAccepted, true);
  assert.equal(invalidHighRevisionAccepted, false);
  assert.equal(validOlderRevisionAccepted, true, "rejected payloads must not consume revisions");
  assert.equal(otherClientAccepted, true);
  assert.equal(equalTimestampSessionAccepted, false);
  assert.equal(shouldSkipDecompilerProvider("builtin", runtime, "client-a").skip, false);
  assert.equal(shouldSkipDecompilerProvider("builtin", runtime, "client-b").skip, false);
  assert.equal(getDecompilerHealthSnapshot("client-a").providers.builtin?.status, "timing_out");
  assert.equal(getDecompilerHealthSnapshot("client-b").providers.builtin?.status, "healthy");

  recordDecompilerProviderFailure({
    id: "builtin",
    clientId: "client-a-cooldown",
    runtime,
    errorMessage: "failed",
  });
  assert.equal(shouldSkipDecompilerProvider("builtin", runtime, "client-a-cooldown").skip, true);
  assert.equal(shouldSkipDecompilerProvider("builtin", runtime, "client-b").skip, false);
  clearDecompilerHealthForClient("client-a");
  assert.equal(getDecompilerHealthSnapshot("client-a").providers.builtin, undefined);
});

test("expired HTTP clients release registry, source-index, and built-in health state", () => {
  resetRegistry();
  const clientId = registerClient({
    username: "test",
    userId: 1,
    placeId: 1,
    jobId: "job",
    placeName: "place",
    sessionId: "expired-session",
    transport: "http",
  });
  const client = getClientById(clientId);
  assert.ok(client);
  upsertScriptSources({ clientId, placeId: 1, jobId: "job" }, {
    scripts: [{ debugId: "x", path: "X", source: "return 1", scriptHash: "expired-hash" }],
  });
  recordDecompilerProviderSuccess("builtin", 10, DEFAULT_DECOMPILER_RUNTIME_SETTINGS, clientId);
  assert.ok(getDecompilerHealthSnapshot(clientId).providers.builtin);

  client.lastHttpPoll = 0;
  assert.equal(cleanupInactiveHttpClients(Date.now()), 1);
  assert.equal(getClientById(clientId), undefined);
  assert.equal(getDecompilerHealthSnapshot(clientId).providers.builtin, undefined);
  assert.equal(getScriptSourceIndex({ clientId, placeId: 1, jobId: "job" }).mappedSources, 0);
  resetRegistry();
});

test("semantic index status formatting uses the canonical completeness value", () => {
  const warning = semanticPartialIndexWarning({
    chunkCount: 10,
    embeddedChunks: 10,
    sourceIndexComplete: false,
  });
  assert.match(warning ?? "", /source sync is incomplete/i);

  assert.equal(
    semanticIndexReadyMessage(
      { chunkCount: 0, embeddedChunks: 0, sourceIndexComplete: true },
      { mappedSources: 0, sourcesToMap: 0, skippedSources: 0 }
    ),
    "Semantic index ready: 0/0 chunks embedded."
  );
});
