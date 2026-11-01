CREATE DATABASE IF NOT EXISTS analytics;

-- ReplacingMergeTree drops rows with the same sorting key during merges, so a
-- redelivered event does not count twice once queries use FINAL.
CREATE TABLE IF NOT EXISTS analytics.events
(
    event_id String,
    type LowCardinality(String),
    occurred_at DateTime64(3, 'UTC'),
    order_id String,
    correlation_id String,
    amount_cents Int64,
    payload String
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (type, event_id);
