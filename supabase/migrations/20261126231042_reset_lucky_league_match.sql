create or replace function public.lucky_league_bracket(
  p_action text,
  p_code text default null,
  p_token text default null,
  p_match_id integer default null,
  p_team_id integer default null,
  p_revision integer default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  login_row tournament_private.bracket_login%rowtype;
  board tournament_private.bracket_state%rowtype;
  current_time_utc timestamptz := statement_timestamp();
  session_token text;
  first_team integer;
  second_team integer;
  next_match integer;
  previous_winner integer;
begin
  if p_action = 'read' then
    select * into strict board from tournament_private.bracket_state where id;
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('revision', board.revision, 'winners', board.winners));
  end if;

  if p_action = 'login' then
    if p_code is null or p_code !~ '^[0-9]{5}$' then
      return '{"status":400,"body":{"error":"invalid_request"}}'::jsonb;
    end if;

    select * into strict login_row from tournament_private.bracket_login where id for update;
    if login_row.code_hash is null then
      return '{"status":503,"body":{"error":"unavailable"}}'::jsonb;
    end if;

    if login_row.window_ends <= current_time_utc then
      login_row.failures := 0;
      login_row.window_ends := current_time_utc + interval '10 minutes';
    end if;

    if login_row.failures >= 6 then
      return jsonb_build_object('status', 429, 'body', jsonb_build_object(
        'error', 'rate_limited',
        'retryAfter', greatest(1, ceil(extract(epoch from (login_row.window_ends - current_time_utc)))::integer)
      ));
    end if;

    if extensions.crypt(p_code, login_row.code_hash) <> login_row.code_hash then
      update tournament_private.bracket_login
        set failures = login_row.failures + 1, window_ends = login_row.window_ends
        where id;
      return '{"status":401,"body":{"error":"wrong_code"}}'::jsonb;
    end if;

    delete from tournament_private.bracket_sessions where expires_at <= current_time_utc;
    session_token := encode(extensions.gen_random_bytes(32), 'hex');
    insert into tournament_private.bracket_sessions (token_hash, expires_at)
      values (extensions.digest(session_token, 'sha256'), current_time_utc + interval '12 hours');
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('token', session_token));
  end if;

  if p_action not in ('winner', 'logout', 'reset') or p_action is null then
    return '{"status":400,"body":{"error":"invalid_request"}}'::jsonb;
  end if;

  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or not exists (
    select 1 from tournament_private.bracket_sessions
    where token_hash = extensions.digest(p_token, 'sha256') and expires_at > current_time_utc
  ) then
    return '{"status":401,"body":{"error":"session_expired"}}'::jsonb;
  end if;

  if p_action = 'logout' then
    delete from tournament_private.bracket_sessions where token_hash = extensions.digest(p_token, 'sha256');
    return '{"status":200,"body":{}}'::jsonb;
  end if;

  if p_match_id is null or p_match_id not between 1 and 15 or p_revision is null or p_revision < 0
    or (p_action = 'winner' and (p_team_id is null or p_team_id not between 1 and 16))
    or (p_action = 'reset' and p_team_id is not null) then
    return '{"status":400,"body":{"error":"invalid_request"}}'::jsonb;
  end if;

  select * into strict board from tournament_private.bracket_state where id for update;
  if p_revision <> board.revision then
    return jsonb_build_object('status', 409, 'body', jsonb_build_object(
      'error', 'conflict', 'revision', board.revision, 'winners', board.winners
    ));
  end if;

  if p_action = 'winner' then
    if p_match_id <= 8 then
      first_team := 2 * p_match_id - 1;
      second_team := 2 * p_match_id;
    else
      first_team := (board.winners ->> (2 * p_match_id - 17)::text)::integer;
      second_team := (board.winners ->> (2 * p_match_id - 16)::text)::integer;
    end if;

    if first_team is null or second_team is null or p_team_id not in (first_team, second_team) then
      return '{"status":422,"body":{"error":"invalid_match"}}'::jsonb;
    end if;
  end if;

  previous_winner := (board.winners ->> p_match_id::text)::integer;
  if previous_winner is distinct from p_team_id then
    if previous_winner is not null then
      -- A corrected participant invalidates results on this branch only.
      next_match := p_match_id;
      while next_match < 15 loop
        next_match := 8 + (next_match + 1) / 2;
        board.winners := board.winners - next_match::text;
      end loop;
    end if;

    update tournament_private.bracket_state
      set revision = revision + 1,
          winners = case when p_action = 'reset' then board.winners - p_match_id::text
                         else jsonb_set(board.winners, array[p_match_id::text], to_jsonb(p_team_id)) end
      where id
      returning * into board;
  end if;

  return jsonb_build_object('status', 200, 'body', jsonb_build_object('revision', board.revision, 'winners', board.winners));
end;
$$;
