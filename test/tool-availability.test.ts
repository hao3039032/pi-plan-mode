import assert from "node:assert/strict";
import { test } from "vitest";
import { planModeToolAvailability } from "../src/tool-availability.js";
import { classifyPlanModeTool, isBuiltinTool } from "../src/tool-policy.js";
import {
  filterAvailableSelectedToolNames,
  planModeToolSelection,
} from "../src/tool-selection.js";
import { builtinExtensionTool, builtinTool, extensionTool, nativeTool } from "./tool-exposure-support.js";

const active = (names: string[]) => new Set(names);

test("planModeToolAvailability covers the direct/model-only/codemode/deferred matrix", () => {
  const exposures = ["direct", "model-only", "codemode", "deferred", "hidden", undefined] as const;
  const routes = ["selection", "model", "nested"] as const;
  const expectedInactive: Record<string, Record<string, string>> = {
    direct: { selection: "inactive", model: "inactive", nested: "inactive" },
    "model-only": { selection: "inactive", model: "inactive", nested: "model-only" },
    codemode: { selection: "available", model: "inactive", nested: "available" },
    deferred: { selection: "available", model: "inactive", nested: "available" },
    hidden: { selection: "hidden", model: "hidden", nested: "hidden" },
    undefined: { selection: "inactive", model: "inactive", nested: "inactive" },
  };
  // Availability when the tool IS active: model-only tools can never be called by other tools,
  // and hidden tools are never callable, activation notwithstanding.
  const expectedActive: Record<string, Record<string, string>> = {
    direct: { selection: "available", model: "available", nested: "available" },
    "model-only": { selection: "available", model: "available", nested: "model-only" },
    codemode: { selection: "available", model: "available", nested: "available" },
    deferred: { selection: "available", model: "available", nested: "available" },
    hidden: { selection: "hidden", model: "hidden", nested: "hidden" },
    undefined: { selection: "available", model: "available", nested: "available" },
  };
  for (const exposure of exposures) {
    for (const route of routes) {
      const tool = nativeTool({ name: "probe", exposure });
      assert.equal(
        planModeToolAvailability(tool, active(["probe"]), route),
        expectedActive[String(exposure)][route],
        `${exposure}/${route}: active expectation`,
      );
      assert.equal(
        planModeToolAvailability(tool, active([]), route),
        expectedInactive[String(exposure)][route],
        `${exposure}/${route}: inactive expectation`,
      );
    }
  }
  assert.equal(
    planModeToolAvailability(nativeTool({ name: "probe", exposure: "future" as never }), active([]), "model"),
    "unsupported",
  );
});

test("core built-ins keep their classification; built-in extension tools take the annotation path", () => {
  assert.equal(isBuiltinTool(builtinTool("read")), true);
  assert.equal(classifyPlanModeTool(builtinTool("read")), "read-only");
  assert.equal(classifyPlanModeTool(builtinTool("bash")), "sandboxed");
  assert.equal(classifyPlanModeTool(builtinTool("edit")), "blocked");
  assert.equal(classifyPlanModeTool(builtinTool("write")), "blocked");
  assert.equal(classifyPlanModeTool(builtinTool("powershell")), "blocked");
  assert.equal(classifyPlanModeTool(builtinTool("update_plan")), "blocked");

  const mcp = builtinExtensionTool("mcp__server__tool");
  assert.equal(isBuiltinTool(mcp), false);
  assert.equal(classifyPlanModeTool({ ...mcp, annotations: { readOnlyHint: true } }), "read-only");
  assert.equal(classifyPlanModeTool({ ...mcp, annotations: {} }), "user-opt-in");
  assert.equal(classifyPlanModeTool(mcp), "user-opt-in");

  // Older Pi shipped core built-ins without a path.
  assert.equal(isBuiltinTool(nativeTool({ name: "read", source: "builtin", path: "" })), true);
  // Missing policy metadata fails closed.
  assert.equal(classifyPlanModeTool({ ...builtinTool("read"), sourceInfo: { ...builtinTool("read").sourceInfo, source: "" } }), "blocked");
});

