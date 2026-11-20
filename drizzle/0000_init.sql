CREATE TABLE `items` (
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`run_index` integer,
	`turn_index` integer,
	`call_id` text,
	`created_at` integer NOT NULL,
	`item_type` text NOT NULL,
	`item_json` text NOT NULL,
	`meta` text,
	`provider_response_id` text,
	`usage` text,
	`call_settings` text,
	PRIMARY KEY(`session_id`, `seq`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`,`run_index`) REFERENCES `runs`(`session_id`,`run_index`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "items_call_id" CHECK(("items"."call_id" is not null) = ("items"."item_type" in ('function_call', 'function_call_output'))),
	CONSTRAINT "items_usage" CHECK(("items"."provider_response_id" is null) = ("items"."usage" is null)),
	CONSTRAINT "items_json" CHECK(json_valid("items"."item_json")),
	CONSTRAINT "items_meta" CHECK("items"."meta" is null or json_valid("items"."meta"))
);
--> statement-breakpoint
CREATE INDEX `items_type` ON `items` (`session_id`,`item_type`,`seq`);--> statement-breakpoint
CREATE INDEX `items_call` ON `items` (`session_id`,`call_id`) WHERE "items"."call_id" is not null;--> statement-breakpoint
CREATE INDEX `items_response` ON `items` (`session_id`,`seq`) WHERE "items"."provider_response_id" is not null;--> statement-breakpoint
CREATE TABLE `runs` (
	`session_id` text NOT NULL,
	`run_index` integer NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`end_reason` text,
	`turn_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`session_id`, `run_index`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "runs_end_reason" CHECK(end_reason in ('completed', 'max_turns', 'cancelled', 'time_limit', 'process_died', 'output_truncated', 'content_filtered', 'transient_exhausted', 'non_retryable', 'context_overflow')),
	CONSTRAINT "runs_ended" CHECK(("runs"."ended_at" is null) = ("runs"."end_reason" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_active` ON `runs` (`session_id`) WHERE "runs"."ended_at" is null;--> statement-breakpoint
CREATE TABLE `session_skills` (
	`session_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`skill_version_id` text NOT NULL,
	PRIMARY KEY(`session_id`, `skill_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`skill_version_id`) REFERENCES `skill_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`kind` text NOT NULL,
	`parent_session_id` text,
	`parent_call_id` text,
	`cwd` text NOT NULL,
	`started_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`closed_at` integer,
	`close_reason` text,
	`outcome` text,
	`outcome_note` text,
	`outcome_at` integer,
	`owner_id` text,
	`owner_heartbeat_at` integer,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sessions_kind" CHECK("sessions"."kind" in ('interactive', 'worker', 'subagent')),
	CONSTRAINT "sessions_close_reason" CHECK("sessions"."close_reason" in ('marked', 'worker_finished', 'subagent_finished', 'process_died', 'context_overflow')),
	CONSTRAINT "sessions_outcome" CHECK("sessions"."outcome" in ('successful', 'failed')),
	CONSTRAINT "sessions_closed" CHECK(("sessions"."closed_at" is null) = ("sessions"."close_reason" is null)),
	CONSTRAINT "sessions_parent" CHECK(("sessions"."kind" = 'subagent') = ("sessions"."parent_session_id" is not null)),
	CONSTRAINT "sessions_parent_call" CHECK(("sessions"."parent_session_id" is null) = ("sessions"."parent_call_id" is null)),
	CONSTRAINT "sessions_outcome_at" CHECK(("sessions"."outcome" is null) = ("sessions"."outcome_at" is null)),
	CONSTRAINT "sessions_marked" CHECK("sessions"."outcome" is null or ("sessions"."kind" = 'interactive' and "sessions"."close_reason" = 'marked')),
	CONSTRAINT "sessions_owner" CHECK(("sessions"."owner_id" is null) = ("sessions"."owner_heartbeat_at" is null))
);
--> statement-breakpoint
CREATE INDEX `sessions_cwd` ON `sessions` (`cwd`,`last_activity_at`) WHERE "sessions"."kind" <> 'subagent';--> statement-breakpoint
CREATE INDEX `sessions_workflow` ON `sessions` (`workflow_id`,`last_activity_at`) WHERE "sessions"."kind" = 'interactive';--> statement-breakpoint
CREATE INDEX `sessions_parent` ON `sessions` (`parent_session_id`) WHERE "sessions"."parent_session_id" is not null;--> statement-breakpoint
CREATE INDEX `sessions_owner` ON `sessions` (`owner_id`) WHERE "sessions"."owner_id" is not null;--> statement-breakpoint
CREATE INDEX `sessions_open` ON `sessions` (`last_activity_at`) WHERE "sessions"."closed_at" is null;--> statement-breakpoint
CREATE TABLE `skill_version_files` (
	`skill_version_id` text NOT NULL,
	`path` text NOT NULL,
	`content` blob NOT NULL,
	`sha256` text NOT NULL,
	PRIMARY KEY(`skill_version_id`, `path`),
	FOREIGN KEY (`skill_version_id`) REFERENCES `skill_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `skill_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_versions_skill_version` ON `skill_versions` (`skill_id`,`version`);--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`name` text NOT NULL,
	`active_version_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`active_version_id`) REFERENCES `skill_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_workflow_name` ON `skills` (`workflow_id`,`name`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_name` ON `workflows` (lower("name"));