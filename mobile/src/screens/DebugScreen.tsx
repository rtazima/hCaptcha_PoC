import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { ApiError, api, type AuditEvent } from '../api/client';
import { useServerConfig } from '../ServerConfigProvider';
import { CaptchaError, useCaptcha } from '../captcha/CaptchaProvider';
import { Badge, Button, Card, Notice, Row } from '../components/ui';
import { colors, decisionColor, radius, spacing } from '../theme';
import { GROUP_LABEL, describeError } from '../strings';

type Props = NativeStackScreenProps<RootStackParamList, 'Debug'>;

const MOCK_RISK_PRESETS = [0.05, 0.5, 0.9];

export function DebugScreen(_props: Props) {
  const { config, reload } = useServerConfig();
  const captcha = useCaptcha();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tokenProbe, setTokenProbe] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  const loadAudit = useCallback(async () => {
    try {
      const response = await api.audit(30);
      setEvents(response.events);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? describeError(caught.code, caught.message) : String(caught),
      );
    }
  }, []);

  useEffect(() => {
    void loadAudit();
  }, [loadAudit]);

  const probeToken = useCallback(async () => {
    setProbing(true);
    setTokenProbe(null);
    try {
      const token = await captcha.getToken();
      token.markUsed();
      setTokenProbe(
        `token recebido (${token.token.length} caracteres): ${token.token.slice(0, 24)}…`,
      );
    } catch (caught) {
      setTokenProbe(
        caught instanceof CaptchaError ? `falhou: ${caught.message}` : `falhou: ${String(caught)}`,
      );
    } finally {
      setProbing(false);
    }
  }, [captcha]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Card
        title="hCaptcha"
        subtitle="Ajustes que só existem para demonstração. Nada disto vai para produção."
      >
        <Row label="modo" value={captcha.mode} />
        <Row label="sitekey" value={captcha.sitekey ?? '—'} />

        <View style={styles.switchRow}>
          <View style={styles.switchLabel}>
            <Text style={styles.switchTitle}>Modo passivo (passiveSiteKey)</Text>
            <Text style={styles.switchHint}>
              Sem modal, nem por um instante. Só funciona com sitekey Enterprise configurado como
              Passive: se o sitekey precisar mostrar desafio, a verificação travará.
            </Text>
          </View>
          <Switch
            value={captcha.passive}
            onValueChange={captcha.setPassive}
            disabled={captcha.mode === 'mock'}
          />
        </View>

        {captcha.mode === 'mock' ? (
          <>
            <Text style={styles.sectionLabel}>risco simulado no modo mock</Text>
            <View style={styles.presets}>
              {MOCK_RISK_PRESETS.map((risk) => (
                <Pressable
                  key={risk}
                  onPress={() => captcha.setMockRisk(risk)}
                  style={[styles.preset, captcha.mockRisk === risk && styles.presetActive]}
                >
                  <Text style={styles.presetText}>{risk.toFixed(2)}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.hint}>
              Envie 0.90 numa verificação 1:1 e veja o limiar subir e a decisão virar step-up com a
              mesma captura.
            </Text>
          </>
        ) : (
          <>
            <Button
              label={probing ? 'pedindo token…' : 'Testar token do hCaptcha'}
              onPress={probeToken}
              loading={probing || captcha.busy}
              style={styles.spaced}
            />
            {tokenProbe ? <Notice text={tokenProbe} /> : null}
          </>
        )}
      </Card>

      {config ? (
        <Card title="Política em vigor no servidor">
          <Row label="limiar base" value={config.policy.baseThreshold.toFixed(3)} />
          <Row label="faixa de step-up" value={config.policy.stepUpBand.toFixed(3)} />
          <Row
            label="ajuste por risco"
            value={`baixo ${config.policy.riskAdjust.low} · médio ${config.policy.riskAdjust.medium} · alto +${config.policy.riskAdjust.high}`}
          />
          <Row
            label="faixas de risco"
            value={`baixo <${config.policy.lowRiskMax} · alto ≥${config.policy.highRiskMin}`}
          />
          <Row label="acréscimo 1:N" value={`+${config.policy.identifyThresholdBoost}`} />
          <Row label="margem 1:N" value={config.policy.identifyMargin.toFixed(3)} />
          <Row
            label="risco alto força step-up"
            value={config.policy.highRiskForcesStepUp ? 'sim' : 'não'}
          />
          <Row label="calibração (ponto médio)" value={config.match.calibrationMidpoint.toFixed(3)} />
          <Row label="calibração (inclinação)" value={config.match.calibrationSteepness.toFixed(3)} />
          <Button label="Recarregar configuração" variant="ghost" onPress={reload} style={styles.spaced} />
        </Card>
      ) : null}

      {config ? (
        <Card
          title={`Features (${config.features.count})`}
          subtitle="Peso por grupo na distância final. O peso de cada dimensão é aprendido do corpus (variância entre pessoas vs. dentro da mesma pessoa)."
        >
          {Object.entries(config.features.groupWeights).map(([group, weight]) => (
            <Row key={group} label={GROUP_LABEL[group] ?? group} value={String(weight)} />
          ))}
          <Text style={styles.sectionLabel}>catálogo</Text>
          {config.features.list.map((feature) => (
            <View key={feature.name} style={styles.feature}>
              <Text style={styles.featureName}>{feature.name}</Text>
              <Text style={styles.featureAbout}>{feature.about}</Text>
            </View>
          ))}
        </Card>
      ) : null}

      <Card title="Auditoria das últimas decisões">
        {error ? <Notice text={error} tone={colors.deny} /> : null}
        {events.length === 0 ? <Text style={styles.hint}>Nenhum evento ainda.</Text> : null}
        {events.map((event) => (
          <View key={event.eventId} style={styles.event}>
            <View style={styles.eventHeader}>
              <Badge
                text={event.kind}
                color={event.decision ? decisionColor(event.decision) : colors.neutral}
              />
              <Text style={styles.eventTime}>{new Date(event.at).toLocaleTimeString('pt-BR')}</Text>
            </View>
            <Text style={styles.eventBody}>
              {event.userId ?? '—'} · {event.decision ?? '—'}
              {event.similarity != null ? ` · sim ${event.similarity.toFixed(3)}` : ''}
              {event.risk != null ? ` · risco ${event.risk.toFixed(2)}` : ''}
            </Text>
            {event.reasons.length > 0 ? (
              <Text style={styles.eventReasons}>{event.reasons.join(', ')}</Text>
            ) : null}
          </View>
        ))}
        <Button label="Atualizar" variant="ghost" onPress={loadAudit} style={styles.spaced} />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  switchLabel: { flex: 1 },
  switchTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  switchHint: { color: colors.textDim, fontSize: 12, lineHeight: 17, marginTop: 2 },
  sectionLabel: {
    color: colors.textDim,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  presets: { flexDirection: 'row', gap: spacing.sm },
  preset: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.cardAlt,
  },
  presetActive: { borderColor: colors.primary, backgroundColor: colors.primaryDark },
  presetText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  hint: { color: colors.textDim, fontSize: 12, lineHeight: 18, marginTop: spacing.sm },
  spaced: { marginTop: spacing.md },
  feature: { marginBottom: spacing.sm },
  featureName: { color: colors.text, fontSize: 13, fontFamily: 'monospace' },
  featureAbout: { color: colors.textDim, fontSize: 12 },
  event: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  eventHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eventTime: { color: colors.textDim, fontSize: 11 },
  eventBody: { color: colors.text, fontSize: 13, marginTop: spacing.xs },
  eventReasons: { color: colors.textDim, fontSize: 11, marginTop: 2 },
});
