import { forwardRef } from 'react';
import type { SVGProps } from 'react';
import { SYGNAAL_ICONS, type SygnaalIconName } from './registry.js';

export interface SygnaalIconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  /**
   * Name of the icon to render. Hover or autocomplete the value to see a preview.
   */
  name: SygnaalIconName;
  /**
   * Convenience prop that sets both `width` and `height` on the underlying `<svg>`.
   */
  size?: number | string;
}

/**
 * Strongly-typed icon component for the Sygnaal app.
 *
 * The `name` prop is constrained to the union of every available icon, and
 * each value carries a JSDoc preview that renders inline in editors that
 * support markdown images in tooltips (VS Code, Cursor, JetBrains).
 *
 * Forwards `className`, `style`, event handlers, and any other SVG attribute
 * straight through to the underlying `<svg>` element.
 *
 * @example
 * ```tsx
 * <SygnaalIcon name="AED" size={24} className="text-red-500" />
 * ```
 */
export const SygnaalIcon = forwardRef<SVGSVGElement, SygnaalIconProps>(
  function SygnaalIcon({ name, size, width, height, ...rest }, ref) {
    const Icon = SYGNAAL_ICONS[name];
    return (
      <Icon
        ref={ref}
        width={size ?? width}
        height={size ?? height}
        {...rest}
      />
    );
  },
);
