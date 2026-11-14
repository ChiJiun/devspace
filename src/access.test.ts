import assert from "node:assert/strict";
import {
  allowsShell,
  allowsWorktrees,
  allowsWrites,
  describeAccessMode,
  parseAccessMode,
} from "./access.js";

assert.equal(parseAccessMode(undefined), "full");
assert.equal(parseAccessMode(""), "full");
assert.equal(parseAccessMode("  READONLY "), "readonly");
assert.equal(parseAccessMode("no-shell"), "no-shell");
assert.throws(() => parseAccessMode("admin"), /Invalid DEVSPACE_ACCESS/);

assert.deepEqual(
  (["full", "no-shell", "readonly"] as const).map((mode) => [
    allowsWrites(mode),
    allowsShell(mode),
    allowsWorktrees(mode),
  ]),
  [
    [true, true, true],
    [true, false, true],
    [false, false, false],
  ],
);

assert.equal(describeAccessMode("full"), undefined);
assert.match(describeAccessMode("readonly") ?? "", /read-only/);
assert.match(describeAccessMode("no-shell") ?? "", /no shell/);
