import type { ReactNode } from "react";
import { resolveVisualTheme, type VisualThemeId } from "../shared/visual-themes";
import { SlateHomeTitle } from "./slate/HomeTitle";
import { ElysiumHomeLayout } from "./elysium/HomeLayout";

export interface ThemeSlots {
  HomeTitle?: ({ children }: { children: ReactNode }) => ReactNode;
  HomeLayout?: ({
    heading,
    subtitle,
    action,
    content,
    footer,
  }: {
    heading: ReactNode;
    subtitle: ReactNode;
    action: ReactNode;
    content: ReactNode;
    footer: ReactNode;
  }) => ReactNode;
}

const slots: Partial<Record<VisualThemeId, ThemeSlots>> = {
  slate: { HomeTitle: SlateHomeTitle },
  elysium: { HomeLayout: ElysiumHomeLayout },
};

export function HomeLayout({
  theme,
  heading,
  subtitle,
  action,
  content,
  footer,
}: {
  theme: unknown;
  heading: ReactNode;
  subtitle: ReactNode;
  action: ReactNode;
  content: ReactNode;
  footer: ReactNode;
}) {
  const Slot = slots[resolveVisualTheme(theme)]?.HomeLayout;
  return Slot ? (
    <Slot heading={heading} subtitle={subtitle} action={action} content={content} footer={footer} />
  ) : (
    <div className="mx-auto flex min-h-full max-w-[960px] flex-col px-9 pt-8 pb-5 max-[650px]:px-5 max-[650px]:pt-6">
      <div className="theme-home-decoration flex items-center justify-between gap-5 [&_p]:mt-1.5">
        <div>{heading}</div>
        {action}
      </div>
      {content}
      {footer}
    </div>
  );
}

export function HomeTitle({ theme, children }: { theme: unknown; children: ReactNode }) {
  const Slot = slots[resolveVisualTheme(theme)]?.HomeTitle;
  return Slot ? <Slot>{children}</Slot> : <h1>{children}</h1>;
}
