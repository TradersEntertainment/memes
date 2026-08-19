CREATE TABLE "paper_trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"mint" text NOT NULL,
	"wallet" text,
	"signal" text DEFAULT 'insider-buy' NOT NULL,
	"is_live" boolean DEFAULT false NOT NULL,
	"sol_spent" double precision NOT NULL,
	"entry_mc_usd" double precision,
	"entry_ts" timestamp with time zone DEFAULT now() NOT NULL,
	"peak_mc_usd" double precision,
	"peak_ts" timestamp with time zone,
	"last_mc_usd" double precision,
	"last_check_ts" timestamp with time zone,
	"milestone_notified" double precision DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"tx_signature" text,
	CONSTRAINT "paper_trades_mint_unique" UNIQUE("mint")
);
--> statement-breakpoint
CREATE INDEX "paper_trades_status_idx" ON "paper_trades" USING btree ("status");