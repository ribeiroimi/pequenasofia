-- ========================================================
-- Pequena Sofia — Schema do banco (Supabase / Postgres)
-- Rode este arquivo inteiro no SQL Editor do Supabase, uma
-- única vez, ao criar o projeto.
-- ========================================================

-- Extensão para gerar UUIDs
create extension if not exists "pgcrypto";

-- ---------- USUÁRIOS ----------
-- Obs: a autenticação (senha, magic link) é feita pelo Supabase Auth,
-- que já cria a tabela auth.users sozinho. Aqui guardamos só os dados
-- de negócio, ligados pelo mesmo id do auth.users.
create table if not exists public.usuarios (
  id              uuid primary key references auth.users(id) on delete cascade,
  nome            text not null,
  email           text unique not null,
  telefone        text,
  cpf             text,                                   -- gravado uma vez, nunca editável pelo usuário
  plano_atual     text not null default 'curioso',         -- 'curioso' | 'pensador' | 'filosofo'
  status          text not null default 'ativo',           -- 'ativo' | 'pagamento_pendente' | 'cancelado' | 'suspenso'
  trial_ativo     boolean not null default true,
  trial_fim       date,
  data_upgrade    timestamptz,
  cakto_customer_email text,                                -- e-mail usado na Cakto, para casar com o webhook
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now()
);

-- ---------- SALDO DE CRÉDITOS ----------
create table if not exists public.creditos_saldo (
  usuario_id      uuid primary key references public.usuarios(id) on delete cascade,
  saldo_atual     integer not null default 0,
  atualizado_em   timestamptz not null default now()
);

-- ---------- EXTRATO DE CRÉDITOS ----------
create table if not exists public.creditos_extrato (
  id              uuid primary key default gen_random_uuid(),
  usuario_id      uuid not null references public.usuarios(id) on delete cascade,
  tipo            text not null,        -- 'credito_mensal' | 'debito_historia' | 'estorno' | 'ajuste_manual'
  quantidade      integer not null,     -- positivo (entrada) ou negativo (saída)
  saldo_apos      integer not null,
  referencia      text,
  criado_em       timestamptz not null default now()
);
create index if not exists idx_extrato_usuario_data on public.creditos_extrato(usuario_id, criado_em desc);

-- ---------- EVENTOS DE WEBHOOK JÁ PROCESSADOS (idempotência) ----------
create table if not exists public.webhook_eventos_processados (
  evento_id       text primary key,
  evento_tipo     text not null,
  processado_em   timestamptz not null default now()
);

-- ---------- HISTÓRIAS GERADAS ----------
create table if not exists public.historias (
  id              uuid primary key default gen_random_uuid(),
  usuario_id      uuid not null references public.usuarios(id) on delete cascade,
  titulo          text,
  tamanho         text not null,        -- 'curta' | 'media' | 'longa'
  creditos_custo  integer not null,
  status          text not null default 'gerando',  -- 'gerando' | 'completa' | 'falha_parcial' | 'falha_total'
  dados_json      jsonb,                 -- guarda cabecalho, dna_visual, historia, nota_pais, plano_ilustracoes
  criado_em       timestamptz not null default now()
);
create index if not exists idx_historias_usuario on public.historias(usuario_id, criado_em desc);

-- ========================================================
-- FUNÇÕES — toda movimentação de crédito passa por aqui,
-- nunca por UPDATE direto do backend, para garantir que
-- duas requisições simultâneas não causem saldo errado.
-- ========================================================

-- Credita (soma) créditos ao saldo do usuário. Usado em:
-- assinatura criada, renovação mensal, upgrade, estorno, ajuste manual.
create or replace function public.creditar(
  p_usuario_id uuid,
  p_quantidade integer,
  p_tipo text,
  p_referencia text default null
) returns integer as $$
declare
  v_saldo integer;
begin
  insert into public.creditos_saldo (usuario_id, saldo_atual)
    values (p_usuario_id, 0)
    on conflict (usuario_id) do nothing;

  update public.creditos_saldo
    set saldo_atual = saldo_atual + p_quantidade,
        atualizado_em = now()
    where usuario_id = p_usuario_id
    returning saldo_atual into v_saldo;

  insert into public.creditos_extrato (usuario_id, tipo, quantidade, saldo_apos, referencia)
    values (p_usuario_id, p_tipo, p_quantidade, v_saldo, p_referencia);

  return v_saldo;
