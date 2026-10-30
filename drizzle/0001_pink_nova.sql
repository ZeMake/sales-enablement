CREATE TABLE `stability_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`call_id` text NOT NULL,
	`playbook_id` text NOT NULL,
	`prompt_version` text NOT NULL,
	`rodada` integer NOT NULL,
	`nota_aderencia` real NOT NULL,
	`etapas` text NOT NULL,
	`custo_usd` real NOT NULL,
	`billing` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `notifications` ADD `chave` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `erro` text;--> statement-breakpoint
CREATE INDEX `notifications_chave` ON `notifications` (`chave`,`canal`);