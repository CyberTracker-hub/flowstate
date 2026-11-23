-- Database-level tests: constraints, row-level security, job queue, nonces.
-- Run by scripts/verify-migrations.sh with ON_ERROR_STOP=1; any failed
-- assertion aborts the run with a non-zero exit code.

\set QUIET on
\o /dev/null
set client_min_messages = warning;

-- Helper: assert that a statement fails with one of the given SQLSTATEs.
create or replace function pg_temp.expect_failure(p_sql text, p_states text[], p_label text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = any (p_states) then
      return;
    end if;
    raise exception 'TEST FAILED (%): expected SQLSTATE % but got % (%)', p_label, p_states, sqlstate, sqlerrm;
  end;
  raise exception 'TEST FAILED (%): statement succeeded but should have been rejected', p_label;
end;
$$;

-- ---------------------------------------------------------------------------
-- fixtures (as the migration owner / service side)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@example.test'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@example.test');
insert into public.users (id, email, display_name) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@example.test', 'Alice'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@example.test', 'Bob');

insert into public.tokens (mint_address, name, symbol, decimals, is_synthetic)
values ('So11111111111111111111111111111111111111112', 'Test Token', 'TEST', 9, true);

insert into public.watchlists (id, user_id, name) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'Alice list'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'Bob list');
insert into public.watchlist_items (watchlist_id, token_id)
select w.id, t.id from public.watchlists w cross join public.tokens t;

insert into public.subscriptions (user_id, stripe_customer_id, plan, status) values
  ('00000000-0000-0000-0000-00000000000a', 'cus_test_alice', 'free', 'active'),
  ('00000000-0000-0000-0000-00000000000b', 'cus_test_bob', 'elite', 'active');

-- ---------------------------------------------------------------------------
-- constraints
-- ---------------------------------------------------------------------------
select pg_temp.expect_failure(
  $$insert into public.tokens (mint_address) values ('So11111111111111111111111111111111111111112')$$,
  array['23505'], 'duplicate (chain, mint) is rejected');

select pg_temp.expect_failure(
  $$insert into public.watchlist_items (watchlist_id, token_id)
    select '10000000-0000-0000-0000-00000000000a', id from public.tokens$$,
  array['23505'], 'duplicate watchlist entry is rejected');

select pg_temp.expect_failure(
  $$insert into public.watchlists (user_id, name) values ('00000000-0000-0000-0000-00000000000a', 'ALICE LIST')$$,
  array['23505'], 'watchlist names are unique per user, case-insensitively');

select pg_temp.expect_failure(
  $$insert into public.tokens (mint_address, logo_url) values ('11111111111111111111111111111111', 'javascript:alert(1)')$$,
  array['23514'], 'non-https logo URLs are rejected');

select pg_temp.expect_failure(
  $$insert into public.alert_rules (user_id, rule_type, operator, threshold)
    values ('00000000-0000-0000-0000-00000000000a', 'anomaly_score', 'gte', 70)$$,
  array['23514'], 'a rule must target a token or a watchlist');

select pg_temp.expect_failure(
  $$insert into public.alert_rules (user_id, token_id, watchlist_id, rule_type, operator, threshold)
    select '00000000-0000-0000-0000-00000000000a', t.id, '10000000-0000-0000-0000-00000000000a', 'anomaly_score', 'gte', 70
      from public.tokens t$$,
  array['23514'], 'a rule cannot target both a token and a watchlist');

select pg_temp.expect_failure(
  $$insert into public.alert_rules (user_id, token_id, rule_type, operator, threshold, cooldown_seconds)
    select '00000000-0000-0000-0000-00000000000a', t.id, 'anomaly_score', 'gte', 70, 1 from public.tokens t$$,
  array['23514'], 'cooldown below 60 seconds is rejected');

-- snapshots: idempotent ingestion and value sanity
insert into public.token_market_snapshots
  (token_id, provider, observed_at, interval_seconds, price_usd, volume_usd, metric_states, metric_completeness, is_synthetic)
select id, 'demo', '2026-01-01 00:05:00+00', 300, 1.25, 0, '{"volumeUsd":"ok","liquidityUsd":"missing"}', 0.5, true
  from public.tokens;

