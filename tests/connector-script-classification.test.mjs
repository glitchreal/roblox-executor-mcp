import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const lifecyclePath = new URL("../connector-src/mapping/lifecycle.luau", import.meta.url);
const scriptHandlerPath = new URL(
  "../connector-src/bridge/handlers/scripts.luau",
  import.meta.url
);

test("script mapping distinguishes LocalScript from Script by exact class", async () => {
  const [lifecycle, scriptHandler] = await Promise.all([
    readFile(lifecyclePath, "utf8"),
    readFile(scriptHandlerPath, "utf8"),
  ]);

  assert.match(lifecycle, /script\.ClassName == "Script"/);
  assert.doesNotMatch(lifecycle, /script:IsA\("Script"\)/);
  assert.match(scriptHandler, /scriptInstance\.ClassName == "Script"/);
  assert.doesNotMatch(scriptHandler, /scriptInstance:IsA\("Script"\)/);
});
