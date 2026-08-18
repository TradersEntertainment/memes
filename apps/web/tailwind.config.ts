import type { Config } from 'tailwindcss';

/**
 * Dark terminal theme. Chart color decisions follow the dataviz pass:
 * single-series charts use `accent` (#3987e5 — validated ≥3:1 on `surface`),
 * buy/sell/rotation are status colors that never appear without a text label.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0b0c0f',
        surface: '#14161a',
        raised: '#1b1e24',
        line: '#262a31',
        ink: {
          DEFAULT: '#e6e8ee',
          2: '#9aa0ad',
          3: '#697080',
        },
        accent: '#3987e5',
        buy: '#22c55e',
        sell: '#f87171',
        warn: '#fbbf24',
      },
      fontFamily: {
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'JetBrains Mono',
          'Consolas',
          'monospace',
        ],
      },
    },
  },
  plugins: [],
};

export default config;
