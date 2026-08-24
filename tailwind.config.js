/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#F3F2FF',
          100: '#E9E7FF',
          200: '#D4D0FF',
          300: '#AAA4F3',
          400: '#7E76E5',
          500: '#5B52D6',
          600: '#3D3ACB',
          700: '#302DA4',
          800: '#25216F',
          900: '#181643',
          950: '#100E2C',
        },
        peach: {
          50: '#FFF7F3',
          100: '#FFE9DF',
          200: '#FFD2C1',
          300: '#FFB496',
          400: '#FF9874',
          500: '#F7835E',
          600: '#DD6847',
          700: '#B94D32',
        },
        mint: {
          50: '#EDFFF8',
          100: '#D2FBEA',
          200: '#A8F3D5',
          300: '#79E9BC',
          400: '#4DE1A1',
          500: '#2BC789',
          600: '#1D9E6B',
          700: '#177E57',
        },
        lime: {
          400: '#C2FB14',
          500: '#B8F128',
          600: '#A3E635',
        },
        slate: {
          50: '#F8FAFC',
          100: '#F1F5F9',
          200: '#E2E8F0',
          300: '#CBD5E1',
          400: '#94A3B8',
          500: '#64748B',
          600: '#475569',
          700: '#334155',
          800: '#1E293B',
          900: '#0F172A',
          950: '#090D16',
        },
        card: {
          bg: '#FFFFFF',
          border: '#EBEFF5',
        }
      },
      fontFamily: {
        sans: ['Inter', 'Rubik', 'sans-serif'],
      },
      boxShadow: {
        'soft': '0 4px 20px -2px rgba(0, 0, 0, 0.05), 0 2px 6px -1px rgba(0, 0, 0, 0.02)',
        'float': '0 12px 32px -4px rgba(0, 0, 0, 0.08), 0 4px 12px -2px rgba(0, 0, 0, 0.03)',
        'lime-glow': '0 8px 24px -4px rgba(184, 241, 40, 0.4)',
        'brand': '0 16px 36px -14px rgba(61, 58, 203, 0.42)',
        'peach': '0 14px 30px -16px rgba(247, 131, 94, 0.55)',
      }
    },
  },
  plugins: [],
}
