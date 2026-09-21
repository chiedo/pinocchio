import { z } from "zod";
import type { BindingReference } from "./binding-registry.js";
import { loadBinding } from "./binding-registry.js";
import { activeIndex, retrievalMode, semanticConfig, semanticFailure } from "./semantic-files.js";
import { rebuildIndex } from "./semantic-index.js";
import { SemanticProcess } from "./semantic-process.js";
import { candidateSchema } from "./semantic-types.js";
import type { RetrievalState, SemanticCandidate } from "./semantic-types.js";

export class SemanticRuntime {
  constructor(readonly autoBuild = true) {}
  #engines = new Map<string, SemanticProcess>();
  #started = new Map<string, number>();
  #building = new Map<string, Promise<unknown>>();
  #lastBuild = new Map<string, number>();
  #maintenance = new Map<string, string>();
  async candidates(reference: BindingReference, query: string, deadline = Date.now() + 800):
    Promise<{ candidates?: SemanticCandidate[]; retrieval: RetrievalState }> {
    await loadBinding(reference);
    try {
      if (await retrievalMode(reference) === "keyword") {
        return { retrieval: { mode: "keyword", reason: "KEYWORD_ONLY_CONFIGURED" } };
      }
      const config = await semanticConfig(reference.configRoot);
      const key = JSON.stringify(config);
      let engine = this.#engines.get(key);
      if (engine && engine.state !== "ready" && engine.state !== "SEMANTIC_WARMING" &&
          Date.now() - (this.#started.get(key) ?? 0) > 5_000) {
        engine.close(); engine = undefined;
      }
      if (!engine) {
        engine = new SemanticProcess(config); this.#engines.set(key, engine); this.#started.set(key, Date.now());
      }
      const buildKey = `${reference.configRoot}:${reference.bindingId}`;
      if (this.autoBuild && !this.#building.has(buildKey) && Date.now() - (this.#lastBuild.get(buildKey) ?? 0) > 30_000) {
        this.#lastBuild.set(buildKey, Date.now());
        const building = rebuildIndex(reference).then(() => { this.#maintenance.set(buildKey, "current"); },
          (error: unknown) => { this.#maintenance.set(buildKey, semanticFailure(error)); })
          .finally(() => this.#building.delete(buildKey));
        this.#building.set(buildKey, building);
      }
      const maintenance = this.#building.has(buildKey) ? "building" : this.#maintenance.get(buildKey);
      if (engine.state !== "ready") return { retrieval: { mode: "keyword", reason: engine.state,
        ...(maintenance ? { maintenance } : {}) } };
      const active = await activeIndex(reference);
      const remaining = Math.min(250, deadline - Date.now() - 150);
      if (remaining < 1) return { retrieval: { mode: "keyword", reason: "SEMANTIC_DEADLINE_RESERVE" } };
      const response = z.object({ candidates: z.array(candidateSchema).max(50) }).parse(await engine.call({
        action: "search", path: active.path, sha256: active.manifest.indexHash, records: active.manifest.records, query,
      }, remaining));
      return { candidates: response.candidates, retrieval: {
        mode: "hybrid", generation: active.manifest.generation, ...(maintenance ? { maintenance } : {}),
      } };
    } catch (error) {
      return { retrieval: { mode: "keyword", reason: semanticFailure(error) } };
    }
  }
  async warm(reference: BindingReference) {
    if (await retrievalMode(reference) === "keyword") return;
    const config = await semanticConfig(reference.configRoot);
    const key = JSON.stringify(config);
    let engine = this.#engines.get(key);
    if (!engine) { engine = new SemanticProcess(config); this.#engines.set(key, engine); }
    await engine.ready();
  }
  async close() {
    for (const engine of this.#engines.values()) engine.close();
    this.#engines.clear();
    await Promise.all(this.#building.values());
  }
}
