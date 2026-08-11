export const colors = {
  bg: '#0B1020',
  card: '#151B32',
  cardAlt: '#1D2440',
  border: '#2A3358',
  text: '#EEF1FA',
  textDim: '#9AA4C7',
  primary: '#5B8CFF',
  primaryDark: '#3A6BE0',
  allow: '#2FBF71',
  stepUp: '#E8B23A',
  deny: '#E5484D',
  neutral: '#6B76A0',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
};

export const decisionColor = (decision: string): string => {
  if (decision === 'allow') return colors.allow;
  if (decision === 'step_up') return colors.stepUp;
  if (decision === 'deny') return colors.deny;
  return colors.neutral;
};

export const riskColor = (band: string): string => {
  if (band === 'low') return colors.allow;
  if (band === 'medium') return colors.stepUp;
  return colors.deny;
};
