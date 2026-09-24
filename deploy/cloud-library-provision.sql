-- Run as the PostgreSQL administrator on Hetzner.
-- Replace the password before executing.
CREATE ROLE studybox_library LOGIN PASSWORD 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';
CREATE DATABASE studybox_library OWNER studybox_library;
GRANT ALL PRIVILEGES ON DATABASE studybox_library TO studybox_library;
