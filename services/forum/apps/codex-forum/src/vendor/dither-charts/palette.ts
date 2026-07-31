export type DitherColor = 'green' | 'blue' | 'purple' | 'pink' | 'orange' | 'red' | 'grey';

const PALETTE: Record<DitherColor, string> = {
  green: '#28d26e',
  blue: '#358ff3',
  purple: '#966eff',
  pink: '#f05abe',
  orange: '#ff9632',
  red: '#f04646',
  grey: '#5c5c64',
};

export function cssColor(color: DitherColor | number | string): string {
  if (typeof color === 'number') return `hsl(${((color % 360) + 360) % 360} 85% 58%)`;
  return color in PALETTE ? PALETTE[color as DitherColor] : color;
}