select pg_temp.expect_failure(
  $$insert into public.token_market_snapshots
      (token_id, provider, observed_at, interval_seconds, price_usd, metric_states, metric_completeness)
    select id, 'demo', '2026-01-01 00:05:00+00', 300, 1.25, '{}', 1 from public.tokens$$,
  array['23505'], 'the same (token, provider, observed_at) cannot be ingested twice');

select pg_temp.expect_failure(
  $$insert into public.token_market_snapshots
      (token_id, provider, observed_at, interval_seconds, price_usd, metric_states, metric_completeness)
    select id, 'demo', '2026-01-01 00:10:00+00', 300, -1, '{}', 1 from public.tokens$$,
  array['23514'], 'negative prices are rejected');

do $$
declare
  v_volume numeric;
  v_liquidity numeric;
begin
  select volume_usd, liquidity_usd into v_volume, v_liquidity from public.token_market_snapshots limit 1;
  if v_volume is distinct from 0 then raise exception 'TEST FAILED: a true zero must be stored as 0'; end if;
  if v_liquidity is not null then raise exception 'TEST FAILED: a missing metric must be stored as NULL'; end if;
end $$;

select pg_temp.expect_failure(
  $$insert into public.token_scores (token_id, observed_at, score_version, status, score, confidence, data_coverage, alert_eligible)
    select id, now(), 'v1', 'insufficient_data', 55, 'insufficient', 0.3, false from public.tokens$$,
  array['23514'], 'an insufficient-data evaluation cannot carry a score');

-- events: one open event per token
insert into public.anomaly_events
  (id, token_id, anomaly_type, status, score, peak_score, score_version, severity, peak_severity, confidence,
   origin, detected_at, updated_at, last_evaluated_at, data_coverage, data_freshness_ms, evidence_json, metrics_json)
select '20000000-0000-0000-0000-000000000001', id, 'volume', 'detected', 72, 72, 'fs-score-1.0.0', 'high', 'high', 'high',
       'demo', now(), now(), now(), 1, 1000, '{}', '{}'
  from public.tokens;

select pg_temp.expect_failure(
  $$insert into public.anomaly_events
      (token_id, anomaly_type, status, score, peak_score, score_version, severity, peak_severity, confidence,
       detected_at, updated_at, last_evaluated_at, data_coverage, data_freshness_ms, evidence_json, metrics_json)
    select id, 'liquidity', 'active', 60, 60, 'fs-score-1.0.0', 'unusual', 'unusual', 'medium',
           now(), now(), now(), 1, 1000, '{}', '{}' from public.tokens$$,
  array['23505'], 'a token cannot have two open events');

select pg_temp.expect_failure(
  $$update public.anomaly_events set score = 140$$,
  array['23514'], 'scores above 100 are rejected');

select pg_temp.expect_failure(
  $$update public.anomaly_events set status = 'resolved'$$,
  array['23514'], 'a resolved event must have resolved_at');

update public.anomaly_events set status = 'resolved', resolved_at = now();
-- once resolved, a new event for the same token is allowed
insert into public.anomaly_events
  (token_id, anomaly_type, status, score, peak_score, score_version, severity, peak_severity, confidence,
   detected_at, updated_at, last_evaluated_at, data_coverage, data_freshness_ms, evidence_json, metrics_json)
select id, 'liquidity', 'detected', 60, 60, 'fs-score-1.0.0', 'unusual', 'unusual', 'medium',
       now(), now(), now(), 1, 1000, '{}', '{}' from public.tokens;

-- deliveries and billing events are idempotent
insert into public.alert_deliveries (idempotency_key, user_id, channel)
values ('rule-1:in_app:mint:1767225900000', '00000000-0000-0000-0000-00000000000a', 'in_app');
select pg_temp.expect_failure(
  $$insert into public.alert_deliveries (idempotency_key, user_id, channel)
    values ('rule-1:in_app:mint:1767225900000', '00000000-0000-0000-0000-00000000000a', 'in_app')$$,
  array['23505'], 'a delivery idempotency key cannot be reused');

insert into internal.billing_events (stripe_event_id, event_type, event_created_at)
values ('evt_test_1', 'customer.subscription.updated', now());
select pg_temp.expect_failure(
  $$insert into internal.billing_events (stripe_event_id, event_type, event_created_at)
    values ('evt_test_1', 'customer.subscription.updated', now())$$,
  array['23505'], 'a Stripe event id cannot be recorded twice');

select pg_temp.expect_failure(
  $$update public.subscriptions set plan = 'platinum'$$,
  array['23514'], 'unknown plans are rejected');

