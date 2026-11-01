-- One database and one credential per service: services cannot read each other's tables.
CREATE ROLE auth_user LOGIN PASSWORD 'auth_pass';
CREATE ROLE restaurants_user LOGIN PASSWORD 'restaurants_pass';
CREATE ROLE payments_user LOGIN PASSWORD 'payments_pass';
-- Debezium reads the write-ahead log, which requires the REPLICATION attribute.
CREATE ROLE orders_user LOGIN PASSWORD 'orders_pass' REPLICATION;

CREATE DATABASE auth OWNER auth_user;
CREATE DATABASE restaurants OWNER restaurants_user;
CREATE DATABASE payments OWNER payments_user;
CREATE DATABASE orders OWNER orders_user;

REVOKE CONNECT ON DATABASE auth, restaurants, payments, orders FROM PUBLIC;
