/**
 * Hugeicons (@hugeicons/core-free-icons) → SVG for vanilla TS.
 * Free icons export stroke path data as [tagName, attrs][] (viewBox 0 0 24 24).
 */

export type IconSvgObject = ReadonlyArray<
  readonly [string, Readonly<Record<string, string | number>>]
>;

export interface IconRenderOptions {
  size?: number;
  className?: string;
  strokeWidth?: number | string;
  /** Accessible title; if omitted, SVG is aria-hidden. */
  title?: string;
}

function camelToKebab(name: string): string {
  if (name === 'strokeWidth') return 'stroke-width';
  if (name === 'strokeLinecap') return 'stroke-linecap';
  if (name === 'strokeLinejoin') return 'stroke-linejoin';
  if (name === 'fillRule') return 'fill-rule';
  if (name === 'clipRule') return 'clip-rule';
  if (name === 'clipPath') return 'clip-path';
  return name;
}

function attrsToString(
  attrs: Readonly<Record<string, string | number>>,
  strokeWidth?: number | string,
): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'key') continue;
    if (strokeWidth != null && k === 'strokeWidth') {
      parts.push(`stroke-width="${strokeWidth}"`);
      continue;
    }
    parts.push(`${camelToKebab(k)}="${String(v).replace(/"/g, '&quot;')}"`);
  }
  if (strokeWidth != null && !('strokeWidth' in attrs)) {
    parts.push(`stroke-width="${strokeWidth}"`);
  }
  return parts.join(' ');
}

/** Render Hugeicons data to an SVG markup string (for innerHTML templates). */
export function iconSvg(icon: IconSvgObject, opts: IconRenderOptions = {}): string {
  const size = opts.size ?? 18;
  const cls = opts.className ? ` class="${opts.className}"` : ' class="hi-icon"';
  const labelled = Boolean(opts.title);
  const title = labelled
    ? `<title>${opts.title!.replace(/</g, '&lt;')}</title>`
    : '';
  const a11y = labelled
    ? ` role="img" aria-label="${opts.title!.replace(/"/g, '&quot;')}"`
    : ' aria-hidden="true" focusable="false"';
  const children = icon
    .map(([tag, attrs]) => `<${tag} ${attrsToString(attrs, opts.strokeWidth)} />`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"${cls}${a11y}>${title}${children}</svg>`;
}

/** Create a live SVGElement from Hugeicons data (for imperative DOM). */
export function createIconElement(
  icon: IconSvgObject,
  opts: IconRenderOptions = {},
): SVGSVGElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = iconSvg(icon, opts);
  return wrap.firstElementChild as SVGSVGElement;
}
