import { spawn } from "node:child_process";
import { createServer } from "vite";
import electron from "electron";

await import("./build-electron.mjs");

async function listen(serverOptions = {}) {
  const server = await createServer({ server: serverOptions });
  try {
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error("Vite did not report a local development URL");
    return { server, url };
  } catch (error) {
    await server.close();
    throw error;
  }
}

const { server, url } = await listen().catch((error) => {
  if (
    error.code !== "EADDRINUSE" &&
    !(error.code === "EACCES" && error.syscall === "listen") &&
    !/^Port \d+ is already in use$/.test(error.message)
  ) {
    throw error;
  }
  console.warn(`[freebo] ${error.message}. Asking the OS for an available port.`);
  return listen({ port: 0 });
});
console.log(`[freebo] Vite listening at ${url}`);

let child;
let stopping = false;
function launch() {
  child = spawn(electron, ["."], {
    stdio: "inherit",
    env: { ...process.env, FREEBO_DEV_URL: url },
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
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
    child.kill(signal);
  });
