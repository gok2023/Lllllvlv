// Keep the historic entry point, but derive icons only from the personal master.
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "personal-icon.ps1")], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
