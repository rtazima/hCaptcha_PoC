import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { ApiError, api } from '../api/client';
import type { UserSummary, VerifyResponse } from '../api/contract';
import { useCaptureFlow } from '../capture/useCaptureFlow';
import { CaptureTask } from '../capture/CaptureTask';
import { CaptchaError, useCaptcha } from '../captcha/CaptchaProvider';
import { Button, Card, Notice } from '../components/ui';
import { VerifyResultView } from '../components/ResultView';
import { colors, radius, spacing } from '../theme';
import { describeError } from '../strings';

type Props = NativeStackScreenProps<RootStackParamList, 'Verify'>;

export function VerifyScreen({ route }: Props) {
  const captcha = useCaptcha();
  const flow = useCaptureFlow('verificacao-1-1');

  const [users, setUsers] = useState<UserSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(route.params?.userId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyResponse | null>(null);

  useEffect(() => {
    api
      .users()
      .then((response) => {
        const enrolled = response.users.filter((user) => user.enrolled);
        setUsers(enrolled);
        setSelected((current) => current ?? enrolled[0]?.userId ?? null);
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError ? describeError(caught.code, caught.message) : String(caught),
        );
      });
  }, []);

  const submit = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const token = await captcha.getToken();
      const sample = flow.buildSample('verificacao-1-1');
      const response = await api.verify({
        userId: selected,
        captchaToken: token.token,
        sample,
      });
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
  }, [captcha, flow, selected]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Card
        title="Verificação 1:1"
        subtitle="Uma comparação: a captura de agora contra o template de quem você afirma ser."
      >
        {users.length === 0 ? (
          <Text style={styles.dim}>Nenhuma pessoa com template. Faça o cadastro primeiro.</Text>
        ) : (
          <View style={styles.chips}>
            {users.map((user) => {
              const active = user.userId === selected;
              return (
                <Pressable
                  key={user.userId}
                  onPress={() => setSelected(user.userId)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {user.displayName ?? user.userId}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
      </Card>

      {flow.sessionError ? <Notice text={flow.sessionError} tone={colors.deny} /> : null}
      {error ? <Notice text={error} tone={colors.deny} /> : null}

      {result ? (
        <>
          <VerifyResultView result={result} />
          <Button label="Nova verificação" onPress={() => setResult(null)} />
        </>
      ) : (
        <>
          <CaptureTask capture={flow.capture} />
          <Button
            label={busy ? 'verificando…' : selected ? `Verificar como ${selected}` : 'Escolha uma pessoa'}
            onPress={submit}
            disabled={!selected || !flow.ready || busy}
            loading={busy || captcha.busy}
          />
          <Button label="Recomeçar captura" variant="ghost" onPress={flow.restart} style={styles.spaced} />
          <Text style={styles.tip}>
            Dica de demo: peça para outra pessoa fazer esta captura escolhendo o seu identificador.
            É assim que se vê a rejeição de impostor.
          </Text>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.cardAlt,
  },
  chipActive: { borderColor: colors.primary, backgroundColor: colors.primaryDark },
  chipText: { color: colors.textDim, fontSize: 14 },
  chipTextActive: { color: '#fff', fontWeight: '600' },
  dim: { color: colors.textDim, fontSize: 13, lineHeight: 19 },
  spaced: { marginTop: spacing.md },
  tip: { color: colors.textDim, fontSize: 12, lineHeight: 18, marginTop: spacing.md },
});