end;
$$ language plpgsql;

-- Debita créditos de forma atômica. Falha (exceção) se saldo insuficiente —
-- o backend deve capturar o erro e responder "créditos insuficientes".
-- SELECT ... FOR UPDATE trava a linha durante a transação, evitando
-- que duas gerações simultâneas debitem por cima uma da outra.
create or replace function public.debitar(
  p_usuario_id uuid,
  p_quantidade integer,   -- valor positivo; a função debita (subtrai) internamente
  p_referencia text default null
) returns integer as $$
declare
  v_saldo_atual integer;
  v_saldo_novo  integer;
begin
  select saldo_atual into v_saldo_atual
    from public.creditos_saldo
    where usuario_id = p_usuario_id
    for update;

  if v_saldo_atual is null then
    raise exception 'usuario_sem_saldo_cadastrado';
  end if;

  if v_saldo_atual < p_quantidade then
    raise exception 'creditos_insuficientes';
  end if;

  v_saldo_novo := v_saldo_atual - p_quantidade;

  update public.creditos_saldo
    set saldo_atual = v_saldo_novo, atualizado_em = now()
    where usuario_id = p_usuario_id;

  insert into public.creditos_extrato (usuario_id, tipo, quantidade, saldo_apos, referencia)
    values (p_usuario_id, 'debito_historia', -p_quantidade, v_saldo_novo, p_referencia);

  return v_saldo_novo;
end;
$$ language plpgsql;

-- ========================================================
-- ROW LEVEL SECURITY — cada usuário só vê os próprios dados.
-- O backend, ao falar com o Supabase, usa a service_role key
-- (que ignora RLS) — então isso protege contra acesso indevido
-- caso algum dia o frontend fale direto com o Supabase.
-- ========================================================
alter table public.usuarios enable row level security;
alter table public.creditos_saldo enable row level security;
alter table public.creditos_extrato enable row level security;
alter table public.historias enable row level security;

create policy "usuario_ve_proprio_perfil" on public.usuarios
  for select using (auth.uid() = id);
create policy "usuario_ve_proprio_saldo" on public.creditos_saldo
  for select using (auth.uid() = usuario_id);
create policy "usuario_ve_proprio_extrato" on public.creditos_extrato
  for select using (auth.uid() = usuario_id);
create policy "usuario_ve_propria_historia" on public.historias
  for select using (auth.uid() = usuario_id);

-- ========================================================
-- REVISÃO — travas e otimizações adicionais
-- (se o schema original já foi rodado, execute só este bloco)
-- ========================================================

-- Cinto de segurança extra: o saldo nunca pode ficar negativo, nem
-- que algum caminho de código futuro pule a função debitar().
alter table public.creditos_saldo
  drop constraint if exists creditos_saldo_nao_negativo;
alter table public.creditos_saldo
  add constraint creditos_saldo_nao_negativo check (saldo_atual >= 0);

-- Boa prática Supabase: fixar o search_path das funções para evitar
-- que um schema malicioso intercepte nomes de tabela.
alter function public.creditar(uuid, integer, text, text) set search_path = public;
alter function public.debitar(uuid, integer, text) set search_path = public;

-- Métricas do backoffice agregadas no banco — evita baixar todos os
-- usuários para contar em JavaScript no endpoint /admin/metricas.
create or replace function public.metricas_admin()
returns jsonb as $$
declare
  v jsonb;
begin
  select jsonb_build_object(
    'total_usuarios', (select count(*) from public.usuarios),
    'usuarios_por_plano', coalesce((
      select jsonb_object_agg(plano_atual, n)
      from (select plano_atual, count(*) as n from public.usuarios group by plano_atual) t
    ), '{}'::jsonb),
    'usuarios_por_status', coalesce((
      select jsonb_object_agg(status, n)
      from (select status, count(*) as n from public.usuarios group by status) t
    ), '{}'::jsonb),
    'total_historias_geradas', (select count(*) from public.historias),
    'historias_ultimos_30_dias', (
      select count(*) from public.historias where criado_em >= now() - interval '30 days'
    ),
    'creditos_em_circulacao', coalesce((select sum(saldo_atual) from public.creditos_saldo), 0)
  ) into v;
  return v;
end;
$$ language plpgsql set search_path = public;
