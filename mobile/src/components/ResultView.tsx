/** Apresentação de decisão, score biométrico e avaliação do hCaptcha. */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type {
  CaptchaAssessment,
  IdentifyResponse,
  MatchBreakdown,
  QualityReport,
  VerifyResponse,
} from '../api/contract';
import { colors, decisionColor, radius, riskColor, spacing } from '../theme';
import { Badge, Card, Meter, Row } from './ui';
import { DECISION_LABEL, GROUP_LABEL, RISK_BAND_LABEL, describeReason } from '../strings';

export function DecisionCard({
  decision,
  reasons,
  latencyMs,
}: {
  decision: string;
  reasons: string[];
  latencyMs?: number;
}) {
  const color = decisionColor(decision);
  return (
    <Card style={{ borderColor: color }}>
      <View style={styles.decisionHeader}>
        <Text style={[styles.decisionText, { color }]}>
          {DECISION_LABEL[decision] ?? decision.toUpperCase()}
        </Text>
        {latencyMs != null ? <Text style={styles.latency}>{latencyMs} ms</Text> : null}
      </View>
      <View style={styles.reasons}>
        {reasons.map((reason) => (
          <Text key={reason} style={styles.reason}>
            • {describeReason(reason)}
          </Text>
        ))}
      </View>
    </Card>
  );
}

export function ScoreCard({
  match,
  threshold,
  title = 'Score biométrico',
}: {
  match: MatchBreakdown;
  threshold: number;
  title?: string;
}) {
  const passed = match.similarity >= threshold;
  return (
    <Card title={title}>
      <View style={styles.scoreHeader}>
        <Text style={styles.scoreValue}>{match.similarity.toFixed(3)}</Text>
        <Text style={styles.scoreThreshold}>limiar {threshold.toFixed(3)}</Text>
      </View>
      <Meter
        value={match.similarity}
        threshold={threshold}
        color={passed ? colors.allow : colors.deny}
      />
      <Row label="distância robusta" value={match.distance.toFixed(3)} />
      <Row label="dimensões comparadas" value={String(match.dimensionsCompared)} />

      <Text style={styles.sectionLabel}>distância por grupo (menor = mais parecido)</Text>
      {Object.entries(match.perGroup).map(([group, distance]) => (
        <Row
          key={group}
          label={GROUP_LABEL[group] ?? group}
          value={distance == null ? 'sem dados' : distance.toFixed(2)}
        />
      ))}

      {match.topContributors.length > 0 ? (
        <>
          <Text style={styles.sectionLabel}>features que mais divergiram (z-score)</Text>
          {match.topContributors.map((contributor) => (
            <Row
              key={contributor.feature}
              label={contributor.feature}
              value={contributor.z.toFixed(2)}
              tone={Math.abs(contributor.z) > 2 ? colors.deny : colors.textDim}
            />
          ))}
        </>
      ) : null}
    </Card>
  );
}

export function CaptchaCard({ captcha }: { captcha: CaptchaAssessment }) {
  const color = riskColor(captcha.riskBand);
  return (
    <Card title="hCaptcha">
      <View style={styles.captchaHeader}>
        <Badge text={RISK_BAND_LABEL[captcha.riskBand] ?? captcha.riskBand} color={color} />
        <Text style={styles.scoreValueSmall}>{captcha.risk.toFixed(2)}</Text>
      </View>
      <Meter value={captcha.risk} color={color} />
      <Row label="token válido" value={captcha.success ? 'sim' : 'não'} />
      <Row label="modo" value={captcha.mode} />
      <Row
        label="origem do risco"
        value={captcha.derived ? 'derivado (sitekey sem score)' : 'score do hCaptcha'}
        tone={captcha.derived ? colors.stepUp : colors.allow}
      />
      {captcha.hostname ? <Row label="hostname" value={captcha.hostname} /> : null}
      {captcha.reasons.length > 0 ? (
        <Row label="score_reason" value={captcha.reasons.join(', ')} />
      ) : null}
      {captcha.errorCodes && captcha.errorCodes.length > 0 ? (
        <Row label="error-codes" value={captcha.errorCodes.join(', ')} tone={colors.deny} />
      ) : null}
      {captcha.derived ? (
        <Text style={styles.footnote}>
          Este sitekey não devolve `score`. O risco acima foi inferido do sucesso/falha do token —
          para consumir risco de verdade é preciso um sitekey Enterprise Passive.
        </Text>
      ) : null}
    </Card>
  );
}

