import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { translate, type Locale } from "../shared/i18n";

export function StartupVideo({ locale, source, soundEnabled, volume, onDone }: { locale: Locale; source: string; soundEnabled: boolean; volume: number; onDone: () => void }) {
  const [ready, setReady] = useState(false);
  const completed = useRef(false);
  const done = useCallback(() => {
    if (completed.current) return;
    completed.current = true;
    onDone();
  }, [onDone]);
  useEffect(() => {
    const skip = (event: KeyboardEvent) => {
      if (event.key === "Escape") done();
    };
    window.addEventListener("keydown", skip);
    return () => window.removeEventListener("keydown", skip);
  }, [done]);
  useEffect(() => {
    if (ready) return;
    const timer = window.setTimeout(done, 15000);
    return () => window.clearTimeout(timer);
  }, [ready, done]);
  return <div className="fixed inset-0 z-[1000] bg-black">
    <video className="h-full w-full object-contain" src={source} muted={!soundEnabled} playsInline onDoubleClick={done} onEnded={done} onError={done} onLoadedData={(event) => { event.currentTarget.volume = volume / 100; setReady(true); void event.currentTarget.play().catch(done); }} />
    <button type="button" className="absolute right-5 top-12 z-10 flex size-10 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80" aria-label={translate(locale, "startupVideoSkip")} title={translate(locale, "startupVideoSkip")} onClick={done}><X className="size-5" /></button>
  </div>;
}

export function StartupGate({ locale, source, soundEnabled, volume, onFinish, children }: { locale: Locale; source: string | null; soundEnabled: boolean; volume: number; onFinish: () => void; children: ReactNode }) {
  const [active, setActive] = useState(Boolean(source));
  const done = useCallback(() => {
    onFinish();
    setActive(false);
  }, [onFinish]);
  return active && source ? <StartupVideo locale={locale} source={source} soundEnabled={soundEnabled} volume={volume} onDone={done} /> : children;
}
