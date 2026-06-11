/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx}", "./components/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: "#11151C", soft: "#1B212B", line: "#2A3240" },
        paper: { DEFAULT: "#F6F4EE", dim: "#A8ADB8" },
        brass: { DEFAULT: "#C9A227", soft: "#E3C766" },
        gain: "#3FB984",
        loss: "#E0635C"
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["'IBM Plex Mono'", "ui-monospace", "monospace"]
      }
    }
  },
  plugins: []
};
