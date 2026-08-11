-- Schema inicial da PoC.
--
-- Os campos biométricos aparecem em par: `vector`/`sealed_vector` e
-- `template`/`sealed_template`. Com TEMPLATE_ENCRYPTION_KEY definido, só a
-- coluna `sealed_*` é preenchida; sem ela, só a coluna em claro. Assim a mesma
-- base atende os dois modos e dá para migrar sem mexer no schema.

create table if not exists users (
  user_id         text primary key,
  display_name    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  template        jsonb,
  sealed_template text,
  -- garante que nunca haja as duas formas ao mesmo tempo, o que tornaria
  -- ambíguo qual é a verdade
  constraint users_template_single_form check (template is null or sealed_template is null)
);

create table if not exists samples (
  sample_id     uuid primary key,
  user_id       text not null references users(user_id) on delete cascade,
  created_at    timestamptz not null default now(),
  task          text not null,
  quality       jsonb not null,
  vector        jsonb,
  sealed_vector text,
  constraint samples_vector_present check (vector is not null or sealed_vector is not null),
  constraint samples_vector_single_form check (vector is null or sealed_vector is null)
);

-- toda leitura de amostra é por usuário e ordenada por data (trimSamples,
-- corpusStats, getUser)
create index if not exists samples_user_created_idx on samples (user_id, created_at);

create table if not exists capture_sessions (
  session_id  uuid primary key,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz
);

-- usado pela limpeza de sessões vencidas
create index if not exists capture_sessions_expires_idx on capture_sessions (expires_at);

create table if not exists used_tokens (
  token_hash text primary key,
  seen_at    timestamptz not null default now()
);

create table if not exists audit_events (
  event_id   uuid primary key,
  at         timestamptz not null default now(),
  kind       text not null,
  -- sem FK de propósito: apagar a pessoa (LGPD art. 18) põe NULL aqui e
  -- preserva a trilha de decisões. Um ON DELETE CASCADE apagaria a auditoria
  -- junto, e um RESTRICT impediria o direito à eliminação.
  user_id    text,
  decision   text,
  similarity double precision,
  risk       double precision,
  reasons    jsonb not null default '[]'::jsonb,
  detail     jsonb
);

create index if not exists audit_events_at_idx on audit_events (at desc);
