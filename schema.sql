-- LINE Gateway message archive.
--
-- The main reason this exists: the LINE Messaging API has no history
-- endpoint for bots — only webhook deliveries are visible. To let the
-- `fetch_messages` MCP tool work across plugin restarts, the gateway
-- persists every inbound message to SQLite as it arrives.
--
-- Using LINE's message id as the primary key makes duplicate webhook
-- deliveries (LINE retries on 5xx) idempotent without extra bookkeeping.

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,        -- LINE message id
    chat_id         TEXT NOT NULL,           -- U... / C... / R...
    sender_user_id  TEXT,                    -- U..., may be null for system events
    message_type    TEXT NOT NULL,           -- text / image / sticker / video / audio / file / location
    text            TEXT,                    -- body for text messages, null otherwise
    line_ts         INTEGER,                 -- LINE event.timestamp (ms epoch)
    received_at     TEXT NOT NULL,           -- ISO-8601 +08:00 when gateway processed it
    raw_json        TEXT NOT NULL,           -- full event JSON for future decoding
    image_set_id    TEXT,                    -- message.imageSet.id when sent as a multi-image album
    image_set_index INTEGER,                 -- 1-based position within the set
    image_set_total INTEGER                  -- total images in the set
);
-- image_set_id/index/total on a fresh table are covered by the CREATE
-- above; db.ts additionally runs an idempotent ALTER TABLE migration for
-- databases created before these columns existed (see ensureColumn()).

-- Serves fetch_messages(chat_id, limit) ORDER BY received_at DESC
CREATE INDEX IF NOT EXISTS idx_messages_chat_time
    ON messages(chat_id, received_at DESC);

-- Serves "recent inbound chats" lookups (known chat_id gate for send_image)
CREATE INDEX IF NOT EXISTS idx_messages_received_at
    ON messages(received_at DESC);

-- idx_messages_image_set is created in db.ts's openDatabase(), AFTER the
-- ensureColumn() migration runs — not here, because on a pre-existing
-- database (created before image_set_id existed) this file runs before
-- the column has been added, and CREATE INDEX on a missing column fails.
