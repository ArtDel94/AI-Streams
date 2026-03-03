/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        rebell: {
          blue: '#2F85A4',
          dark: '#254759',
          light: '#E8F4F9',
        }
      }
    }
  },
  plugins: []
}
