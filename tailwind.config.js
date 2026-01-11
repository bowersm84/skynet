/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'skynet-dark': '#0a0a0f',
        'skynet-blue': '#1e3a5f',
        'skynet-accent': '#3b82f6',
        'skynet-red': '#dc2626',
        'skynet-yellow': '#f59e0b',
        'skynet-green': '#10b981',
      }
    },
  },
  plugins: [],
}