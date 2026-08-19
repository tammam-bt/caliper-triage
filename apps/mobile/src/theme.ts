/**
 * The web console's tokens, transcribed for React Native.
 *
 * Kept as one small module rather than reaching for a styling library: the design system is nine
 * colours and three type roles, and a dependency to express that would cost more than it saves.
 * The values are copied from `apps/web/src/styles/tokens.css` and must be changed together.
 */
export const colour = {
  ink: '#12181A',
  ink70: '#3D4649',
  ink45: '#626B6E',
  bone: '#E8E9E4',
  paper: '#F7F7F4',
  paperSunk: '#EEEFE9',
  rule: '#C9CCC4',
  ruleSoft: '#DCDFD8',
  drape: '#234A40',
  drapeLift: '#3E7A69',
  drapeInk: '#F2F5F3',
  reticle: '#6FD3D8',
  urgent: '#9E2B25',
  prompt: '#975D22',
  routine: '#4B753B',
  indeterminate: '#616966',
} as const;

export const acuityColour = (band: string): string =>
  ({
    urgent: colour.urgent,
    prompt: colour.prompt,
    routine: colour.routine,
    indeterminate: colour.indeterminate,
  })[band] ?? colour.indeterminate;

/**
 * The web build self-hosts Faustina, Public Sans and IBM Plex Mono. Loading three custom families
 * on mobile costs a bundle and a font-loading state for a prototype, so the roles map onto the
 * platform faces instead: the *distinction* between report text, chrome and machine numbers is what
 * carries the design, and the serif/sans/mono split survives the substitution.
 */
export const font = {
  report: { fontFamily: undefined, fontSize: 15, lineHeight: 21 },
  ui: { fontFamily: undefined, fontSize: 14 },
  data: { fontFamily: 'monospace' as const, fontSize: 12 },
  label: {
    fontFamily: undefined,
    fontSize: 11,
    fontWeight: '600' as const,
    letterSpacing: 1.3,
    textTransform: 'uppercase' as const,
    color: colour.ink45,
  },
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
