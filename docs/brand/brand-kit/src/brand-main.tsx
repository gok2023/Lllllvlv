import React from "react";
import { createRoot } from "react-dom/client";
import { BrandKit } from "./BrandKit";
import "./style.css";
import "./brand-kit.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <aside
      style={{
        padding: "12px 20px",
        background: "#193c35",
        color: "#fff",
        fontFamily: "sans-serif",
        textAlign: "center",
      }}
    >
      Archived upstream Freebo brand kit. Current Lllllvlv branding is documented in the
      repository's docs/brand/README.md.
    </aside>
    <BrandKit />
  </React.StrictMode>,
);
