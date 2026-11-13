import { migrationRunner } from '@forge/sql';
import { Queue } from '@forge/events';
import { backfillSeq } from './decisions';

// Append new operations at the end; never edit or reorder existing ones.
const runner = migrationRunner
  .enqueue(
    'v001_create_decisions',
    `CREATE TABLE IF NOT EXISTS decisions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      title VARCHAR(255) NOT NULL,
      statement TEXT NOT NULL,
      rationale TEXT,
      context TEXT,
      status VARCHAR(16) NOT NULL DEFAULT 'accepted',
      owners_json TEXT,
      decided_at DATETIME,
      review_by DATE,
      source_type VARCHAR(16) NOT NULL,
      source_id VARCHAR(128),
      source_local_id VARCHAR(64),
      source_url VARCHAR(1024),
      project_key VARCHAR(32),
      superseded_by INT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_source (source_type, source_id, source_local_id),
      KEY idx_project_status (project_key, status)
    )`,
  )
  .enqueue(
    'v002_create_decision_links',
    `CREATE TABLE IF NOT EXISTS decision_links (
      decision_id INT NOT NULL,
      target_ari VARCHAR(512) NOT NULL,
      target_type VARCHAR(32) NOT NULL,
      label VARCHAR(512),
      url VARCHAR(1024),
      relation VARCHAR(32) NOT NULL,
      PRIMARY KEY (decision_id, target_ari)
    )`,
  )
  .enqueue(
    'v003_create_assumptions',
    `CREATE TABLE IF NOT EXISTS assumptions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      decision_id INT NOT NULL,
      text TEXT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'valid',
      KEY idx_decision (decision_id)
    )`,
  )
  .enqueue(
    'v004_create_conflicts',
    `CREATE TABLE IF NOT EXISTS conflicts (
      id INT PRIMARY KEY AUTO_INCREMENT,
      decision_id INT NOT NULL,
      target_key VARCHAR(128) NOT NULL,
      confidence DECIMAL(3,2) NOT NULL,
      reason TEXT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'open',
      resolved_by VARCHAR(128),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_conflict (decision_id, target_key),
      KEY idx_target (target_key)
    )`,
  )
  .enqueue(
    'v005_create_page_sync',
    `CREATE TABLE IF NOT EXISTS page_sync (
      page_id VARCHAR(64) PRIMARY KEY,
      version INT NOT NULL,
      synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
  )
  // TiDB hands out AUTO_INCREMENT ids in per-node blocks (DL-30001), so the number people
  // see is a separate per-installation sequence allocated from `counters`.
  .enqueue('v006_add_decision_seq', `ALTER TABLE decisions ADD COLUMN seq INT NULL`)
  .enqueue('v007_unique_decision_seq', `CREATE UNIQUE INDEX uniq_seq ON decisions (seq)`)
  .enqueue(
    'v008_create_counters',
    `CREATE TABLE IF NOT EXISTS counters (
      name VARCHAR(32) PRIMARY KEY,
      n INT NOT NULL
    )`,
  );

const queue = new Queue({ key: 'schema-migration-queue' });

export const enqueueMigration = async () => {
  await queue.push({ body: {} });
};

const RETRY_TIMEOUT_MS = 60_000;

export const runMigration = async () => {
  const deadline = Date.now() + RETRY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const applied = await runner.run();
      if (applied.length) console.log('Migrations applied:', applied);
      await backfillSeq();
      return;
    } catch (error) {
      lastError = error;
      console.warn('Migration attempt failed, retrying', error);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  throw lastError;
};
