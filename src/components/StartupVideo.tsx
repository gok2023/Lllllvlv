import { useEffect, useState, type ReactNode } from "react";
import { translate, type Locale } from "../shared/i18n";

export function StartupVideo({ locale, source, onDone }: { locale: Locale; source: string; onDone: () => void }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const skip = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDone();
    };
    window.addEventListener("keydown", skip);
    return () => window.removeEventListener("keydown", skip);
  }, [onDone]);
  useEffect(() => {
    if (ready) return;
    const timer = window.setTimeout(onDone, 15000);
    return () => window.clearTimeout(timer);
  }, [ready, onDone]);
  return <div className="fixed inset-0 z-[1000] bg-black">
    <video className="h-full w-full object-contain" src={source} autoPlay muted playsInline onEnded={onDone} onError={onDone} onLoadedData={(event) => { setReady(true); void event.currentTarget.play().catch(onDone); }} />
    <button type="button" className="absolute right-5 top-5 rounded bg-black/60 px-4 py-2 text-white" onClick={onDone}>{translate(locale, "startupVideoSkip")}</button>
  </div>;
}

export function StartupGate({ locale, source, children }: { locale: Locale; source: string | null; children: ReactNode }) {
  const [active, setActive] = useState(Boolean(source));
  return active && source ? <StartupVideo locale={locale} source={source} onDone={() => setActive(false)} /> : children;
}
