/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // normalize.css (imported first in main.tsx) is the project's CSS reset.
  // Tailwind's preflight is a competing, more aggressive reset that would
  // override it, so it's disabled — only base/utilities (colors, fonts) are
  // used here.
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        // status accents — used by <StatusBadge/>
        ok: { 50: "#f0fdf4", 500: "#22c55e", 700: "#15803d" },
        warn: { 50: "#fffbeb", 500: "#f59e0b", 700: "#b45309" },
        err: { 50: "#fef2f2", 500: "#ef4444", 700: "#b91c1c" },
        info: { 50: "#eff6ff", 500: "#3b82f6", 700: "#1d4ed8" },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['"SF Mono"', '"Menlo"', '"Monaco"', 'monospace'],
      },
    },
  },
  plugins: [],
};
