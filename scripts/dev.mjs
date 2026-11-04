import { spawn } from "node:child_process";
import { createServer } from "vite";
import electron from "electron";

await import("./build-electron.mjs");
const server = await createServer();
await server.listen();
let child;
let stopping = false;
function launch() {
  child = spawn(electron, ["."], {
    stdio: "inherit",
    env: { ...process.env, FREEBO_DEV_URL: "http://127.0.0.1:5173" },
  });
  child.on("exit", async (code) => {
    if (code === 42 && !stopping) {
      launch();
      return;
    }
    await server.close();
    process.exit(code ?? 0);
  });
}
launch();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  stopping = true;
  child.kill(signal);
});
