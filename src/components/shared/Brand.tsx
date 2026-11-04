import { cn } from "../../lib/utils";

export function BrandLogo({ width = 240, className }: { width?: number; className?: string }) {
  return (
    <span
      className={cn("inline-flex max-w-full items-center gap-3", className)}
      role="img"
      aria-label="Lllllvlv"
      style={{ width }}
    >
      <img src="./icon.png" alt="" className="block h-14 w-14 shrink-0" />
      <span className="brand-name text-[30px] leading-none">Lllllvlv</span>
    </span>
  );
}

export function BrandName({ className }: { className?: string }) {
  return <span className={cn("brand-name", className)}>Lllllvlv</span>;
}
