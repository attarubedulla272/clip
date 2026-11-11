/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#090b12",
        panel: "#11141e",
        accent: "#a78bfa"
      }
    }
  },
  plugins: []
};