-- ---------------------------------------------------------------------------
-- wallet-auth nonces: single use, expiry, replay
-- ---------------------------------------------------------------------------
insert into internal.auth_nonces (nonce_hash, domain, purpose, expires_at) values
  ('hash-valid', 'flowstate.example', 'sign_in', now() + interval '5 minutes'),
  ('hash-expired', 'flowstate.example', 'sign_in', now() - interval '1 second');

do $$
begin
  if internal.consume_nonce('hash-valid') is not true then
    raise exception 'TEST FAILED: a fresh nonce must be consumable';
  end if;
  if internal.consume_nonce('hash-valid') is not false then
    raise exception 'TEST FAILED: a replayed nonce must be rejected';
  end if;
  if internal.consume_nonce('hash-expired') is not false then
    raise exception 'TEST FAILED: an expired nonce must be rejected';
  end if;
  if internal.consume_nonce('hash-unknown') is not false then
    raise exception 'TEST FAILED: an unknown nonce must be rejected';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- durable job queue
-- ---------------------------------------------------------------------------
insert into internal.jobs (queue, payload, dedupe_key, max_attempts) values
  ('ingest', '{"n":1}', 'ingest:1', 2),
  ('ingest', '{"n":2}', 'ingest:2', 2),
  ('ingest', '{"n":3}', 'ingest:3', 2),
  ('explain', '{"n":4}', null, 2);
insert into internal.jobs (queue, run_at) values ('ingest', now() + interval '1 hour');

select pg_temp.expect_failure(
  $$insert into internal.jobs (queue, dedupe_key) values ('ingest', 'ingest:1')$$,
  array['23505'], 'a job dedupe key cannot be enqueued twice');

do $$
declare
  first_batch bigint[];
  second_batch bigint[];
  third_batch bigint[];
  v_status text;
  v_id bigint;
begin
  select array_agg(id) into first_batch from internal.claim_jobs('ingest', 'worker-a', 2);
  select array_agg(id) into second_batch from internal.claim_jobs('ingest', 'worker-b', 5);
  select array_agg(id) into third_batch from internal.claim_jobs('ingest', 'worker-c', 5);

  if coalesce(array_length(first_batch, 1), 0) <> 2 then
    raise exception 'TEST FAILED: first claim should return 2 jobs, got %', first_batch;
  end if;
  if coalesce(array_length(second_batch, 1), 0) <> 1 then
    raise exception 'TEST FAILED: second claim should return the 1 remaining ready job, got %', second_batch;
  end if;
  if first_batch && second_batch then
    raise exception 'TEST FAILED: a job was claimed by two workers';
  end if;
  if third_batch is not null then
    raise exception 'TEST FAILED: future-dated and other-queue jobs must not be claimed, got %', third_batch;
  end if;

  v_id := first_batch[1];
  if internal.complete_job(v_id, 'worker-b') then
    raise exception 'TEST FAILED: a worker completed a job it does not hold';
  end if;
  if not internal.complete_job(v_id, 'worker-a') then
    raise exception 'TEST FAILED: the holder could not complete its job';
  end if;
  if internal.complete_job(v_id, 'worker-a') then
    raise exception 'TEST FAILED: a completed job was completed twice';
  end if;

  -- failure: first failure re-queues, second (attempts = max_attempts) kills it
  v_id := first_batch[2];
  v_status := internal.fail_job(v_id, 'worker-a', 'HTTP 503', interval '0 seconds');
  if v_status <> 'queued' then raise exception 'TEST FAILED: expected re-queue, got %', v_status; end if;
  perform internal.claim_jobs('ingest', 'worker-a', 1);
  v_status := internal.fail_job(v_id, 'worker-a', 'HTTP 503', interval '0 seconds');
  if v_status <> 'dead' then raise exception 'TEST FAILED: expected dead after max attempts, got %', v_status; end if;

  -- a crashed worker's job returns to the queue
  update internal.jobs set locked_at = now() - interval '1 hour' where id = second_batch[1];
  if internal.requeue_stale_jobs(interval '10 minutes') <> 1 then
    raise exception 'TEST FAILED: stale job was not re-queued';
  end if;
  select status into v_status from internal.jobs where id = second_batch[1];
  if v_status <> 'queued' then raise exception 'TEST FAILED: stale job status is %', v_status; end if;
