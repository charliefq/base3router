import type { SVGProps } from "react";

/** Compact router glyph. Three linked nodes, no decorative sparkle. */
export function Base3RouterMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} fill="none" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <rect fill="currentColor" height="4" rx="1" width="13" x="2" y="3" />
      <rect fill="currentColor" height="4" rx="1" width="13" x="9" y="10" />
      <rect fill="currentColor" height="4" rx="1" width="13" x="2" y="17" />
      <rect fill="currentColor" height="3" width="2" x="11" y="7" />
      <rect fill="currentColor" height="3" width="2" x="11" y="14" />
    </svg>
  );
}
