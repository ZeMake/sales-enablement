CREATE TABLE `reliability` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`analysis_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`opus` text NOT NULL,
	`jev` text NOT NULL,
	`prob` real NOT NULL,
	`probabilidades` text,
	`nivel` text NOT NULL,
	`model` text NOT NULL,
	`contexto` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`analysis_id`) REFERENCES `analyses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reliability_analysis` ON `reliability` (`analysis_id`);