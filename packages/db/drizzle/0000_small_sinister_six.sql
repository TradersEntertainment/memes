CREATE TYPE "public"."launch_platform" AS ENUM('pumpfun', 'raydium', 'other');--> statement-breakpoint
CREATE TYPE "public"."live_event_type" AS ENUM('buy', 'sell', 'transfer_out', 'transfer_in');--> statement-breakpoint
CREATE TYPE "public"."token_status" AS ENUM('candidate', 'analyzed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."wallet_tier" AS ENUM('insider', 'watch', 'probation', 'blacklist');--> statement-breakpoint
CREATE TABLE "tokens" (
	"mint" text PRIMARY KEY NOT NULL,
	"symbol" text,
	"name" text,
	"creator_wallet" text,
	"launch_platform" "launch_platform",
	"launch_ts" timestamp with time zone,
	"launch_slot" bigint,
	"bonding_curve" text,
	"pool_address" text,
	"ath_mc_usd" double precision,
	"ath_ts" timestamp with time zone,
	"status" "token_status" DEFAULT 'candidate' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"address" text PRIMARY KEY NOT NULL,
	"label" text,
	"tier" "wallet_tier",
	"insider_score" double precision,
	"win_rate" double precision,
	"total_trades" integer,
	"total_pnl_usd" double precision,
	"avg_entry_mc" double precision,
	"score_breakdown" jsonb,
	"first_seen" timestamp with time zone,
	"parent_wallet" text,
	"funding_source" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"last_sig" text,
	"last_activity_ts" timestamp with time zone,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"mint" text NOT NULL,
	"first_buy_ts" timestamp with time zone,
	"first_buy_slot" bigint,
	"seconds_after_launch" double precision,
	"entry_mc_usd" double precision,
	"entry_amount_sol" double precision,
	"token_amount" double precision,
	"pct_of_supply" double precision,
	"exit_mc_usd" double precision,
	"realized_pnl_usd" double precision,
	"still_holding" boolean,
	"creator_linked" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"from_wallet" text NOT NULL,
	"to_wallet" text NOT NULL,
	"amount_sol" double precision NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"signature" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"event_type" "live_event_type" NOT NULL,
	"mint" text,
	"amount_sol" double precision,
	"token_amount" double precision,
	"mc_at_event" double precision,
	"counterparty" text,
	"ts" timestamp with time zone NOT NULL,
	"signature" text NOT NULL,
	"alerted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" bigint,
	"channel" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "sol_prices" (
	"ts" timestamp with time zone PRIMARY KEY NOT NULL,
	"price_usd" double precision NOT NULL
);
--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_wallet_wallets_address_fk" FOREIGN KEY ("wallet") REFERENCES "public"."wallets"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_events" ADD CONSTRAINT "live_events_wallet_wallets_address_fk" FOREIGN KEY ("wallet") REFERENCES "public"."wallets"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_event_id_live_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."live_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "positions_wallet_mint_uq" ON "positions" USING btree ("wallet","mint");--> statement-breakpoint
CREATE INDEX "positions_wallet_idx" ON "positions" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "positions_mint_idx" ON "positions" USING btree ("mint");--> statement-breakpoint
CREATE UNIQUE INDEX "transfers_sig_from_to_uq" ON "transfers" USING btree ("signature","from_wallet","to_wallet");--> statement-breakpoint
CREATE INDEX "transfers_from_idx" ON "transfers" USING btree ("from_wallet");--> statement-breakpoint
CREATE INDEX "transfers_to_idx" ON "transfers" USING btree ("to_wallet");--> statement-breakpoint
CREATE UNIQUE INDEX "live_events_sig_wallet_type_uq" ON "live_events" USING btree ("signature","wallet","event_type");--> statement-breakpoint
CREATE INDEX "live_events_wallet_ts_idx" ON "live_events" USING btree ("wallet","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "live_events_ts_idx" ON "live_events" USING btree ("ts" DESC NULLS LAST);