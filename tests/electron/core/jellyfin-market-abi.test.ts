import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  catalogSchema,
  copyRecommendedConfiguration,
} from "../../../electron/core/jellyfin-plugin-files";
import {
  compatible,
  selectCatalogBuilds,
  JellyfinPluginManager,
} from "../../../electron/core/jellyfin-plugins";
import type { Server } from "../../../src/shared/types";
const resources = join(process.cwd(), "resources/jellyfin-plugins");
const catalog = catalogSchema.parse(
  JSON.parse(readFileSync(join(resources, "catalog.json"), "utf8")),
).plugins;

describe("bundled Jellyfin ABI selection", () => {
  for (const server of ["10.11.11.0", "12.4.0.0"]) {
    it(`selects seven complete, distinct builds for ${server}`, () => {
      const selected = selectCatalogBuilds(catalog, server);
      expect(selected).toHaveLength(7);
      expect(new Set(selected.map((p) => p.id)).size).toBe(7);
      for (const p of selected) {
        expect(compatible(server, p.targetAbi)).toBe(true);
        for (const dependency of p.dependencies)
          expect(selected.some((p) => p.id === dependency)).toBe(true);
      }
    });
  }
  it("rejects other ABI lines and future minimum versions", () => {
    expect(compatible("10.11.11.0", "12.0.0.0")).toBe(false);
    expect(compatible("12.4.0.0", "10.11.11.0")).toBe(false);
    expect(compatible("12.4.0.0", "12.5.0.0")).toBe(false);
    expect(
      selectCatalogBuilds(catalog, "13.0.0.0").every((p) => !compatible("13.0.0.0", p.targetAbi)),
    ).toBe(true);
  });
  it("chooses the newest compatible plugin release then ABI deterministically", () => {
    const base = catalog[0];
    const older = { ...base, targetAbi: "12.0.0.0", version: "1.0.0.0", folder: "a" };
    const newer = { ...older, version: "2.0.0.0", folder: "b" };
    const abi = { ...newer, targetAbi: "12.4.0.0", folder: "c" };
    for (const candidates of [
      [older, newer, abi],
      [abi, newer, older],
    ])
      expect(selectCatalogBuilds(candidates, "12.4.0.0")).toEqual([abi]);
  });
  it("keeps official names while retaining Chinese descriptions and separate configurations", () => {
    for (const p of catalog) {
      expect(p.name).toBe(p.nameEn);
      expect(p.name).toMatch(/^[A-Za-z ]+$/);
      expect(p.description).toMatch(/[\u4e00-\u9fff]/);
    }
    expect(new Set(catalog.map((p) => p.folder)).size).toBe(catalog.length);
  });
  it("uses build-specific verified defaults and preserves an existing user configuration", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "freebo-config-test-"));
    try {
      const plugins = join(temporary, "plugins");
      await mkdir(plugins);
      const old = catalog.find(
        (p) => p.name === "Home Screen Sections" && p.targetAbi.startsWith("10."),
      )!;
      const modern = catalog.find(
        (p) => p.name === "Home Screen Sections" && p.targetAbi.startsWith("12."),
      )!;
      await copyRecommendedConfiguration(resources, plugins, old);
      const target = join(plugins, "configurations", old.recommendedConfiguration!.filename);
      expect(await readFile(target, "utf8")).toBe(
        await readFile(
          join(
            resources,
            "recommended-configurations",
            old.folder,
            old.recommendedConfiguration!.filename,
          ),
          "utf8",
        ),
      );
      await writeFile(target, "existing-user-customization");
      await copyRecommendedConfiguration(resources, plugins, modern);
      expect(await readFile(target, "utf8")).toBe("existing-user-customization");
      // Exercise each 12.x default independently, rather than accidentally sharing the old asset path.
      for (const p of catalog.filter(
        (p) => p.targetAbi.startsWith("12.") && p.recommendedConfiguration,
      )) {
        const isolated = join(temporary, p.folder, "plugins");
        await mkdir(isolated, { recursive: true });
        await copyRecommendedConfiguration(resources, isolated, p);
        expect(
          await readFile(
            join(isolated, "configurations", p.recommendedConfiguration!.filename),
            "utf8",
          ),
        ).toBe(
          await readFile(
            join(
              resources,
              "recommended-configurations",
              p.folder,
              p.recommendedConfiguration!.filename,
            ),
            "utf8",
          ),
        );
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
  it("shows one unavailable entry per GUID while the server is unreachable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "freebo-market-offline-"));
    try {
      const manager = new JellyfinPluginManager(
        { resources, journal: join(directory, "journal.json") },
        () => async () => {
          throw new Error("offline fixture");
        },
        async () => undefined,
        () => false,
        async () => undefined,
        () => true,
        () => {},
      );
      const state = await manager.run({ id: "fixture", url: "http://fixture.invalid" } as Server, {
        type: "get",
      });
      expect(state.access).toBe("unreachable");
      expect(state.plugins).toHaveLength(7);
      expect(new Set(state.plugins.map((p) => p.id)).size).toBe(7);
      expect(state.plugins.every((p) => !p.compatible && p.installation === null)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("does not accept an active dependency built for the wrong ABI with the same plugin version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "freebo-market-test-"));
    try {
      const info = { Id: "fixture", Version: "12.4.0", ProductName: "Jellyfin Server" };
      const fetcher = async (url: string) => {
        const path = new URL(url).pathname;
        const body =
          path === "/Plugins"
            ? [
                {
                  Id: "5e87cc92-571a-4d8d-8d98-d2d4147f9f90",
                  Version: "3.0.3.0",
                  Status: "Active",
                  TargetAbi: "10.11.11.0",
                },
                {
                  Id: "5b6550fa-a014-4f4c-8a2c-59a43680ac6d",
                  Version: "3.0.3.0",
                  Status: "Active",
                  TargetAbi: "12.0.0.0",
                },
              ]
            : path.startsWith("/System/Info")
              ? info
              : [];
        return new Response(JSON.stringify(body));
      };
      const manager = new JellyfinPluginManager(
        { resources, journal: join(directory, "journal.json") },
        () => fetcher,
        async () => "fixture-token",
        () => false,
        async () => undefined,
        () => true,
        () => {},
      );
      const server = { id: "fixture", url: "http://fixture.invalid" } as Server;
      const state = await manager.run(server, { type: "get" });
      expect(state.access).toBe("admin");
      const hss = state.plugins.find((p) => p.name === "Home Screen Sections")!;
      expect(hss.missingDependencies.map((p) => p.name)).toEqual(["File Transformation"]);
      expect(hss.availableBuilds).toHaveLength(2);
      expect(hss.compatible).toBe(true);
      expect(hss.targetAbi).toBe("12.4.0.0");
      expect(hss.installation).toBe(null);
      expect((await manager.run(server, { type: "install", pluginId: hss.id })).error).toBe(
        "not-available",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