test("extension tools without annotations stay explicit opt-in; read-only hints stay automatic", () => {
  assert.equal(classifyPlanModeTool(extensionTool("web_search")), "user-opt-in");
  assert.equal(
    classifyPlanModeTool(extensionTool("web_search", { readOnlyHint: true, destructiveHint: false })),
    "read-only",
  );
  assert.equal(
    classifyPlanModeTool(extensionTool("web_search", { readOnlyHint: true, destructiveHint: true })),
    "user-opt-in",
  );
});

test("planModeToolSelection renders labels, guidance, and exposure notes for untrusted names", () => {
  const inactiveGrep = planModeToolSelection(builtinTool("grep"), active([]), false);
  assert.match(inactiveGrep.label, /^grep — inactive in Pi$/u);
  assert.ok(inactiveGrep.disabled);
  assert.match(inactiveGrep.disabledReason ?? "", /'grep'/u);
  assert.match(inactiveGrep.disabledReason ?? "", /defaultTools/u);
  assert.match(inactiveGrep.disabledReason ?? "", /full list/u);
  assert.match(inactiveGrep.disabledReason ?? "", /preserve existing\/default tools/u);
  assert.match(inactiveGrep.disabledReason ?? "", /restart Pi/u);
  assert.ok(!inactiveGrep.disabledReason?.includes("settings.json"));
  assert.ok(!inactiveGrep.disabledReason?.includes("+grep"));

  const blockedEdit = planModeToolSelection(builtinTool("edit"), active(["edit"]), false);
  assert.match(blockedEdit.label, /^edit — blocked by Plan policy$/u);
  const inactiveEdit = planModeToolSelection(builtinTool("edit"), active([]), false);
  assert.match(inactiveEdit.label, /^edit — blocked by Plan policy$/u);
  assert.match(inactiveEdit.disabledReason ?? "", /Blocked by Plan-mode policy/u);

  const codemode = planModeToolSelection(
    builtinExtensionTool("mcp__x__y", { exposure: "codemode", readOnlyHint: true }),
    active([]),
    false,
  );
  assert.ok(codemode.description.includes("callable via other tools"));
  assert.ok(!codemode.disabled);

  const modelOnly = planModeToolSelection(
    builtinExtensionTool("internal_probe", { exposure: "model-only", readOnlyHint: true }),
    active(["internal_probe"]),
    false,
  );
  assert.ok(modelOnly.description.includes("model calls only"));

  // The input tool object is never mutated.
  const original = builtinTool("grep");
  const snapshot = JSON.stringify({ ...original, annotations: original.annotations });
  planModeToolSelection(original, active([]), false);
  assert.equal(JSON.stringify({ ...original, annotations: original.annotations }), snapshot);
});

test("planModeToolSelection sanitizes untrusted tool names and descriptions", () => {
  const hostile = builtinExtensionTool("mcp__evil\u202e-tool", {
    description: "evil \u001b]52;c;echo pwned\u0007 description",
  });
  const item = planModeToolSelection(hostile, active(["mcp__evil\u202e-tool"]), true);
  assert.ok(!item.label.includes("\u202e"));
  assert.ok(!item.description.includes("]52;c;"));
  assert.ok(item.label.includes("mcp__evil"));
});

test("filterAvailableSelectedToolNames keeps unactivated codemode tools and drops the rest", () => {
  const tools = [
    builtinTool("read"),
    builtinTool("write"),
    builtinExtensionTool("mcp__search__query", { exposure: "codemode", readOnlyHint: true }),
    extensionTool("web_search"),
  ];
  const kept = filterAvailableSelectedToolNames(
    ["read", "write", "mcp__search__query", "web_search", "missing"],
    tools,
    active(["read", "web_search"]),
  );
  assert.deepEqual(kept, ["read", "mcp__search__query", "web_search"]);
  const withoutActiveDirect = filterAvailableSelectedToolNames(
    ["read", "web_search", "mcp__search__query"],
    tools,
    active([]),
  );
  assert.deepEqual(withoutActiveDirect, ["mcp__search__query"]);
});
