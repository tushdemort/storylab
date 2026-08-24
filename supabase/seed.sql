-- Local-development participant IDs. Do not use these for a live study.
insert into private.participant_codes(code_normalized, code_display)
values
  ('DEMO001', 'DEMO001'),
  ('DEMO002', 'DEMO002'),
  ('DEMO003', 'DEMO003'),
  ('DEMO004', 'DEMO004')
on conflict (code_normalized) do nothing;
