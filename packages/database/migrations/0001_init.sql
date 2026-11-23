-- FLOWSTATE initial schema (PostgreSQL 15+ / Supabase).
--
-- Access model
--   * The browser never writes to the database directly. Every write goes
--     through the server (Next.js route handlers / worker) using the service
--     role, where ownership, plan limits and validation are enforced.
--   * Row-level security is enabled on every table in `public` as defence in
--     depth. Authenticated users get read access to their OWN rows only.
--     Market-data tables have no client policies at all: reads are served by
--     the API, which applies plan entitlements (delay, history depth).
--   * `internal` holds operational tables. It is not exposed through the
--     Supabase API and is reachable by the service role only.
--
-- Expects the Supabase `auth` schema (auth.users, auth.uid()) and the roles
-- anon / authenticated / service_role to exist.

create schema if not exists internal;
revoke all on schema internal from public;
revoke all on schema internal from anon, authenticated;
grant usage on schema internal to service_role;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- users and identity
-- ---------------------------------------------------------------------------

create table public.users (
  id              uuid primary key references auth.users (id) on delete cascade,
  email           text,                       -- copy for display; credentials live in auth.users
  display_name    text check (char_length(display_name) <= 80),
  role            text not null default 'user' check (role in ('user', 'admin')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create unique index users_email_key on public.users (lower(email)) where email is not null and deleted_at is null;
create trigger users_set_updated_at before update on public.users
  for each row execute function public.set_updated_at();

create table public.user_wallets (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users (id) on delete cascade,
  wallet_address  text not null check (char_length(wallet_address) between 32 and 44),
  verified_at     timestamptz not null,       -- set only after a verified signature
  created_at      timestamptz not null default now(),
  unique (wallet_address)                     -- one wallet identifies one account
);
create index user_wallets_user_id_idx on public.user_wallets (user_id);

-- Sign-In-With-Solana challenges. Only a hash of the nonce is stored.
create table internal.auth_nonces (
  nonce_hash      text primary key,
  wallet_address  text,
  domain          text not null,
  purpose         text not null check (purpose in ('sign_in', 'link_wallet')),
  user_id         uuid references public.users (id) on delete cascade,
  expires_at      timestamptz not null,
  used_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index auth_nonces_expires_at_idx on internal.auth_nonces (expires_at);

-- Atomically consume a nonce: succeeds exactly once, and only before expiry.
create or replace function internal.consume_nonce(p_nonce_hash text) returns boolean
language plpgsql as $$
declare
  consumed integer;
begin
  update internal.auth_nonces
     set used_at = now()
   where nonce_hash = p_nonce_hash
     and used_at is null
     and expires_at > now();
  get diagnostics consumed = row_count;
  return consumed = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- tokens and market data
-- ---------------------------------------------------------------------------

create table public.tokens (
  id               bigint generated always as identity primary key,
  chain            text not null default 'solana' check (chain in ('solana')),
  mint_address     text not null check (char_length(mint_address) between 32 and 44),
  name             text check (char_length(name) <= 64),
  symbol           text check (char_length(symbol) <= 16),
  decimals         smallint check (decimals between 0 and 18),
  logo_url         text check (logo_url is null or logo_url like 'https://%'),
  metadata_status  text not null default 'unverified'
                     check (metadata_status in ('unverified', 'verified', 'flagged')),
  is_tracked       boolean not null default false,
  is_synthetic     boolean not null default false,   -- demo fixtures only
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (chain, mint_address)                         -- the mint is the canonical identity
);
create index tokens_symbol_idx on public.tokens (lower(symbol) text_pattern_ops);
create index tokens_name_idx on public.tokens (lower(name) text_pattern_ops);
create index tokens_tracked_idx on public.tokens (id) where is_tracked;
create trigger tokens_set_updated_at before update on public.tokens
  for each row execute function public.set_updated_at();

-- A NULL metric column means "no usable value". WHY it is unusable (missing,
-- stale, unsupported, provider error) is recorded per metric in metric_states.
-- A true zero is stored as 0 with state "ok".
create table public.token_market_snapshots (
  id                   bigint generated always as identity primary key,
  token_id             bigint not null references public.tokens (id) on delete cascade,
  provider             text not null,
  observed_at          timestamptz not null,          -- end of the interval, bucket-aligned
  interval_seconds     integer not null check (interval_seconds > 0),
  provider_timestamp   timestamptz,
  ingested_at          timestamptz not null default now(),
  price_usd            numeric(38, 18) check (price_usd > 0),
  liquidity_usd        numeric(30, 6) check (liquidity_usd >= 0),
  market_cap_usd       numeric(30, 2) check (market_cap_usd >= 0),
  volume_usd           numeric(30, 6) check (volume_usd >= 0),
  trade_count          bigint check (trade_count >= 0),
  buy_count            bigint check (buy_count >= 0),
  sell_count           bigint check (sell_count >= 0),
  unique_buyers        bigint check (unique_buyers >= 0),
  unique_sellers       bigint check (unique_sellers >= 0),
  holder_count         bigint check (holder_count >= 0),
  largest_trade_usd    numeric(30, 6) check (largest_trade_usd >= 0),
  pool_id              text,
  metric_states        jsonb not null,
  metric_completeness  numeric(5, 4) not null check (metric_completeness between 0 and 1),
  is_synthetic         boolean not null default false,
  unique (token_id, provider, observed_at)             -- makes ingestion idempotent
);
create index token_market_snapshots_token_time_idx
  on public.token_market_snapshots (token_id, observed_at desc);

create table public.token_activity_aggregates (
  id                 bigint generated always as identity primary key,
  token_id           bigint not null references public.tokens (id) on delete cascade,
  period_start       timestamptz not null,
  period_end         timestamptz not null,
  volume_usd         numeric(30, 6) check (volume_usd >= 0),
  transaction_count  bigint check (transaction_count >= 0),
  buy_count          bigint check (buy_count >= 0),
  sell_count         bigint check (sell_count >= 0),
  unique_buyers      bigint check (unique_buyers >= 0),
  unique_sellers     bigint check (unique_sellers >= 0),
  data_quality       jsonb not null default '{}'::jsonb,
  check (period_end > period_start),
  unique (token_id, period_start, period_end)
);

-- One row per evaluated snapshot: the score time series, and the marker that
-- a snapshot has been fully processed (so retried jobs do not repeat work).
create table public.token_scores (
  token_id        bigint not null references public.tokens (id) on delete cascade,
  observed_at     timestamptz not null,
  score_version   text not null,
  status          text not null check (status in ('scored', 'insufficient_data')),
  score           smallint check (score between 0 and 100),
  severity        text check (severity in ('normal', 'elevated', 'unusual', 'high', 'extreme')),
  confidence      text not null check (confidence in ('insufficient', 'low', 'medium', 'high')),
  data_coverage   numeric(5, 4) not null check (data_coverage between 0 and 1),
  alert_eligible  boolean not null,
  evaluated_at    timestamptz not null default now(),
  primary key (token_id, observed_at, score_version),
  check ((status = 'scored') = (score is not null))
);

-- ---------------------------------------------------------------------------
-- anomaly events
-- ---------------------------------------------------------------------------

create table public.anomaly_events (
  id                      uuid primary key default gen_random_uuid(),
  token_id                bigint not null references public.tokens (id) on delete cascade,
  anomaly_type            text not null check (anomaly_type in (
                            'volume', 'buyer_activity', 'buy_sell_imbalance', 'liquidity',
                            'large_transaction', 'price_volume_divergence', 'composite')),
  status                  text not null check (status in ('detected', 'active', 'updated', 'resolved', 'expired')),
  score                   smallint not null check (score between 0 and 100),
  peak_score              smallint not null check (peak_score between 0 and 100),
  score_version           text not null,
  severity                text not null check (severity in ('normal', 'elevated', 'unusual', 'high', 'extreme')),
  peak_severity           text not null check (peak_severity in ('normal', 'elevated', 'unusual', 'high', 'extreme')),
  confidence              text not null check (confidence in ('insufficient', 'low', 'medium', 'high')),
  -- 'live' = detected as data arrived. 'backfill' = computed later from
  -- provider history; must never be presented as a live alert. 'demo' = fixtures.
  origin                  text not null default 'live' check (origin in ('live', 'backfill', 'demo')),
  detected_at             timestamptz not null,
  updated_at              timestamptz not null,
  last_evaluated_at       timestamptz not null,
  resolved_at             timestamptz,
  below_threshold_since   timestamptz,
  last_notified_at        timestamptz,
  last_notified_severity  text check (last_notified_severity in ('normal', 'elevated', 'unusual', 'high', 'extreme')),
  update_count            integer not null default 0 check (update_count >= 0),
  data_coverage           numeric(5, 4) not null check (data_coverage between 0 and 1),
  data_freshness_ms       bigint not null check (data_freshness_ms >= 0),
  evidence_json           jsonb not null,     -- full engine output at peak
  metrics_json            jsonb not null,     -- source metrics at detection time
  provider_refs           jsonb not null default '[]'::jsonb,
  explanation_status      text not null default 'none'
                            check (explanation_status in ('none', 'queued', 'ready', 'fallback', 'failed')),
  check (peak_score >= score),
  check ((status in ('resolved', 'expired')) = (resolved_at is not null))
);
-- At most one open event per token: updates extend it instead of duplicating it.
create unique index anomaly_events_one_open_per_token
  on public.anomaly_events (token_id) where status in ('detected', 'active', 'updated');
create index anomaly_events_detected_at_idx on public.anomaly_events (detected_at desc);
create index anomaly_events_token_time_idx on public.anomaly_events (token_id, detected_at desc);
create index anomaly_events_severity_time_idx on public.anomaly_events (severity, detected_at desc);

create table public.anomaly_event_transitions (
  id           bigint generated always as identity primary key,
  event_id     uuid not null references public.anomaly_events (id) on delete cascade,
  from_status  text,
  to_status    text not null,
  at           timestamptz not null,
  score        smallint check (score between 0 and 100),
  reason       text not null
);
create index anomaly_event_transitions_event_idx on public.anomaly_event_transitions (event_id, at);

create table public.anomaly_factors (
  id              bigint generated always as identity primary key,
  event_id        uuid not null references public.anomaly_events (id) on delete cascade,
  factor_type     text not null check (factor_type in (
                    'volume', 'buyer_activity', 'buy_sell_imbalance', 'liquidity',
                    'large_transaction', 'price_volume_divergence')),
  status          text not null check (status in ('available', 'unavailable')),
  max_points      numeric(6, 2) not null check (max_points >= 0),
  factor_score    numeric(8, 4) check (factor_score >= 0),   -- NULL when unavailable
  observed_value  numeric,
  baseline_value  numeric,
  unavailable_reason text,
  metadata_json   jsonb not null default '{}'::jsonb,
  unique (event_id, factor_type),
  check ((status = 'available') = (factor_score is not null)),
  check ((status = 'unavailable') = (unavailable_reason is not null))
);

create table public.ai_explanations (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references public.anomaly_events (id) on delete cascade,
  model             text not null,              -- 'fallback' for the non-AI explanation
  prompt_version    text not null,
  input_hash        text not null,              -- hash of the structured evidence (cache key)
  summary           text not null,
  explanation_json  jsonb not null,
  generated_at      timestamptz not null default now(),
  input_tokens      integer check (input_tokens >= 0),
  output_tokens     integer check (output_tokens >= 0),
  estimated_cost    numeric(12, 6) check (estimated_cost >= 0),
  status            text not null check (status in ('ready', 'fallback', 'failed')),
  unique (event_id, prompt_version, input_hash)
);

-- Explicitly public reports. Nothing is public unless a row exists here.
create table public.public_reports (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9-]{8,64}$'),
  event_id    uuid not null references public.anomaly_events (id) on delete cascade,
  created_by  uuid references public.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

-- ---------------------------------------------------------------------------
-- watchlists and alerts
-- ---------------------------------------------------------------------------

create table public.watchlists (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  created_at  timestamptz not null default now()
);
create unique index watchlists_user_name_key on public.watchlists (user_id, lower(name));

create table public.watchlist_items (
  id            uuid primary key default gen_random_uuid(),
  watchlist_id  uuid not null references public.watchlists (id) on delete cascade,
  token_id      bigint not null references public.tokens (id) on delete cascade,
  added_at      timestamptz not null default now(),
  unique (watchlist_id, token_id)
);
create index watchlist_items_token_idx on public.watchlist_items (token_id);

create table public.alert_rules (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users (id) on delete cascade,
  token_id          bigint references public.tokens (id) on delete cascade,
  watchlist_id      uuid references public.watchlists (id) on delete cascade,
  rule_type         text not null check (rule_type in (
                      'anomaly_score', 'volume_ratio', 'liquidity_change', 'price_change',
                      'watchlist_high_severity')),
  operator          text not null check (operator in ('gt', 'gte', 'lt', 'lte', 'abs_gte')),
  threshold         numeric not null,
  min_confidence    text not null default 'medium' check (min_confidence in ('low', 'medium', 'high')),
  cooldown_seconds  integer not null default 900 check (cooldown_seconds between 60 and 86400),
  channel           text not null default 'in_app' check (channel in ('in_app', 'telegram')),
  enabled           boolean not null default true,
  created_at        timestamptz not null default now(),
  -- a rule targets exactly one of: a token, or a watchlist
  check ((token_id is not null) <> (watchlist_id is not null)),
  check (rule_type <> 'watchlist_high_severity' or watchlist_id is not null)
);
create index alert_rules_user_idx on public.alert_rules (user_id);
create index alert_rules_token_idx on public.alert_rules (token_id) where enabled;
create index alert_rules_watchlist_idx on public.alert_rules (watchlist_id) where enabled;

create table public.alert_deliveries (
  id                uuid primary key default gen_random_uuid(),
  idempotency_key   text not null unique,        -- blocks duplicate deliveries on retries
  user_id           uuid not null references public.users (id) on delete cascade,
  rule_id           uuid references public.alert_rules (id) on delete set null,
  anomaly_event_id  uuid references public.anomaly_events (id) on delete set null,
  token_id          bigint references public.tokens (id) on delete set null,
  channel           text not null check (channel in ('in_app', 'telegram')),
  status            text not null default 'queued'
                      check (status in ('queued', 'sending', 'sent', 'failed', 'suppressed')),
  observed_value    numeric,
  attempt_count     integer not null default 0 check (attempt_count >= 0),
  next_attempt_at   timestamptz,
  created_at        timestamptz not null default now(),
  sent_at           timestamptz,
  error_code        text
);
create index alert_deliveries_user_time_idx on public.alert_deliveries (user_id, created_at desc);
create index alert_deliveries_pending_idx on public.alert_deliveries (next_attempt_at)
  where status in ('queued', 'failed');

create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users (id) on delete cascade,
  delivery_id  uuid references public.alert_deliveries (id) on delete set null,
  title        text not null,
  body         text not null,
  created_at   timestamptz not null default now(),
  read_at      timestamptz
);
create index notifications_user_time_idx on public.notifications (user_id, created_at desc);

create table public.telegram_connections (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users (id) on delete cascade,
  telegram_chat_id  bigint not null,
  connected_at      timestamptz not null default now(),
  revoked_at        timestamptz
);
create unique index telegram_connections_one_active_per_user
  on public.telegram_connections (user_id) where revoked_at is null;

-- One-time tokens for linking a Telegram chat. Only the hash is stored.
create table internal.telegram_link_tokens (
  token_hash  text primary key,
  user_id     uuid not null references public.users (id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- billing
-- ---------------------------------------------------------------------------

create table public.subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null unique references public.users (id) on delete cascade,
  stripe_customer_id      text not null unique,
  stripe_subscription_id  text unique,
  plan                    text not null default 'free' check (plan in ('free', 'pro', 'elite')),
  status                  text not null check (status in (
                            'incomplete', 'incomplete_expired', 'trialing', 'active',
                            'past_due', 'canceled', 'unpaid', 'paused')),
  current_period_end      timestamptz,
  cancel_at_period_end    boolean not null default false,
  -- `created` of the newest Stripe event applied; older events arriving late are ignored.
  last_event_created_at   timestamptz,
  updated_at              timestamptz not null default now()
);
create trigger subscriptions_set_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

create table internal.billing_events (
  id                 bigint generated always as identity primary key,
  stripe_event_id    text not null unique,       -- makes webhook processing idempotent
  event_type         text not null,
  event_created_at   timestamptz not null,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  processing_status  text not null default 'received'
                       check (processing_status in ('received', 'processed', 'ignored', 'failed')),
  error              text
);

create table public.usage_counters (
  user_id       uuid not null references public.users (id) on delete cascade,
  metric        text not null check (metric in ('ai_explanations', 'event_details', 'api_requests')),
  period_start  date not null,
  count         integer not null default 0 check (count >= 0),
  primary key (user_id, metric, period_start)
);

create table public.referrals (
  user_id      uuid primary key references public.users (id) on delete cascade,
  source       text not null check (char_length(source) <= 64),
  signup_at    timestamptz not null default now(),
  trial_at     timestamptz,
  paid_at      timestamptz
);

-- ---------------------------------------------------------------------------
-- operations (internal)
-- ---------------------------------------------------------------------------

create table internal.provider_status (
  id          bigint generated always as identity primary key,
  provider    text not null,
  checked_at  timestamptz not null default now(),
  status      text not null check (status in ('ok', 'degraded', 'down')),
  latency_ms  integer check (latency_ms >= 0),
  error_code  text
);
create index provider_status_provider_time_idx on internal.provider_status (provider, checked_at desc);

create table internal.ingestion_checkpoints (
  id               bigint generated always as identity primary key,
  provider         text not null,
  stream_key       text not null,
  cursor           text,
  last_success_at  timestamptz,
  updated_at       timestamptz not null default now(),
  unique (provider, stream_key)
);

create table internal.audit_logs (
  id             bigint generated always as identity primary key,
  actor_id       uuid,
  action         text not null,
  target_type    text not null,
  target_id      text,
  created_at     timestamptz not null default now(),
  metadata_json  jsonb not null default '{}'::jsonb
);
create index audit_logs_time_idx on internal.audit_logs (created_at desc);

create table internal.ai_usage (
  day                 date not null,
  model               text not null,
  requests            integer not null default 0 check (requests >= 0),
  input_tokens        bigint not null default 0 check (input_tokens >= 0),
  output_tokens       bigint not null default 0 check (output_tokens >= 0),
  estimated_cost_usd  numeric(12, 6) not null default 0 check (estimated_cost_usd >= 0),
  primary key (day, model)
);

create table internal.runtime_flags (
  key         text primary key,                 -- e.g. 'pause:worker:ingestion', 'pause:channel:telegram'
  value       jsonb not null,
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);

-- Durable job queue.
create table internal.jobs (
  id            bigint generated always as identity primary key,
  queue         text not null,
  payload       jsonb not null default '{}'::jsonb,
  dedupe_key    text unique,                    -- optional: at most one job per key, ever
  status        text not null default 'queued'
                  check (status in ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempts      integer not null default 0 check (attempts >= 0),
  max_attempts  integer not null default 5 check (max_attempts > 0),
  run_at        timestamptz not null default now(),
  locked_by     text,
  locked_at     timestamptz,
  last_error    text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index jobs_ready_idx on internal.jobs (queue, run_at) where status = 'queued';
create index jobs_running_idx on internal.jobs (locked_at) where status = 'running';

-- Claim up to p_limit ready jobs. SKIP LOCKED lets several workers poll
-- concurrently without ever handing the same job to two of them.
create or replace function internal.claim_jobs(p_queue text, p_worker text, p_limit integer)
returns setof internal.jobs
language sql as $$
  update internal.jobs j
     set status = 'running', locked_by = p_worker, locked_at = now(), attempts = j.attempts + 1
   where j.id in (
           select id from internal.jobs
            where queue = p_queue and status = 'queued' and run_at <= now()
            order by run_at, id
            limit greatest(p_limit, 0)
            for update skip locked)
  returning j.*;
$$;

-- Finish a job. Only a job that is currently running can be completed, so a
-- finished job can never be completed (or re-run) twice.
create or replace function internal.complete_job(p_id bigint, p_worker text) returns boolean
language plpgsql as $$
declare
  n integer;
begin
  update internal.jobs
     set status = 'succeeded', completed_at = now(), locked_by = null, locked_at = null
   where id = p_id and status = 'running' and locked_by = p_worker;
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

-- Fail a job: re-queue with a delay, or mark it dead when attempts are used up.
create or replace function internal.fail_job(p_id bigint, p_worker text, p_error text, p_retry_in interval)
returns text
language plpgsql as $$
declare
  new_status text;
begin
  update internal.jobs
     set status = case when attempts >= max_attempts then 'dead' else 'queued' end,
         run_at = case when attempts >= max_attempts then run_at else now() + p_retry_in end,
         last_error = left(p_error, 2000),
         locked_by = null,
         locked_at = null
   where id = p_id and status = 'running' and locked_by = p_worker
  returning status into new_status;
  return new_status;
end;
$$;

-- Return jobs whose worker died (lock older than p_timeout) to the queue.
create or replace function internal.requeue_stale_jobs(p_timeout interval) returns integer
language plpgsql as $$
declare
  n integer;
begin
  update internal.jobs
     set status = case when attempts >= max_attempts then 'dead' else 'queued' end,
         locked_by = null,
         locked_at = null,
         last_error = 'worker lock timed out'
   where status = 'running' and locked_at < now() - p_timeout;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Retention: delete raw snapshots/scores older than the given ages.
create or replace function internal.prune_market_data(p_snapshot_age interval, p_score_age interval)
returns table (snapshots_deleted bigint, scores_deleted bigint)
language plpgsql as $$
begin
  delete from public.token_market_snapshots where observed_at < now() - p_snapshot_age;
  get diagnostics snapshots_deleted = row_count;
  delete from public.token_scores where observed_at < now() - p_score_age;
  get diagnostics scores_deleted = row_count;
  delete from internal.auth_nonces where expires_at < now() - interval '1 day';
  delete from internal.telegram_link_tokens where expires_at < now() - interval '1 day';
  return next;
end;
$$;

revoke all on all tables in schema internal from public, anon, authenticated;
revoke all on all functions in schema internal from public, anon, authenticated;
grant all on all tables in schema internal to service_role;
grant all on all sequences in schema internal to service_role;
grant execute on all functions in schema internal to service_role;

-- ---------------------------------------------------------------------------
-- row-level security
-- ---------------------------------------------------------------------------

alter table public.users                      enable row level security;
alter table public.user_wallets               enable row level security;
alter table public.tokens                     enable row level security;
alter table public.token_market_snapshots     enable row level security;
alter table public.token_activity_aggregates  enable row level security;
alter table public.token_scores               enable row level security;
alter table public.anomaly_events             enable row level security;
alter table public.anomaly_event_transitions  enable row level security;
alter table public.anomaly_factors            enable row level security;
alter table public.ai_explanations            enable row level security;
alter table public.public_reports             enable row level security;
alter table public.watchlists                 enable row level security;
alter table public.watchlist_items            enable row level security;
alter table public.alert_rules                enable row level security;
alter table public.alert_deliveries           enable row level security;
alter table public.notifications              enable row level security;
alter table public.telegram_connections       enable row level security;
alter table public.subscriptions              enable row level security;
alter table public.usage_counters             enable row level security;
alter table public.referrals                  enable row level security;

-- Clients may only ever SELECT, and only through the policies below.
-- Supabase grants broad table privileges to anon/authenticated by default;
-- take them away for existing tables and for tables created by later migrations.
alter default privileges in schema public revoke all on tables from anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant select on
  public.users, public.user_wallets, public.watchlists, public.watchlist_items,
  public.alert_rules, public.alert_deliveries, public.notifications,
  public.telegram_connections, public.subscriptions, public.usage_counters
  to authenticated;

create policy users_select_own on public.users
  for select to authenticated using (id = auth.uid());
create policy user_wallets_select_own on public.user_wallets
  for select to authenticated using (user_id = auth.uid());
create policy watchlists_select_own on public.watchlists
  for select to authenticated using (user_id = auth.uid());
create policy watchlist_items_select_own on public.watchlist_items
  for select to authenticated using (
    exists (select 1 from public.watchlists w where w.id = watchlist_id and w.user_id = auth.uid()));
create policy alert_rules_select_own on public.alert_rules
  for select to authenticated using (user_id = auth.uid());
create policy alert_deliveries_select_own on public.alert_deliveries
  for select to authenticated using (user_id = auth.uid());
create policy notifications_select_own on public.notifications
  for select to authenticated using (user_id = auth.uid());
create policy telegram_connections_select_own on public.telegram_connections
  for select to authenticated using (user_id = auth.uid());
create policy subscriptions_select_own on public.subscriptions
  for select to authenticated using (user_id = auth.uid());
create policy usage_counters_select_own on public.usage_counters
  for select to authenticated using (user_id = auth.uid());
