# Privacidade e LGPD

Não é parecer jurídico. É o mapa do que a PoC faz com os dados e do que muda quando isso
deixar de ser laboratório.

## Dado biométrico é dado pessoal sensível

A LGPD (art. 5º, II) classifica **dado biométrico como sensível**, no mesmo grupo de saúde e
convicção religiosa. Isso é o ponto de partida, e traz três consequências imediatas:

1. **Base legal mais estreita** (art. 11). Consentimento para dado sensível precisa ser
   específico e destacado — "aceito os termos" não cobre. Legítimo interesse **não** vale para
   dado sensível.
2. **Finalidade específica.** Template coletado para autenticação não pode ser reaproveitado
   para perfilamento, analytics ou treinamento de modelo sem nova base legal.
3. **Direito à eliminação** (art. 18). Precisa existir caminho para apagar o template — nesta
   PoC é `DELETE /v1/users/:id`, e ele apaga amostras e template juntos.

Vale registrar que a discussão sobre **biometria comportamental** é mais nova que a sobre
face/digital, e há leitura de que padrão de digitação e de gesto se enquadram como biométricos
na LGPD. Nesta PoC tratamos como sensível — é a hipótese conservadora e a correta para começar.

## O que a PoC coleta

| coletado | não coletado |
|---|---|
| classe da tecla (`char`/`space`/`backspace`/`enter`) + instante | o caractere, o texto, o tamanho do texto |
| pontos do arraste (x, y normalizados 0..1, t) | screenshots, conteúdo de tela |
| posição do toque + tempo de pressão | — |
| acelerômetro e giroscópio a 20 Hz | GPS, localização |
| SO, versão, modelo, diagonal da tela | IMEI, MAC, publicidade |
| `userId` que **você** digita | e-mail, telefone, CPF, nome real (a menos que você digite) |
| IP do cliente (enviado ao `/siteverify` como `remoteip`) | — |

O texto digitado nunca sai do `TextInput`: `mobile/src/capture/recorder.ts` grava classe e
tempo, e o backend nem tem campo para receber conteúdo. Isso é verificável — o tipo
`KeystrokeEvent` só tem `t` e `cls`.

O `journey tracking` do hCaptcha (Enterprise, opcional) registra transições de tela e gestos
básicos; a documentação do SDK afirma que **não** captura conteúdo de texto nem termos de busca.
Se essa afirmação for material para o seu DPO, peça confirmação por escrito ao hCaptcha.

## Onde o dado fica

| dado | onde | forma |
|---|---|---|
| amostras e templates | `server/data/db.json` | **AES-256-GCM** com `TEMPLATE_ENCRYPTION_KEY`; **texto claro** sem ela |
| tokens do hCaptcha já usados | mesmo arquivo | SHA-256 (nunca em claro — há teste) |
| trilha de auditoria | mesmo arquivo | últimos 500 eventos |
| eventos crus da captura | **descartados** | só o vetor de 45 features é gravado |

Detalhe que ajuda: o servidor **não guarda os eventos crus**, só o vetor derivado. Um vetor de
45 números não reconstrói o texto nem o traço do dedo. Isso reduz o dano de um vazamento, mas
**não** é anonimização: o vetor identifica a pessoa — é literalmente essa a função dele.

## O que precisa mudar antes de sair do laboratório

Dois itens desta lista já foram implementados (e testados), mas **vêm desligados por padrão** —
o servidor avisa alto no boot quando estão:

- **Cifra em repouso**: `TEMPLATE_ENCRYPTION_KEY` liga AES-256-GCM nos vetores e templates.
  Falta ainda a chave sair da variável de ambiente para um KMS/HSM.
- **Autenticação da API**: `API_KEYS` fecha tudo menos `/healthz`.

O que continua pendente, em ordem de urgência:

1. **Tirar a chave de cifra da variável de ambiente** e colocar em KMS/HSM, com rotação. Chave
   ao lado do dado cifrado protege contra vazamento do arquivo, não contra acesso ao servidor.
2. **Trocar chave estática de API** por credencial por cliente com expiração, se isso for além
   de laboratório.
3. **Consentimento específico e destacado** antes da primeira captura, com registro de versão
   do texto, data e hora.
4. **Política de retenção** com prazo definido e expurgo automático. "Guardar para sempre"
   não sobrevive ao art. 15.
5. **Trocar JSON por banco** com controle de acesso, log de acesso e backup cifrado. Atenção:
   backup de base cifrada sem a chave é backup inútil — e com a chave ao lado, é vazamento em
   dobro.
6. **Não usar `userId` identificável.** Prefira pseudônimo com o de-para em outro sistema, para
   que um vazamento do template não venha com o nome ao lado.
7. **Relatório de impacto (RIPD)** — art. 38. Para dado sensível em escala é praticamente
   esperado.
8. **Avaliar transferência internacional**: o token vai ao `/siteverify` do hCaptcha (Intuition
   Machines, fora do Brasil) com o IP do cliente. Precisa de base para transferência
   internacional (art. 33).

## Duas armadilhas específicas de biometria comportamental

**Você não "reseta" um template biométrico.** Senha vazada se troca; jeito de digitar, não. É o
argumento mais forte a favor de cifrar em repouso e de manter retenção curta.

**Adaptação de template é vetor de ataque.** `ENROLL_ADAPT_ON_ALLOW` (desligado por padrão)
reforça o template com verificações bem-sucedidas. Ligado sem cuidado, um impostor que passe
raspando algumas vezes desloca o template aos poucos até o dono legítimo ser rejeitado — e o
ataque não deixa rastro óbvio. Se ligar, exija similaridade bem acima do limiar (o código exige
`limiar + 0.1`), limite a taxa de adaptação e mantenha as amostras originais do cadastro.

## Transparência com o usuário

Se isso for para produção, a pessoa precisa entender, em linguagem simples:

- que o **jeito** de digitar e tocar está sendo medido (não o que ela escreve);
- para que serve (autenticação), por quanto tempo fica guardado;
- que existe alternativa para quem não quiser — biometria comportamental exclui gente com
  tremor, artrite, uso de tecnologia assistiva ou simplesmente um dia atípico. Sem caminho
  alternativo, isso vira barreira de acessibilidade, não só questão de privacidade.
