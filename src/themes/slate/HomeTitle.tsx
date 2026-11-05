import type { ReactNode } from "react";

export function SlateHomeTitle({ children }: { children: ReactNode }) {
  return <h1 className="slate-home-title">{children}</h1>;
}
