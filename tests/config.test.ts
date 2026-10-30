import fs from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config";
import { isActive, loadPlaybooks } from "../src/core/playbook";

// Garante que os YAMLs versionados continuam válidos (não usa dado de call).
describe("config/ versionada", () => {
  it("team.yaml e rules.yaml são válidos", () => {
    const cfg = loadConfig();
    expect(cfg.team.pessoas.some((p) => p.papeis.includes("closer"))).toBe(true);
  });
  it("todos os playbooks carregam e os ativos têm etapas com id único", () => {
    for (const p of loadPlaybooks().filter(isActive)) {
      const ids = p.etapas.map((e) => e.id);
      expect(new Set(ids).size, p.id).toBe(ids.length);
    }
  });
  it("products.yaml é YAML válido", () => {
    const p = parse(fs.readFileSync("config/products.yaml", "utf8"));
    expect(p.produtos.length).toBeGreaterThan(0);
  });
});
