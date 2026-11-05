import type { ReactNode } from "react";

export function ElysiumHomeLayout({
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
}) {
  return (
    <div className="elysium-home">
      <div className="elysium-home-art" aria-hidden="true" />
      <div className="elysium-home-mask" aria-hidden="true" />
      <div className="elysium-home-inner">
        <header className="elysium-home-heading">
          <div className="elysium-kicker">LLLLLVLV / ELYSIUM</div>
          {heading}
          <p className="elysium-literary">{subtitle}</p>
          <div className="elysium-rule" />
        </header>
        <div className="elysium-home-columns">
          <div className="elysium-home-content theme-surface-content">{content}</div>
          {action && <aside className="elysium-home-aside theme-surface-control">{action}</aside>}
        </div>
        <footer className="elysium-home-footer theme-surface-art">{footer}</footer>
      </div>
    </div>
  );
}
