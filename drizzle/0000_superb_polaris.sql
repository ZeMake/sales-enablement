CREATE TABLE `analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`call_id` text NOT NULL,
	`playbook_id` text NOT NULL,
	`playbook_version` integer NOT NULL,
	`prompt_version` text NOT NULL,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	`billing` text NOT NULL,
	`nota_aderencia` real,
	`nota_llm` real,
	`talk_ratio_closer` real,
	`classificacao` text,
	`motivos` text,
	`confianca` text,
	`result` text,
	`citacoes_total` integer DEFAULT 0,
	`citacoes_descartadas` integer DEFAULT 0,
	`duracao_ms` integer,
	`tokens_input` integer,
	`tokens_output` integer,
	`tokens_cache_read` integer,
	`tokens_cache_write` integer,
	`custo_usd` real,
	`custo_brl` real,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analyses_unique` ON `analyses` (`call_id`,`playbook_id`,`prompt_version`);--> statement-breakpoint
CREATE TABLE `calibration_labels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`call_id` text NOT NULL,
	`playbook_id` text NOT NULL,
	`stage_id` text NOT NULL,
	`status` text NOT NULL,
	`churn` integer,
	`avaliador` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `calls` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_hash` text NOT NULL,
	`transcript_path` text,
	`video_path` text,
	`media_path` text,
	`closer_id` text,
	`gestor_id` text,
	`data_hora` text,
	`lead_nome` text,
	`empresa` text,
	`produto` text,
	`tipo_call` text,
	`desfecho` text,
	`valor_venda` real,
	`crm_url` text,
	`obs` text,
	`meta_origem` text NOT NULL,
	`closer_speaker` text,
	`speaker_roles` text NOT NULL,
	`duration_sec` real,
	`tempo_estimado` integer NOT NULL,
	`call_start_idx` integer NOT NULL,
	`triage_status` text NOT NULL,
	`triage_motivo` text,
	`triage_metodo` text,
	`metrics` text,
	`quality_flags` text NOT NULL,
	`ingested_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`closer_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`gestor_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calls_source_hash` ON `calls` (`source_hash`);--> statement-breakpoint
CREATE INDEX `calls_closer` ON `calls` (`closer_id`);--> statement-breakpoint
CREATE TABLE `churn_flags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`analysis_id` text NOT NULL,
	`severidade` text NOT NULL,
	`tipo` text NOT NULL,
	`citacao` text NOT NULL,
	`segment_idx` integer,
	`por_que_e_risco` text,
	`como_deveria_ter_dito` text,
	FOREIGN KEY (`analysis_id`) REFERENCES `analyses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `cost_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`call_id` text,
	`etapa` text NOT NULL,
	`model` text NOT NULL,
	`billing` text DEFAULT 'api' NOT NULL,
	`batch` integer DEFAULT false NOT NULL,
	`tokens_input` integer NOT NULL,
	`tokens_output` integer NOT NULL,
	`tokens_cache_read` integer DEFAULT 0 NOT NULL,
	`tokens_cache_write` integer DEFAULT 0 NOT NULL,
	`custo_usd` real NOT NULL,
	`custo_brl` real NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `evidences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`analysis_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text,
	`citacao` text NOT NULL,
	`segment_idx` integer,
	`match_score` real,
	`valida` integer NOT NULL,
	FOREIGN KEY (`analysis_id`) REFERENCES `analyses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `next_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`call_id` text NOT NULL,
	`analysis_id` text,
	`responsavel` text,
	`tarefa` text NOT NULL,
	`prazo` text,
	`citacao` text,
	`status` text DEFAULT 'pendente' NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`analysis_id`) REFERENCES `analyses`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canal` text NOT NULL,
	`destinatario_id` text,
	`tipo` text NOT NULL,
	`call_id` text,
	`payload` text NOT NULL,
	`dry_run` integer NOT NULL,
	`status` text NOT NULL,
	`lida` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`destinatario_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `objections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`analysis_id` text NOT NULL,
	`tipo` text NOT NULL,
	`citacao` text NOT NULL,
	`segment_idx` integer,
	`tratamento` text,
	`resolvida` integer,
	FOREIGN KEY (`analysis_id`) REFERENCES `analyses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`nome` text NOT NULL,
	`papeis` text NOT NULL,
	`gestores` text NOT NULL,
	`aliases` text NOT NULL,
	`whatsapp` text,
	`slack` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `segments` (
	`call_id` text NOT NULL,
	`idx` integer NOT NULL,
	`speaker` text NOT NULL,
	`role` text NOT NULL,
	`start` real,
	`end` real,
	`text` text NOT NULL,
	`flags` text,
	PRIMARY KEY(`call_id`, `idx`),
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `stage_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`analysis_id` text NOT NULL,
	`stage_id` text NOT NULL,
	`status` text NOT NULL,
	`nota` real,
	`o_que_faltou` text,
	`pergunta_sugerida` text,
	`rebaixada` integer DEFAULT false,
	FOREIGN KEY (`analysis_id`) REFERENCES `analyses`(`id`) ON UPDATE no action ON DELETE cascade
);
