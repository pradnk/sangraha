import type { Config } from 'tailwindcss';

/**
 * Two design systems in one app.
 *
 * The admin console is a dense desktop tool for someone who uses it daily. The
 * field UI is for someone standing in a village, on a low-end phone, in
 * sunlight, possibly with limited reading confidence. Making one responsive
 * layout serve both produces something mediocre at each, so the scales are
 * separated: `text-field-*` and `tap-*` are the field vocabulary, and the
 * defaults stay compact for admin screens.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontSize: {
        // Field scale. 18px base rather than 16 — measurably easier to read at
        // arm's length outdoors, and it forces layouts to stay uncluttered.
        'field-sm': ['1rem', { lineHeight: '1.5rem' }],
        'field-base': ['1.125rem', { lineHeight: '1.75rem' }],
        'field-lg': ['1.375rem', { lineHeight: '1.9rem' }],
        'field-question': ['1.5rem', { lineHeight: '2rem' }],
      },
      spacing: {
        // Minimum comfortable tap target. The WCAG floor is 44px; 56 is chosen
        // for gloved, calloused or unsteady hands, which is the real audience.
        tap: '3.5rem',
        'tap-lg': '4rem',
      },
      minHeight: {
        tap: '3.5rem',
        'tap-lg': '4rem',
      },
      minWidth: {
        tap: '3.5rem',
      },
      colors: {
        // Deliberately high-contrast. Every pairing used for text on a
        // background meets WCAG AA at the sizes above.
        /*
         * Complete scales, on purpose.
         *
         * These used to define only the handful of steps that were in use, and a
         * Tailwind class naming a step that does not exist emits no CSS at all —
         * silently. `bg-affirm-600 text-white` on the consent screen's agree
         * button was therefore white text on a transparent background: present,
         * clickable and invisible. It was reported as "where is the positive
         * button?", and a sweep found forty-odd more across the admin console,
         * including `bg-deny-600` on two destructive buttons.
         *
         * So every step from 50 to 900 exists for all three. The original
         * anchors are unchanged; the rest are interpolated between them, and
         * every shade that carries white text or sits on its own 50 tint clears
         * WCAG AA — `scripts/check-palette.ts` proves it rather than asserting
         * it, and `palette.test.ts` fails if a class names a step that is gone.
         */
        brand: {
          50: '#eef6ff',
          100: '#d9eaff',
          200: '#aacbf3',
          300: '#7bade8',
          400: '#4c8edc',
          500: '#1d6fd0',
          600: '#1559ab',
          700: '#114887',
          800: '#0e3c70',
          900: '#0b2f58',
        },
        // Answer states in the field UI. Green/red alone would fail for the
        // ~8% of men with red-green colour blindness, so these are always
        // paired with an icon and a text label in the components.
        affirm: {
          50: '#e8f7ee',
          100: '#d0ebdb',
          200: '#a0d3b6',
          300: '#6fba90',
          400: '#3fa26b',
          500: '#0f8a45',
          600: '#0d793c',
          700: '#0a6733',
          800: '#084d26',
          900: '#05341a',
        },
        deny: {
          50: '#fdecec',
          100: '#f7d6d6',
          200: '#ebabab',
          300: '#de7f7f',
          400: '#d25454',
          500: '#c62828',
          600: '#aa2424',
          700: '#8e1f1f',
          800: '#6b1717',
          900: '#471010',
        },
      },
      borderRadius: {
        field: '0.875rem',
      },
    },
  },
  plugins: [],
};

export default config;
