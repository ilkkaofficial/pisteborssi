-- Run separately as owner after migration. Only synthetic JSON is validated.
-- No account/session/password operations and no writes to any application table.
begin;
set transaction read only;
do $checks$
declare
  v_base jsonb := '{"app":"pisteborssi","version":4,"people":[{"id":"synthetic-parent","name":"Synthetic","role":"parent","archived":false}],"entries":[]}'::jsonb;
  v_rule jsonb := '{"id":"synthetic-rule","title":"Synthetic title","content":"<script>plain text</script>","createdBy":"synthetic-parent","updatedBy":"synthetic-parent","createdAt":"2026-10-04T10:00:00.000Z","updatedAt":"2026-10-04T10:00:00.000Z"}'::jsonb;
  v_state jsonb;
  v_bad jsonb;
  v_rejected boolean;
begin
  perform public.pb_validate_state(v_base);
  perform public.pb_validate_state(v_base || '{"rules":[]}'::jsonb);
  v_state := v_base || jsonb_build_object('rules',jsonb_build_array(v_rule));
  perform public.pb_validate_state(v_state);
  perform public.pb_validate_state(v_base || jsonb_build_object('rules', jsonb_build_array(v_rule ||
    jsonb_build_object('deletedAt','2026-10-04T11:00:00.000Z','deletedBy','synthetic-parent','revisions',jsonb_build_array(jsonb_build_object('at','2026-10-04T10:30:00.000Z','by','synthetic-parent','title','Previous','content','Previous content'))))));
  for v_bad in select value from jsonb_array_elements(jsonb_build_array(
    'null'::jsonb, '{}'::jsonb,
    jsonb_build_array(v_rule,v_rule),
    jsonb_build_array(v_rule || '{"title":""}'::jsonb),
    jsonb_build_array(v_rule || jsonb_build_object('content',chr(10)||chr(9))),
    jsonb_build_array(v_rule || jsonb_build_object('title',chr(10))),
    jsonb_build_array(v_rule || jsonb_build_object('updatedBy','unknown-parent')),
    (select jsonb_agg(v_rule || jsonb_build_object('id','limit-'||n)) from generate_series(1,101) n),
    jsonb_build_array(v_rule || jsonb_build_object('revisions',(select jsonb_agg(jsonb_build_object('at','2026-10-04T10:00:00Z','by','synthetic-parent','title','x','content','x')) from generate_series(1,101)))) ,
    jsonb_build_array(v_rule || jsonb_build_object('title',repeat('x',121))),
    jsonb_build_array(v_rule || jsonb_build_object('content',repeat('x',4001))),
    jsonb_build_array(v_rule || '{"createdBy":"not-a-parent"}'::jsonb),
    jsonb_build_array(v_rule || '{"createdAt":"invalid"}'::jsonb),
    jsonb_build_array(v_rule || '{"createdAt":"2026-99-99T00:00:00Z"}'::jsonb),
    jsonb_build_array(v_rule || '{"deletedBy":"synthetic-parent"}'::jsonb),
    jsonb_build_array(v_rule || '{"credential":"not-allowed"}'::jsonb),
    jsonb_build_array(v_rule || '{"revisions":[{"at":"bad","by":"synthetic-parent","title":"x","content":"x"}]}'::jsonb)
  )) loop
    v_rejected := false;
    begin
      perform public.pb_validate_state(v_base || jsonb_build_object('rules',v_bad));
    exception when others then
      if sqlerrm <> 'PB_INVALID_STATE' then raise; end if;
      v_rejected := true;
    end;
    if not v_rejected then raise exception 'PB_RULES_VALIDATION_TEST_FAILED'; end if;
  end loop;
  raise notice 'PB_RULES_SYNTHETIC_VALIDATION_PASSED';
end $checks$;
rollback;
