CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text NOT NULL,
	`etapa` text,
	`transcript_url` text,
	`transcript_text` text,
	`video_url` text,
	`closer` text,
	`desfecho` text,
	`titulo` text,
	`call_id` text,
	`erro` text,
	`custo_usd` real,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