export function QualityCard({ quality }: { quality: QualityReport }) {
  return (
    <Card title="Qualidade da captura">
      <Row
        label="aprovada"
        value={quality.ok ? 'sim' : 'não'}
        tone={quality.ok ? colors.allow : colors.deny}
      />
      <Row label="cobertura" value={quality.score.toFixed(2)} />
      <Row
        label="eventos"
        value={
          `${quality.counts.keystrokes} teclas · ${quality.counts.gestures} gestos · ` +
          `${quality.counts.taps} toques · ${quality.counts.motion} mov.`
        }
      />
      <Row
        label="grupos usados"
        value={quality.availableGroups.map((g) => GROUP_LABEL[g] ?? g).join(', ')}
      />
      {quality.issues.map((issue) => (
        <Text key={issue} style={styles.issue}>
          ⚠ {issue}
        </Text>
      ))}
    </Card>
  );
}

export function VerifyResultView({ result }: { result: VerifyResponse }) {
  return (
    <>
      <DecisionCard
        decision={result.decision}
        reasons={result.reasons}
        latencyMs={result.latencyMs}
      />
      <ScoreCard match={result.match} threshold={result.threshold} />
      <CaptchaCard captcha={result.captcha} />
      <QualityCard quality={result.quality} />
    </>
  );
}

export function IdentifyResultView({ result }: { result: IdentifyResponse }) {
  return (
    <>
      <DecisionCard
        decision={result.decision}
        reasons={result.reasons}
        latencyMs={result.latencyMs}
      />
      <Card
        title="Ranking da galeria"
        subtitle={
          `limiar ${result.threshold.toFixed(3)} (mais rígido que o 1:1) · ` +
          `margem exigida ${result.requiredMargin.toFixed(3)}` +
          (result.margin != null ? ` · margem obtida ${result.margin.toFixed(3)}` : '')
        }
      >
        {result.candidates.length === 0 ? (
          <Text style={styles.issue}>Nenhum candidato: a galeria está vazia.</Text>
        ) : (
          result.candidates.map((candidate) => {
            const isMatch = candidate.userId === result.matchedUserId;
            const passed = candidate.match.similarity >= result.threshold;
            return (
              <View
                key={candidate.userId}
                style={[styles.candidate, isMatch && { borderColor: colors.allow }]}
              >
                <View style={styles.candidateHeader}>
                  <Text style={styles.candidateRank}>#{candidate.rank}</Text>
                  <Text style={styles.candidateName} numberOfLines={1}>
                    {candidate.displayName ?? candidate.userId}
                  </Text>
                  <Text
                    style={[
                      styles.candidateScore,
                      { color: passed ? colors.allow : colors.textDim },
                    ]}
                  >
                    {candidate.match.similarity.toFixed(3)}
                  </Text>
                </View>
                <Meter
                  value={candidate.match.similarity}
                  threshold={result.threshold}
                  color={passed ? colors.allow : colors.neutral}
                />
                <Text style={styles.candidateId}>{candidate.userId}</Text>
              </View>
            );
          })
        )}
      </Card>
      {result.candidates[0] ? (
        <ScoreCard
          match={result.candidates[0].match}
          threshold={result.threshold}
          title="Detalhe do 1º colocado"
        />
      ) : null}
      <CaptchaCard captcha={result.captcha} />
      <QualityCard quality={result.quality} />
    </>
  );
}

const styles = StyleSheet.create({
  decisionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  decisionText: { fontSize: 20, fontWeight: '800', letterSpacing: 0.5 },
  latency: { color: colors.textDim, fontSize: 12 },
  reasons: { marginTop: spacing.sm, gap: 3 },
  reason: { color: colors.text, fontSize: 13, lineHeight: 19 },
  scoreHeader: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.md },
  scoreValue: { color: colors.text, fontSize: 30, fontWeight: '800' },
  scoreValueSmall: { color: colors.text, fontSize: 20, fontWeight: '700' },
  scoreThreshold: { color: colors.textDim, fontSize: 13 },
  sectionLabel: {
    color: colors.textDim,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  captchaHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  footnote: { color: colors.textDim, fontSize: 12, lineHeight: 18, marginTop: spacing.sm },
  issue: { color: colors.stepUp, fontSize: 13, marginTop: spacing.xs, lineHeight: 19 },
  candidate: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  candidateHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  candidateRank: { color: colors.textDim, fontSize: 13, fontWeight: '700', width: 26 },
  candidateName: { color: colors.text, fontSize: 15, fontWeight: '600', flex: 1 },
  candidateScore: { fontSize: 15, fontWeight: '700' },
  candidateId: { color: colors.textDim, fontSize: 11 },
});
