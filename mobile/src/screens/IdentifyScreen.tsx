import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { ApiError, api } from '../api/client';
import type { IdentifyResponse } from '../api/contract';
import { useCaptureFlow } from '../capture/useCaptureFlow';
import { CaptureTask } from '../capture/CaptureTask';
import { CaptchaError, useCaptcha } from '../captcha/CaptchaProvider';
import { Button, Card, Notice } from '../components/ui';
import { IdentifyResultView } from '../components/ResultView';
import { colors, spacing } from '../theme';
import { describeError } from '../strings';

type Props = NativeStackScreenProps<RootStackParamList, 'Identify'>;

export function IdentifyScreen(_props: Props) {
  const captcha = useCaptcha();
  const flow = useCaptureFlow('identificacao-1-n');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IdentifyResponse | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const token = await captcha.getToken();
      const sample = flow.buildSample('identificacao-1-n');
      const response = await api.identify({ captchaToken: token.token, sample, topK: 5 });
      token.markUsed();
      setResult(response);
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
  }, [captcha, flow]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Card
        title="Identificação 1:N"
        subtitle="Sem dizer quem você é: a captura é comparada com toda a galeria e o servidor devolve o ranking."
      >
        <Text style={styles.dim}>
          O 1:N usa limiar mais alto que o 1:1 e exige margem mínima entre o 1º e o 2º colocado.
          Como se pega o máximo de N comparações, a chance de um impostor cruzar o limiar cresce
          com o tamanho da galeria — identificar é mais difícil que verificar.
        </Text>
      </Card>

      {flow.sessionError ? <Notice text={flow.sessionError} tone={colors.deny} /> : null}
      {error ? <Notice text={error} tone={colors.deny} /> : null}

      {result ? (
        <>
          <IdentifyResultView result={result} />
          <Button label="Nova identificação" onPress={() => setResult(null)} />
        </>
      ) : (
        <>
          <CaptureTask capture={flow.capture} />
          <Button
            label={busy ? 'buscando na galeria…' : 'Identificar quem sou'}
            onPress={submit}
            disabled={!flow.ready || busy}
            loading={busy || captcha.busy}
          />
          <Button label="Recomeçar captura" variant="ghost" onPress={flow.restart} style={styles.spaced} />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  dim: { color: colors.textDim, fontSize: 13, lineHeight: 19 },
  spaced: { marginTop: spacing.md },
});
