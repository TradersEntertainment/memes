-- demo seed for visual verification (idempotent-ish: delete first)
delete from alerts; 
delete from live_events where wallet like 'Demo%' or wallet = 'WatchedWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
delete from positions where wallet like 'Demo%';
delete from wallets where address like 'Demo%' or parent_wallet like 'Demo%';
delete from tokens where mint like 'Demo%';

insert into tokens (mint, symbol, name, creator_wallet, launch_platform, launch_ts, launch_slot, bonding_curve, ath_mc_usd, ath_ts, status) values
('DemoMintWIFAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump','WIF','demo dogwifhat','DemoCreatorAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','pumpfun', now() - interval '9 days', 361000000, 'DemoCurveAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 31500000, now() - interval '2 days','analyzed'),
('DemoMintGOATAAAAAAAAAAAAAAAAAAAAAAAAAAAApump','GOAT','demo goatseus','DemoCreator2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','pumpfun', now() - interval '30 days', 355000000, null, 88000000, now() - interval '20 days','analyzed'),
('DemoMintRUGAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump','RUG','demo rugcoin','DemoCreatorAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','pumpfun', now() - interval '5 days', 360000000, null, 300000, null,'analyzed');

insert into wallets (address, label, tier, insider_score, win_rate, total_trades, total_pnl_usd, avg_entry_mc, score_breakdown, first_seen, parent_wallet, funding_source, is_active, muted, last_activity_ts) values
('DemoInsiderWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA','memelord','insider', 84.2, 0.67, 42, 412000, 52000,
 '{"points":{"repeat":17.5,"creatorLink":25,"winRate":13.6,"selectivity":12.9,"timing":15},"factors":{"repeatFactor":0.7,"creatorLinkFactor":1,"winRate":0.68,"selectivityFactor":0.86,"timingFactor":1},"medianEntrySeconds":95,"bigTokenCount":2,"decidedPositions":9,"earlyPositions":4,"computedAt":"2026-08-17T03:00:00Z"}'::jsonb,
 now() - interval '60 days', null, 'Binance', true, false, now() - interval '10 minutes'),
('DemoWatchWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', null,'watch', 58.0, 0.5, 118, 23000, 145000,
 '{"points":{"repeat":7.5,"creatorLink":0,"winRate":10.4,"selectivity":6.2,"timing":15},"factors":{"repeatFactor":0.3,"creatorLinkFactor":0,"winRate":0.52,"selectivityFactor":0.41,"timingFactor":1},"medianEntrySeconds":210,"bigTokenCount":1,"decidedPositions":14,"earlyPositions":2,"computedAt":"2026-08-17T03:00:00Z"}'::jsonb,
 now() - interval '20 days', null, null, true, false, now() - interval '3 hours'),
('DemoProbationChi1dCCCCCCCCCCCCCCCCCCCCCCCCCC', null,'probation', null, null, null, null, null, null, now() - interval '1 day', 'DemoInsiderWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA', null, true, false, now() - interval '30 minutes');

insert into positions (wallet, mint, first_buy_ts, first_buy_slot, seconds_after_launch, entry_mc_usd, entry_amount_sol, token_amount, pct_of_supply, exit_mc_usd, realized_pnl_usd, still_holding, creator_linked) values
('DemoInsiderWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA','DemoMintWIFAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump', now() - interval '9 days' + interval '95 seconds', 361000238, 95, 42000, 12.5, 178571428, 17.8, 2400000, 385000, false, true),
('DemoInsiderWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA','DemoMintGOATAAAAAAAAAAAAAAAAAAAAAAAAAAAApump', now() - interval '30 days' + interval '4 minutes', 355000600, 240, 68000, 20, 150000000, 15.0, 1900000, 96000, false, true),
('DemoInsiderWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA','DemoMintRUGAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump', now() - interval '5 days' + interval '30 seconds', 360000075, 30, 28000, 8, 90000000, 9.0, 19000, -21000, false, true),
('DemoWatchWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBB','DemoMintWIFAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump', now() - interval '9 days' + interval '6 minutes', 361000900, 360, 145000, 5, 30000000, 3.0, null, null, true, false),
('DemoInsiderWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA','DemoMintXAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump', now() - interval '15 days', null, null, null, 4, 12000000, null, null, 5200, false, false),
('DemoInsiderWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA','DemoMintYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump', now() - interval '12 days', null, null, 890000, 6, 8000000, 0.8, null, -6100, false, false);

insert into live_events (wallet, event_type, mint, amount_sol, token_amount, mc_at_event, counterparty, ts, signature, alerted) values
('DemoInsiderWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA','buy','DemoMintWIFAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump', 12.5, 178571428, 45300, null, now() - interval '4 minutes','DemoSigBuy1', true),
('DemoWatchWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBB','buy','DemoMintWIFAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump', 3.2, 21000000, 61000, null, now() - interval '18 minutes','DemoSigBuy2', true),
('DemoInsiderWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA','sell','DemoMintGOATAAAAAAAAAAAAAAAAAAAAAAAAAAAApump', 55, 140000000, 1900000, null, now() - interval '2 hours','DemoSigSell1', true),
('DemoInsiderWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA','transfer_out', null, 8, null, null, 'DemoProbationChi1dCCCCCCCCCCCCCCCCCCCCCCCCCC', now() - interval '1 day','DemoSigRot1', true),
('DemoProbationChi1dCCCCCCCCCCCCCCCCCCCCCCCCCC','buy','DemoMintRUGAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump', 4.2, 50000000, 23000, null, now() - interval '30 minutes','DemoSigBuy3', true);
