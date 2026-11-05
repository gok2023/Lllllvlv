import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const statisticsHtml = fileURLToPath(new URL("./web/统计页面.html", import.meta.url));
const statisticsScript = fileURLToPath(new URL("./web/watch-statistics.js", import.meta.url));
const statisticsThemeStyle = fileURLToPath(
  new URL("./web/elysium-statistics.css", import.meta.url),
);
const statisticsNames = fileURLToPath(new URL("./web/director-map.js", import.meta.url));
const statisticsGenres = fileURLToPath(new URL("./web/genre-map.js", import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "watch-statistics-page",
      configureServer(server) {
        server.middlewares.use("/watch-statistics.html", (_request, response) => {
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(readFileSync(statisticsHtml));
        });
        server.middlewares.use("/watch-statistics.js", (_request, response) => {
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.end(readFileSync(statisticsScript));
        });
        server.middlewares.use("/elysium-statistics.css", (_request, response) => {
          response.setHeader("Content-Type", "text/css; charset=utf-8");
          response.end(readFileSync(statisticsThemeStyle));
        });
        server.middlewares.use("/director-map.js", (_request, response) => {
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.end(readFileSync(statisticsNames));
        });
        server.middlewares.use("/genre-map.js", (_request, response) => {
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.end(readFileSync(statisticsGenres));
        });
      },
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "watch-statistics.html",
          source: readFileSync(statisticsHtml),
        });
        this.emitFile({
          type: "asset",
          fileName: "watch-statistics.js",
          source: readFileSync(statisticsScript),
        });
        this.emitFile({
          type: "asset",
          fileName: "elysium-statistics.css",
          source: readFileSync(statisticsThemeStyle),
        });
        this.emitFile({
          type: "asset",
          fileName: "director-map.js",
          source: readFileSync(statisticsNames),
        });
        this.emitFile({
          type: "asset",
          fileName: "genre-map.js",
          source: readFileSync(statisticsGenres),
        });
      },
    },
    {
      name: "development-csp",
      apply: "serve",
      transformIndexHtml: (html) =>
        html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*\/>/, ""),
    },
  ],
  base: "./",
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
