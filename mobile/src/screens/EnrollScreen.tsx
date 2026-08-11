import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { ApiError, api } from '../api/client';
import type { EnrollResponse } from '../api/contract';
import { useCaptureFlow } from '../capture/useCaptureFlow';
import { CaptureTask } from '../capture/CaptureTask';
import { CaptchaError, useCaptcha } from '../captcha/CaptchaProvider';
import { useServerConfig } from '../ServerConfigProvider';
import { Button, Card, Field, Meter, Notice, Row } from '../components/ui';
import { CaptchaCard, QualityCard } from '../components/ResultView';
import { colors, spacing } from '../theme';
import { describeError } from '../strings';

type Props = NativeStackScreenProps<RootStackParamList, 'Enroll'>;

export function EnrollScreen({ navigation, route }: Props) {
  const { config } = useServerConfig();
  const captcha = useCaptcha();
  const flow = useCaptureFlow('cadastro');

  const [userId, setUserId] = useState(route.params?.userId ?? '');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EnrollResponse | null>(null);

  const required = config?.enrollment.samplesRequired ?? 5;
  const accepted = result?.samplesAccepted ?? 0;
  const enrolled = result?.enrolled ?? false;
  const idInvalid = userId.trim().length > 0 && !/^[A-Za-z0-9._@-]{2,64}$/.test(userId.trim());

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    let token: Awaited<ReturnType<typeof captcha.getToken>> | null = null;
    try {
      token = await captcha.getToken();
      const sample = flow.buildSample(`cadastro-${accepted + 1}`);
      const response = await api.enroll({
        userId: userId.trim(),
        displayName: displayName.trim() || undefined,
        captchaToken: token.token,
        sample,
      });
      token.markUsed();
      setResult(response);
      // cada amostra precisa de captura e sessão novas
      flow.restart();
    } catch (caught) {
      if (caught instanceof CaptchaError) {
        setError(caught.message);
      } else if (caught instanceof ApiError) {
        setError(describeError(caught.code, caught.message));
        if (caught.code.startsWith('session_')) flow.restart();
      } else {
        setError(String(caught));
      }
    } finally {
      setBusy(false);
    }
  }, [accepted, captcha, displayName, flow, userId]);

  const canSubmit = userId.trim().length >= 2 && !idInvalid && flow.ready && !busy && !enrolled;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Card
        title="Cadastro do template comportamental"
        subtitle={`São ${required} capturas da mesma tarefa. O template é a mediana por dimensão mais a dispersão pessoal — por isso uma captura estranha não estraga o cadastro.`}
      >
        <Field
          label="Identificador (sem espaços)"
          value={userId}
          onChangeText={setUserId}
          placeholder="ex.: rodrigo.tazima"
        />
        {idInvalid ? (
          <Notice text="Use apenas letras, números e . _ @ -" tone={colors.deny} />
        ) : null}
        <Field
          label="Nome de exibição (opcional)"
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="ex.: Rodrigo Tazima"
          autoCapitalize="sentences"
        />
        <View style={styles.progress}>
          <Row label="amostras aceitas" value={`${accepted}/${required}`} />
          <Meter
            value={required > 0 ? accepted / required : 0}
            color={enrolled ? colors.allow : colors.primary}
          />
        </View>
      </Card>

      {flow.sessionError ? <Notice text={flow.sessionError} tone={colors.deny} /> : null}
      {error ? <Notice text={error} tone={colors.deny} /> : null}
      {result?.rejected ? (
        <Notice
          text={`Amostra recusada: ${result.rejected.details.join('; ')}. Repita a captura.`}
          tone={colors.stepUp}
        />
      ) : null}

      {enrolled ? (
        <Card title="Cadastro concluído" style={{ borderColor: colors.allow }}>
          <Text style={styles.success}>
            {result?.displayName ?? userId} tem template pronto com {accepted} amostras.
          </Text>
          <View style={styles.actions}>
            <Button
              label="Testar 1:1 com esta pessoa"
              onPress={() => navigation.navigate('Verify', { userId: userId.trim() })}
            />
            <Button label="Testar 1:N" variant="ghost" onPress={() => navigation.navigate('Identify')} />
            <Button
              label="Cadastrar outra pessoa"
              variant="ghost"
              onPress={() => {
                setResult(null);
                setUserId('');
                setDisplayName('');
                flow.restart();
              }}
            />
          </View>
        </Card>
      ) : (
        <>
          <CaptureTask capture={flow.capture} />
          <Button
            label={
              busy
                ? 'enviando…'
                : flow.session == null
                  ? 'aguardando sessão…'
                  : `Enviar amostra ${accepted + 1} de ${required}`
            }
            onPress={submit}
            disabled={!canSubmit}
            loading={busy || captcha.busy}
          />
          <Button label="Recomeçar captura" variant="ghost" onPress={flow.restart} style={styles.spaced} />
        </>
      )}

      {result && !result.rejected ? (
        <View style={styles.spaced}>
          <QualityCard quality={result.quality} />
          <CaptchaCard captcha={result.captcha} />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  progress: { marginTop: spacing.sm },
  actions: { gap: spacing.sm, marginTop: spacing.md },
  success: { color: colors.text, fontSize: 15, lineHeight: 21 },
  spaced: { marginTop: spacing.md },
});