end $$;

-- ---------------------------------------------------------------------------
-- row-level security: act as Alice through the client role
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);

do $$
declare
  n integer;
  v text;
begin
  select count(*) into n from public.users;
  if n <> 1 then raise exception 'TEST FAILED: a user must see exactly their own profile, saw %', n; end if;

  select count(*) into n from public.watchlists;
  if n <> 1 then raise exception 'TEST FAILED: Alice must see only her watchlist, saw %', n; end if;

  select count(*) into n from public.watchlists where user_id = '00000000-0000-0000-0000-00000000000b';
  if n <> 0 then raise exception 'TEST FAILED: Alice can read Bob''s watchlist'; end if;

  select count(*) into n from public.watchlist_items;
  if n <> 1 then raise exception 'TEST FAILED: Alice must see only her watchlist items, saw %', n; end if;

  select count(*) into n from public.subscriptions;
  if n <> 1 then raise exception 'TEST FAILED: Alice must see only her subscription, saw %', n; end if;
  select plan into v from public.subscriptions;
  if v <> 'free' then raise exception 'TEST FAILED: wrong subscription row visible'; end if;

  select count(*) into n from public.alert_deliveries;
  if n <> 1 then raise exception 'TEST FAILED: Alice must see only her deliveries, saw %', n; end if;
end $$;

-- No client writes at all: privilege checks reject them before RLS is consulted.
select pg_temp.expect_failure(
  $$update public.subscriptions set plan = 'elite', status = 'active'$$,
  array['42501'], 'a client cannot upgrade its own subscription');
select pg_temp.expect_failure(
  $$update public.users set role = 'admin'$$,
  array['42501'], 'a client cannot make itself admin');
select pg_temp.expect_failure(
  $$insert into public.watchlists (user_id, name) values ('00000000-0000-0000-0000-00000000000a', 'bypass quota')$$,
  array['42501'], 'a client cannot insert watchlists directly (quota bypass)');
select pg_temp.expect_failure(
  $$delete from public.watchlists$$,
  array['42501'], 'a client cannot delete watchlists directly');
select pg_temp.expect_failure(
  $$insert into public.alert_rules (user_id, token_id, rule_type, operator, threshold) values
    ('00000000-0000-0000-0000-00000000000b', 1, 'anomaly_score', 'gte', 1)$$,
  array['42501'], 'a client cannot create rules for another user');

-- Market data and internals are not readable by clients at all.
select pg_temp.expect_failure($$select * from public.anomaly_events$$, array['42501'], 'events are served by the API only');
select pg_temp.expect_failure($$select * from public.token_market_snapshots$$, array['42501'], 'snapshots are served by the API only');
select pg_temp.expect_failure($$select * from public.ai_explanations$$, array['42501'], 'explanations are served by the API only');
select pg_temp.expect_failure($$select * from internal.jobs$$, array['42501'], 'internal schema is not reachable');
select pg_temp.expect_failure($$select * from internal.billing_events$$, array['42501'], 'billing events are not reachable');
select pg_temp.expect_failure($$select internal.consume_nonce('x')$$, array['42501'], 'internal functions are not callable');

reset role;

-- anonymous visitors see nothing
set role anon;
select pg_temp.expect_failure($$select * from public.users$$, array['42501'], 'anon cannot read users');
select pg_temp.expect_failure($$select * from public.watchlists$$, array['42501'], 'anon cannot read watchlists');
select pg_temp.expect_failure($$select * from public.tokens$$, array['42501'], 'anon cannot read tokens directly');
reset role;

-- account deletion cascades to everything the user owns
delete from auth.users where id = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  n integer;
begin
  select (select count(*) from public.users where id = '00000000-0000-0000-0000-00000000000a')
       + (select count(*) from public.watchlists where user_id = '00000000-0000-0000-0000-00000000000a')
       + (select count(*) from public.subscriptions where user_id = '00000000-0000-0000-0000-00000000000a')
       + (select count(*) from public.alert_deliveries where user_id = '00000000-0000-0000-0000-00000000000a')
    into n;
  if n <> 0 then raise exception 'TEST FAILED: account deletion left % owned rows behind', n; end if;
  select count(*) into n from public.users;
  if n <> 1 then raise exception 'TEST FAILED: deleting Alice affected other users'; end if;
end $$;

\echo 'database tests: all assertions passed'
