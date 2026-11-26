/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#0b0b0d', 2: '#0f0f12', 3: '#16161a' },
        bone: '#ECE8E1',
        dim: '#9b968c',
        faint: '#6b675f',
        signal: '#CBF24E',
        sand: '#E7C98B',
        sky: '#8FD0FF',
        good: '#8BE8A8',
        bad: '#FF9B8A',
      },
      fontFamily: {
        display: ['"Bricolage Grotesque"', 'Georgia', 'serif'],
        sans: ['"Hanken Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        hud: '0 24px 80px -20px rgba(0,0,0,0.75), 0 0 0 1px rgba(236,232,225,0.06)',
        glow: '0 0 40px -8px rgba(203,242,78,0.45)',
      },
      keyframes: {
        breathe: {
          '0%,100%': { transform: 'scale(1)', opacity: '0.55' },
          '50%': { transform: 'scale(1.08)', opacity: '0.9' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        breathe: 'breathe 3.2s ease-in-out infinite',
        shimmer: 'shimmer 2.2s linear infinite',
      },
    },
  },
  plugins: [],
};
