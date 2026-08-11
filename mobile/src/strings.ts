/** Tradução dos códigos que a API devolve. Os códigos são estáveis; o texto não. */

export const DECISION_LABEL: Record<string, string> = {
  allow: 'LIBERADO',
  step_up: 'VERIFICAÇÃO ADICIONAL',
  deny: 'NEGADO',
};

export const REASON_LABEL: Record<string, string> = {
  biometric_match: 'comportamento compatível com o template',
  biometric_borderline: 'comportamento na zona de fronteira',
  biometric_mismatch: 'comportamento incompatível com o template',
  no_match_in_gallery: 'ninguém na galeria bate com esta captura',
  ambiguous_candidates: '1º e 2º candidatos muito próximos',
  empty_gallery: 'galeria vazia — cadastre alguém antes',
  not_enrolled: 'cadastro incompleto (sem template)',
  no_comparable_features: 'não houve dimensão comparável',
  low_capture_quality: 'qualidade da captura insuficiente',
  captcha_invalid: 'token do hCaptcha inválido, expirado ou reusado',
  hcaptcha_low_risk: 'hCaptcha: risco baixo',
  hcaptcha_medium_risk: 'hCaptcha: risco médio',
  hcaptcha_high_risk: 'hCaptcha: risco alto',
};

export const ERROR_LABEL: Record<string, string> = {
  captcha_rejected: 'O hCaptcha recusou o token.',
  captcha_high_risk: 'Cadastro bloqueado: o hCaptcha classificou a sessão como ameaça.',
  user_not_found: 'Usuário não cadastrado neste servidor.',
  session_unknown: 'A sessão de captura não existe mais. Recomece a captura.',
  session_expired: 'A sessão de captura expirou. Recomece a captura.',
  session_already_used: 'Esta captura já foi enviada. Recomece a captura.',
  validation_error: 'O servidor recusou o formato do envio.',
  network_error: 'Sem conexão com o backend.',
  unauthorized: 'O backend exige chave de API — informe-a na tela inicial.',
  encryption_error:
    'O servidor não conseguiu ler os dados cifrados (chave de cifra errada ou trocada).',
};

export const GROUP_LABEL: Record<string, string> = {
  keystroke: 'digitação',
  gesture: 'gestos',
  tap: 'toques',
  motion: 'movimento',
  session: 'ritmo',
};

export const RISK_BAND_LABEL: Record<string, string> = {
  low: 'risco baixo',
  medium: 'risco médio',
  high: 'risco alto',
};

export function describeReason(code: string): string {
  return REASON_LABEL[code] ?? code;
}

export function describeError(code: string, fallback: string): string {
  return ERROR_LABEL[code] ?? fallback;
}
