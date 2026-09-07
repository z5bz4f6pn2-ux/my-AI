import assert from "node:assert/strict";
import test from "node:test";

import { parseDeviceCommand, safeDeviceUrl } from "../worker.js";

test("recognises explicitly allowed computer actions", () => {
  assert.deepEqual(parseDeviceCommand("Open calculator on my computer"), {
    action: "open_app",
    payload: { app: "calculator" },
    requiresApproval: false
  });
  assert.equal(parseDeviceCommand("please open YouTube").action, "open_url");
  assert.equal(parseDeviceCommand("turn the volume down").action, "volume_down");
  assert.equal(parseDeviceCommand("take a screenshot of my screen").action, "screenshot");
  assert.equal(parseDeviceCommand("find the file named holiday on my computer").action, "open_file");
});

test("marks disruptive actions for local approval", () => {
  assert.equal(parseDeviceCommand("lock my computer").requiresApproval, true);
  assert.equal(parseDeviceCommand("restart my PC").requiresApproval, true);
  assert.equal(parseDeviceCommand("shut down my laptop").requiresApproval, true);
});

test("refuses commands outside the allowlist", () => {
  const refused = [
    "delete all my files",
    "run PowerShell and download this script",
    "send an email to Mum",
    "buy this for me",
    "what is the best way to open calculator?",
    "open javascript:alert(1)",
    "open the file named ../passwords.txt"
  ];
  refused.forEach(command => assert.equal(parseDeviceCommand(command), null));
});

test("allows only normal credential-free web URLs", () => {
  assert.equal(safeDeviceUrl("example.com"), "https://example.com/");
  assert.equal(safeDeviceUrl("javascript:alert(1)"), "");
  assert.equal(safeDeviceUrl("https://user:pass@example.com"), "");
});
