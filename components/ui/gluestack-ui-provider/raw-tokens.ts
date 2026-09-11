// The raw token data. DELIBERATELY IMPORT-FREE.
//
// This file is split from config.ts for one reason: config.ts imports `vars`
// from nativewind, and nativewind reaches react-native-css-interop's appearance
// observables at MODULE LOAD. Any jest suite that mocks react-native without
// Appearance then dies at import with "Cannot read properties of undefined
// (reading 'getColorScheme')" — and lib/theme imports these tokens, so that
// would be every suite rendering a themed component. P4 puts useThemeColors
// into ~119 files, so the theme layer must be importable without nativewind.
//
// Nothing may be imported here. If this file ever grows an import, the suites
// that break are far away and the error will not name this change.

export const rawTokens = {
  light: {
    /* Primary - Toasted Almond at 500, Molten Lava at 800. Accent identity is 500;
       accent TEXT is 700+ (500 is 2.32:1 on Parchment and fails AA).
       600 sits in the label dead band (L 0.207): border/icon/focus only, never text. */
    '--color-primary-0': '253 248 246',
    '--color-primary-50': '251 237 230',
    '--color-primary-100': '249 226 213',
    '--color-primary-200': '244 204 181',
    '--color-primary-300': '240 182 148',
    '--color-primary-400': '235 160 116',
    '--color-primary-500': '231 138 83',
    '--color-primary-600': '191 101 58',
    '--color-primary-700': '151 63 32',
    '--color-primary-800': '111 26 7',
    '--color-primary-900': '83 20 5',
    '--color-primary-950': '61 14 4',

    /* Secondary - unchanged from stock, so light stays an exact mirror of dark. */
    '--color-secondary-0': '246 248 248',
    '--color-secondary-50': '238 241 241',
    '--color-secondary-100': '220 227 227',
    '--color-secondary-200': '194 207 207',
    '--color-secondary-300': '160 179 179',
    '--color-secondary-400': '125 152 152',
    '--color-secondary-500': '82 117 117',
    '--color-secondary-600': '72 103 103',
    '--color-secondary-700': '62 88 88',
    '--color-secondary-800': '49 70 70',
    '--color-secondary-900': '37 53 53',
    '--color-secondary-950': '25 35 35',

    /* Tertiary - unchanged from stock. */
    '--color-tertiary-0': '254 249 246',
    '--color-tertiary-50': '253 243 238',
    '--color-tertiary-100': '250 232 221',
    '--color-tertiary-200': '247 214 195',
    '--color-tertiary-300': '242 191 160',
    '--color-tertiary-400': '237 167 126',
    '--color-tertiary-500': '231 138 83',
    '--color-tertiary-600': '203 121 73',
    '--color-tertiary-700': '173 104 62',
    '--color-tertiary-800': '139 83 50',
    '--color-tertiary-900': '104 62 37',
    '--color-tertiary-950': '69 41 25',

    /* Error - stock Gluestack light. Error TEXT is 700; 500-600 are fill-only. */
    '--color-error-0': '254 246 246',
    '--color-error-50': '253 236 236',
    '--color-error-100': '252 218 218',
    '--color-error-200': '249 190 190',
    '--color-error-300': '246 152 152',
    '--color-error-400': '243 115 115',
    '--color-error-500': '239 68 68',
    '--color-error-600': '210 60 60',
    '--color-error-700': '179 51 51',
    '--color-error-800': '143 41 41',
    '--color-error-900': '108 31 31',
    '--color-error-950': '72 20 20',

    /* Success - stock Gluestack light. */
    '--color-success-0': '228 255 244',
    '--color-success-50': '202 255 232',
    '--color-success-100': '162 241 192',
    '--color-success-200': '132 211 162',
    '--color-success-300': '102 181 132',
    '--color-success-400': '72 151 102',
    '--color-success-500': '52 131 82',
    '--color-success-600': '42 121 72',
    '--color-success-700': '32 111 62',
    '--color-success-800': '22 101 52',
    '--color-success-900': '20 83 45',
    '--color-success-950': '27 50 36',

    /* Warning - stock Gluestack light. */
    '--color-warning-0': '255 249 245',
    '--color-warning-50': '255 244 236',
    '--color-warning-100': '255 231 213',
    '--color-warning-200': '254 205 170',
    '--color-warning-300': '253 173 116',
    '--color-warning-400': '251 149 75',
    '--color-warning-500': '231 120 40',
    '--color-warning-600': '215 108 31',
    '--color-warning-700': '180 90 26',
    '--color-warning-800': '130 68 23',
    '--color-warning-900': '108 56 19',
    '--color-warning-950': '84 45 18',

    /* Info - stock Gluestack light. */
    '--color-info-0': '236 248 254',
    '--color-info-50': '199 235 252',
    '--color-info-100': '162 221 250',
    '--color-info-200': '124 207 248',
    '--color-info-300': '87 194 246',
    '--color-info-400': '50 180 244',
    '--color-info-500': '13 166 242',
    '--color-info-600': '11 141 205',
    '--color-info-700': '9 115 168',
    '--color-info-800': '7 90 131',
    '--color-info-900': '5 64 93',
    '--color-info-950': '3 38 56',

    /* Typography - Silver at 300, Shadow Grey at 950.
       300 and below is DECORATIVE ONLY. 400 is the first stop that clears AA 4.5:1
       on all four light backdrops; see lib/theme/contrast-audit.ts. */
    '--color-typography-0': '255 255 255',
    '--color-typography-50': '250 250 248',
    '--color-typography-100': '232 231 226',
    '--color-typography-200': '205 203 194',
    '--color-typography-300': '177 173 161',
    '--color-typography-400': '107 104 100',
    '--color-typography-500': '93 91 88',
    '--color-typography-600': '79 77 77',
    '--color-typography-700': '65 64 65',
    '--color-typography-800': '51 50 53',
    '--color-typography-900': '37 37 42',
    '--color-typography-950': '30 30 36',

    /* Outline - 200 is the functional control border (3.05:1, clears the 3:1 in
       WCAG 1.4.11). 100 and below are decorative hairlines and are NOT forced to 3:1. */
    '--color-outline-0': '252 252 250',
    '--color-outline-50': '246 245 241',
    '--color-outline-100': '226 224 216',
    '--color-outline-200': '143 139 132',
    '--color-outline-300': '128 124 119',
    '--color-outline-400': '113 110 106',
    '--color-outline-500': '98 95 94',
    '--color-outline-600': '83 81 81',
    '--color-outline-700': '68 66 68',
    '--color-outline-800': '53 52 55',
    '--color-outline-900': '38 37 42',
    '--color-outline-950': '26 26 31',

    /* Background - Parchment at 0, Silver at 400, Shadow Grey at 950.
       No stop is lighter than 0; raised surfaces use the legacy gray-900 alias (P3). */
    '--color-background-0': '244 243 238',
    '--color-background-50': '240 239 233',
    '--color-background-100': '233 232 225',
    '--color-background-200': '219 217 208',
    '--color-background-300': '198 195 185',
    '--color-background-400': '177 173 161',
    '--color-background-500': '150 147 138',
    '--color-background-600': '124 121 116',
    '--color-background-700': '97 95 93',
    '--color-background-800': '70 69 70',
    '--color-background-900': '43 43 47',
    '--color-background-950': '30 30 36',

    /* Background Special - stock Gluestack light. */
    '--color-background-error': '254 241 241',
    '--color-background-warning': '255 243 234',
    '--color-background-success': '237 252 242',
    '--color-background-muted': '243 244 246',
    '--color-background-info': '235 248 254',

    /* LITERAL ESCAPE HATCHES. Identical in both schemes, deliberately.
       Most text-white / bg-black in this app means "primary foreground" or
       "base surface" and must follow the theme. A minority means LITERALLY
       white or black, because it sits on something that is not a themed
       surface: a label on the Almond accent fill, a caption over a card image
       gradient, a scrim, a hairline on media. In DARK MODE both readings render
       the same pixels, so the dark diff is blind to the difference and light
       mode breaks in exactly the places hardest to spot. These three names make
       the intent explicit at the call site. */
    '--color-pure-white': '255 255 255',
    '--color-pure-black': '0 0 0',
    /* A veil over media. Dark in BOTH schemes: a scrim exists to make text
       legible over a photograph, and a photograph is not lighter in light mode. */
    '--color-scrim': '0 0 0',

    /* LEGACY TAILWIND ALIASES, light column. See the dark block for why these
       are dedicated variables rather than an identity mapping onto typography.

       The surface roles INVERT here and that is correct: gray-900 is a card
       raised above near-black, so its light counterpart is LIGHTER than the
       page, and gray-950 is recessed, so it goes darker. Side effect: gray-800
       ends up darker than gray-900, reversing the Tailwind numeric intuition. */
    '--color-legacy-white': '30 30 36',
    '--color-legacy-black': '244 243 238',
    '--color-legacy-gray-50': '30 30 36',
    '--color-legacy-gray-100': '33 33 37',
    '--color-legacy-gray-200': '39 39 43',
    '--color-legacy-gray-300': '49 48 52',
    '--color-legacy-gray-400': '79 77 78',
    '--color-legacy-gray-500': '95 93 92',
    '--color-legacy-gray-600': '107 104 100',
    '--color-legacy-gray-700': '186 182 171',
    '--color-legacy-gray-800': '218 216 209',
    '--color-legacy-gray-900': '250 249 247',
    '--color-legacy-gray-950': '237 236 230',

    /* The five formerly hardcoded named stops. Four have no call sites left;
       bg-background-dark has one, in components/ui/modal/index.tsx. */
    '--color-typography-white': '30 30 36',
    '--color-typography-gray': '107 104 100',
    '--color-typography-black': '24 23 24',
    '--color-background-light': '244 243 238',
    '--color-background-dark': '30 30 36',

    /* Focus Ring Indicator - primary retoned to 195 104 60 (3.52:1); stock 216 121 67
       is 2.81:1 and Almond itself is 2.32:1, both under the 3:1 a focus ring needs. */
    '--color-indicator-primary': '195 104 60',
    '--color-indicator-info': '83 153 236',
    '--color-indicator-error': '185 28 28',
  },
  dark: {
    /* Primary - shadcn dark primary: rgb(231, 138, 83) warm orange */
    '--color-primary-0': '69 41 25',
    '--color-primary-50': '104 62 37',
    '--color-primary-100': '139 83 50',
    '--color-primary-200': '173 104 62',
    '--color-primary-300': '203 121 73',
    '--color-primary-400': '231 138 83',
    '--color-primary-500': '237 167 126',
    '--color-primary-600': '242 191 160',
    '--color-primary-700': '247 214 195',
    '--color-primary-800': '250 232 221',
    '--color-primary-900': '253 243 238',
    '--color-primary-950': '254 249 246',

    /* Secondary - shadcn dark secondary: rgb(95, 135, 135) teal */
    '--color-secondary-0': '25 35 35',
    '--color-secondary-50': '37 53 53',
    '--color-secondary-100': '49 70 70',
    '--color-secondary-200': '62 88 88',
    '--color-secondary-300': '72 103 103',
    '--color-secondary-400': '82 117 117',
    '--color-secondary-500': '125 152 152',
    '--color-secondary-600': '160 179 179',
    '--color-secondary-700': '194 207 207',
    '--color-secondary-800': '220 227 227',
    '--color-secondary-900': '238 241 241',
    '--color-secondary-950': '246 248 248',

    /* Tertiary - warm orange variant */
    '--color-tertiary-0': '69 41 25',
    '--color-tertiary-50': '104 62 37',
    '--color-tertiary-100': '139 83 50',
    '--color-tertiary-200': '173 104 62',
    '--color-tertiary-300': '203 121 73',
    '--color-tertiary-400': '231 138 83',
    '--color-tertiary-500': '237 167 126',
    '--color-tertiary-600': '242 191 160',
    '--color-tertiary-700': '247 214 195',
    '--color-tertiary-800': '250 232 221',
    '--color-tertiary-900': '253 243 238',
    '--color-tertiary-950': '254 249 246',

    /* Error - red */
    '--color-error-0': '72 20 20',
    '--color-error-50': '108 31 31',
    '--color-error-100': '143 41 41',
    '--color-error-200': '179 51 51',
    '--color-error-300': '210 60 60',
    '--color-error-400': '239 68 68',
    '--color-error-500': '243 115 115',
    '--color-error-600': '246 152 152',
    '--color-error-700': '249 190 190',
    '--color-error-800': '252 218 218',
    '--color-error-900': '253 236 236',
    '--color-error-950': '254 246 246',

    /* Success - default Gluestack green */
    '--color-success-0': '27 50 36',
    '--color-success-50': '20 83 45',
    '--color-success-100': '22 101 52',
    '--color-success-200': '32 111 62',
    '--color-success-300': '42 121 72',
    '--color-success-400': '52 131 82',
    '--color-success-500': '72 151 102',
    '--color-success-600': '102 181 132',
    '--color-success-700': '132 211 162',
    '--color-success-800': '162 241 192',
    '--color-success-900': '202 255 232',
    '--color-success-950': '228 255 244',

    /* Warning - default Gluestack orange */
    '--color-warning-0': '84 45 18',
    '--color-warning-50': '108 56 19',
    '--color-warning-100': '130 68 23',
    '--color-warning-200': '180 90 26',
    '--color-warning-300': '215 108 31',
    '--color-warning-400': '231 120 40',
    '--color-warning-500': '251 149 75',
    '--color-warning-600': '253 173 116',
    '--color-warning-700': '254 205 170',
    '--color-warning-800': '255 231 213',
    '--color-warning-900': '255 244 237',
    '--color-warning-950': '255 249 245',

    /* Info - default Gluestack blue */
    '--color-info-0': '3 38 56',
    '--color-info-50': '5 64 93',
    '--color-info-100': '7 90 131',
    '--color-info-200': '9 115 168',
    '--color-info-300': '11 141 205',
    '--color-info-400': '13 166 242',
    '--color-info-500': '50 180 244',
    '--color-info-600': '87 194 246',
    '--color-info-700': '124 207 248',
    '--color-info-800': '162 221 250',
    '--color-info-900': '199 235 252',
    '--color-info-950': '236 248 254',

    /* Typography */
    '--color-typography-0': '23 23 23',
    '--color-typography-50': '38 38 39',
    '--color-typography-100': '64 64 64',
    '--color-typography-200': '82 82 82',
    '--color-typography-300': '115 115 115',
    '--color-typography-400': '140 140 140',
    '--color-typography-500': '163 163 163',
    '--color-typography-600': '212 212 212',
    '--color-typography-700': '219 219 220',
    '--color-typography-800': '229 229 229',
    '--color-typography-900': '245 245 245',
    '--color-typography-950': '254 254 255',

    /* Outline */
    '--color-outline-0': '26 23 23',
    '--color-outline-50': '39 38 36',
    '--color-outline-100': '65 65 65',
    '--color-outline-200': '83 82 82',
    '--color-outline-300': '115 116 116',
    '--color-outline-400': '140 141 141',
    '--color-outline-500': '165 163 163',
    '--color-outline-600': '211 211 211',
    '--color-outline-700': '221 220 219',
    '--color-outline-800': '230 230 230',
    '--color-outline-900': '243 243 243',
    '--color-outline-950': '253 254 254',

    /* Background */
    '--color-background-0': '18 17 19',
    '--color-background-50': '34 34 34',
    '--color-background-100': '51 51 51',
    '--color-background-200': '68 68 68',
    '--color-background-300': '116 116 116',
    '--color-background-400': '142 142 142',
    '--color-background-500': '162 163 163',
    '--color-background-600': '213 212 212',
    '--color-background-700': '229 228 228',
    '--color-background-800': '242 241 241',
    '--color-background-900': '246 246 246',
    '--color-background-950': '255 255 255',

    /* Background Special */
    '--color-background-error': '66 43 43',
    '--color-background-warning': '65 47 35',
    '--color-background-success': '28 43 33',
    '--color-background-muted': '34 34 34',
    '--color-background-info': '26 40 46',

    /* LITERAL ESCAPE HATCHES. Identical in both schemes, deliberately.
       Most text-white / bg-black in this app means "primary foreground" or
       "base surface" and must follow the theme. A minority means LITERALLY
       white or black, because it sits on something that is not a themed
       surface: a label on the Almond accent fill, a caption over a card image
       gradient, a scrim, a hairline on media. In DARK MODE both readings render
       the same pixels, so the dark diff is blind to the difference and light
       mode breaks in exactly the places hardest to spot. These three names make
       the intent explicit at the call site. */
    '--color-pure-white': '255 255 255',
    '--color-pure-black': '0 0 0',
    /* A veil over media. Dark in BOTH schemes: a scrim exists to make text
       legible over a photograph, and a photograph is not lighter in light mode. */
    '--color-scrim': '0 0 0',

    /* LEGACY TAILWIND ALIASES. Dark values are the EXACT Tailwind 3.4.18 hexes
       these class names resolve to today, so aliasing them is provably a no-op
       in dark. Light values are audited against four backdrops in
       lib/theme/contrast-audit.ts, which is the single source and is asserted
       against these by legacy-alias.test.ts.

       Identity mapping (gray-N -> typography-N) WOULD NOT WORK: the dark
       typography ramp is reversed, so the relationship inverts and every dark
       screen shifts. Hence dedicated variables. */
    '--color-legacy-white': '255 255 255',
    '--color-legacy-black': '0 0 0',
    '--color-legacy-gray-50': '249 250 251',
    '--color-legacy-gray-100': '243 244 246',
    '--color-legacy-gray-200': '229 231 235',
    '--color-legacy-gray-300': '209 213 219',
    '--color-legacy-gray-400': '156 163 175',
    '--color-legacy-gray-500': '107 114 128',
    '--color-legacy-gray-600': '75 85 99',
    '--color-legacy-gray-700': '55 65 81',
    '--color-legacy-gray-800': '31 41 55',
    '--color-legacy-gray-900': '17 24 39',
    '--color-legacy-gray-950': '3 7 18',

    /* The five formerly hardcoded named stops. Four have no call sites left;
       bg-background-dark has one, in components/ui/modal/index.tsx. */
    '--color-typography-white': '255 255 255',
    '--color-typography-gray': '212 212 212',
    '--color-typography-black': '24 23 24',
    '--color-background-light': '251 251 251',
    '--color-background-dark': '24 23 25',

    /* Focus Ring Indicator */
    '--color-indicator-primary': '231 138 83',
    '--color-indicator-info': '161 199 245',
    '--color-indicator-error': '232 70 69',
  },
} as const;
