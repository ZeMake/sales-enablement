import { describe, expect, it } from "vitest";
import { visibleCloserIds } from "../src/core/queries";

const p = (id: string, papeis: string[], gestores: string[] = []) => ({
  id, nome: id, papeis, gestores, aliases: [], whatsapp: null, slack: null, updated_at: "",
});
const all = [p("admin", ["admin", "gestor"]), p("g1", ["gestor"]), p("g2", ["gestor"]), p("ana", ["closer"], ["g1"]), p("bia", ["closer"], ["g2"]), p("cid", ["closer"], ["g1", "g2"])];

describe("visibleCloserIds (escopo por papel)", () => {
  it("admin vê todos", () => expect(visibleCloserIds({ id: "admin", papeis: ["admin", "gestor"] }, all)).toBe("todos"));
  it("gestor vê só o próprio time", () => expect(visibleCloserIds({ id: "g1", papeis: ["gestor"] }, all)).toEqual(["ana", "cid"]));
  it("closer vê só as próprias calls", () => expect(visibleCloserIds({ id: "bia", papeis: ["closer"] }, all)).toEqual(["bia"]));
  it("sem papel não vê nada", () => expect(visibleCloserIds({ id: "x", papeis: [] }, all)).toEqual([]));
});
