# Lesson plan: how this system works

This is the script for walking through the project together, one module at a time. Ask Claude: "Teach me module 5 from `docs/LESSON_PLAN.md`." Each module has the same parts:

- **Problem:** what goes wrong without this
- **Theory:** the concepts
- **In the industry:** common implementations and alternatives
- **In this code:** where to read
- **Try it:** an experiment on the running system
- **Check yourself:** questions to answer before moving on

Modules build on each other, so take them in order. Each takes about 30 to 60 minutes.

**Before you start:** run the system using the [README](../README.md) and follow one order across all three roles, with **Event stream** open.

| # | Module | Main idea |
|---|---|---|
| 1 | [The big picture](#module-1-the-big-picture) | What microservices cost and buy |
| 2 | [Communication styles](#module-2-communication-styles) | REST, gRPC or events |
| 3 | [API gateway](#module-3-api-gateway) | One front door, rate limiting |
| 4 | [Authentication](#module-4-authentication-across-services) | JWT and trust boundaries |
| 5 | [Kafka fundamentals](#module-5-kafka-fundamentals) | Topics, partitions, groups, compaction |
| 6 | [Delivery guarantees](#module-6-delivery-guarantees) | At-least-once, idempotency, DLQs |
| 7 | [Outbox and CDC](#module-7-the-dual-write-problem-outbox-and-cdc) | Save and publish without losing either |
| 8 | [Saga](#module-8-the-saga-pattern) | Transactions across services |
| 9 | [Data ownership](#module-9-data-ownership-and-eventual-consistency) | Database per service, replication |
| 10 | [Read models and CQRS](#module-10-read-models-and-cqrs) | Elasticsearch and ClickHouse |
| 11 | [Redis GEO](#module-11-redis-geo-and-concurrency) | Nearest courier, atomic reservation |
| 12 | [WebSockets at scale](#module-12-websockets-at-scale) | Live updates across instances |
| 13 | [Observability and production](#module-13-observability-and-the-road-to-production) | What this project leaves out |
| 14 | [Capstone](#module-14-capstone-exercises) | Build it yourself |

---

## Module 1: The big picture

**Problem.** A monolith is one deployable with one database. It is simple, and for most teams it is the right start. It starts to hurt when many teams collide in one codebase, when parts need very different scaling, or when one bad deploy takes down everything.

**Theory.** Microservices split a system along business boundaries, so each part can be deployed, scaled and fail independently. You pay for that with a distributed system:

- Networks fail and are slow. A function call cannot time out, but a network call can.
- There are no transactions across services.
- Data is eventually consistent.
- Debugging spans many processes.

Nearly every pattern in this project pays down one of those costs.

**In the industry.** Common alternatives are a modular monolith (clear boundaries, one deployable) and a few larger services. Many teams now start with a modular monolith and extract services only when they have a specific reason. Boundaries usually follow domain-driven design's bounded contexts. For example, "menu item" means something different to Restaurant (recipe, description) and to Order (a price at a moment in time).

**In this code.** Trace one order on the README diagram:

1. The browser calls the API Gateway, which calls Order over gRPC.
2. Order commits the order and an outbox row. Debezium publishes `order.created`.
3. Payment charges, then publishes `payment.done`. Order moves to `PAID` and emits `order.paid`.
4. Restaurant creates a ticket, and staff accept it: `order.accepted`.
5. Delivery finds a courier: `courier.assigned`.
6. The food is ready, picked up and delivered. Notification, Search, Analytics and the WebSocket Gateway listen along the way.

Read `libs/contracts/src/events.ts`. It lists every message in the system, and it is the best single map of the architecture.

**Try it.** Place an order with Event stream open, and match each row to the steps above. Then write down which services were not needed for the order to be placed.

**Check yourself.**
1. Name three things that are harder here than in a monolith.
2. If this were a two-person startup, what would you build instead?
3. Which service failing would stop customers from placing orders? Which would not?

---

## Module 2: Communication styles

**Problem.** If every service calls others synchronously, then failures and slowness chain together. Suppose A calls B calls C, each 99.9% available: the chain is only about 99.7% available, and the user waits for all of it.

**Theory.**

| | Synchronous request | Asynchronous event |
|---|---|---|
| Caller waits | Yes | No |
| Receiver must be up | Yes | No, the message waits |
| Coupling | Caller knows the receiver | Publisher does not know its consumers |
| Gives an immediate answer | Yes | No |
| Harder part | Cascading failure | Eventual consistency, debugging |

A **command** asks for something to happen and can be refused (`CreateOrder`). An **event** states a fact that already happened (`payment.done`).

**In the industry.**

- **REST/JSON:** universal and easy to debug, so it is the usual choice at public edges.
- **gRPC:** a binary protocol over HTTP/2 with a strict contract and generated clients. It is common between internal services, and browsers need a proxy to use it.
- **GraphQL:** lets clients choose fields. It is common at a backend-for-frontend layer.
- **Brokers:** Kafka is a durable, replayable log. RabbitMQ is a queue with rich routing, and messages are normally gone once acknowledged. Cloud options include SQS, SNS and Pub/Sub.

Rule of thumb: use synchronous calls when the user needs the answer now, and events for everything that can happen after.

**In this code.**

- REST: `apps/api-gateway/src/app.module.ts`, `ProxyController`
- gRPC contract: `proto/order.proto`. Gateway client: `OrdersController`. Server: `apps/order/src/main.ts`
- Deadlines: `GRPC_DEADLINE_MS` in the gateway. Without one, a stuck service holds callers forever.
- Events: `libs/kafka/src/index.ts`

**Try it.** Stop Order Service and call `GET /orders` through the gateway to see a sync failure as a 503. Then restart it. In contrast, `pnpm chaos` shows Payment frozen while orders keep being accepted.

**Check yourself.**
1. Why does the browser not talk gRPC to Order directly?
2. Why is `order.created` an event and `CreateOrder` a command?
3. What happens without a deadline when Order hangs?

---

## Module 3: API gateway

**Problem.** Without a gateway, every client must know every service address, and every service must handle auth, rate limits and CORS itself.

**Theory.** A gateway is a single entry point that handles cross-cutting concerns: routing, authentication, rate limiting, protocol translation and sometimes response aggregation. It must stay free of business logic, or it turns into a new monolith.

Rate-limiting algorithms:

| Algorithm | How | Trade-off |
|---|---|---|
| Fixed window | Count per minute | Simple, but allows bursts at window edges |
| Sliding window | Rolling count | Accurate, uses more memory |
| Token bucket | Tokens refill steadily, requests spend them | Allows controlled bursts, a very common choice |
| Leaky bucket | Requests drain at a constant rate | Smooths traffic and adds delay |

**In the industry.** Kong, Envoy, NGINX, Traefik, and cloud gateways such as AWS API Gateway are standard. Writing your own, as here, is uncommon outside learning or thin custom layers. **Backend-for-frontend** (BFF) gives each client type its own gateway. A service mesh such as Istio handles internal traffic, while a gateway handles traffic coming in from outside.

**In this code.** `apps/api-gateway/src/guards.ts`:

- `TOKEN_BUCKET` is a Lua script. Redis runs it atomically, so several gateway instances share one correct limit.
- `/auth` has a stricter limit because login is what attackers brute-force.
- When Redis is down, the guard **fails open**. That favours availability. Consider whether a login endpoint should fail closed.

`app.module.ts` translates gRPC status codes to HTTP in `GRPC_TO_HTTP`.

**Try it.** Run `pnpm chaos` and read section 3. Then send requests with `curl -i` and watch `x-ratelimit-remaining` fall.

**Check yourself.**
1. Why must the counter be in Redis rather than in gateway memory?
2. Why is the Redis logic a Lua script and not separate GET and SET calls?
3. What is the risk of rate limiting by IP when many users share one network?

---

## Module 4: Authentication across services

**Problem.** A service needs to know who is calling. Asking Auth on every request makes Auth a bottleneck and a single point of failure.

**Theory.** A JWT is signed claims: `header.payload.signature`. Anyone with the verification key can check it without a network call. It is signed rather than encrypted, so its contents are readable.

- **HS256** uses one shared secret. Anyone who can verify can also forge.
- **RS256** uses a key pair. Only Auth holds the private key, and verifiers hold just the public one.

The main weakness is that a stateless token cannot easily be revoked before it expires.

**In the industry.** Short-lived access tokens (5 to 15 minutes) paired with long-lived, revocable refresh tokens are standard, often through OAuth2 and OpenID Connect with Keycloak, Auth0 or Cognito. Public keys are usually published at a JWKS endpoint so they can rotate. For service-to-service trust, mutual TLS is common, usually through a mesh.

**In this code.**

- Signing: `apps/auth/src/main.ts`, `issue`
- Verifying: `apps/api-gateway/src/guards.ts`, `JwtGuard`. `algorithms: ['RS256']` is pinned to block algorithm-confusion attacks.
- Identity forwarding: `ProxyController.forward` builds `x-user-*` headers only from the verified token and drops any the client sent.
- WebSocket handshake: `apps/ws-gateway/src/main.ts`, `handleConnection`

**Simplifications to remember:** tokens last 8 hours with no refresh or revocation, keys are files rather than JWKS, and internal services trust headers with no mTLS. So anyone who reaches port 3002 directly can impersonate a restaurant. In production, the network or mTLS must close that gap.

**Try it.** Paste your token (browser localStorage, key `food-session`) into a JWT decoder and read the claims. Then call `http://localhost:3002/kitchen/tickets` directly with a forged `x-user-restaurant-id` header. It works, and that is the gap above. Send the same header through port 4400 and it does not.

**Check yourself.**
1. Why can the gateway verify tokens but not create them?
2. A courier is fired. How long can their token still work here? How would you shorten that?
3. Which e2e test proves that clients cannot inject identity headers?

---

## Module 5: Kafka fundamentals

**Problem.** Many services need the same events, some consumers are slow or offline, and a new consumer may need history. A simple queue that deletes on consumption cannot serve this well.

**Theory.** Kafka is a **distributed append-only log**.

- **Topic:** a named log, such as `payment.done`.
- **Partition:** a topic is split into ordered logs. Ordering holds **only within a partition**.
- **Key:** the same key goes to the same partition. Using `orderId` keeps one order's events on one topic in order.
- **Offset:** a message's position. Consumers track their own position, so reading does not delete anything.
- **Consumer group:** instances sharing a group ID split the partitions between them. A partition has one consumer per group at a time, which is how you scale.
- **Different groups** each get all messages. That is how Payment and Analytics both see the same event.
- **Rebalancing:** when instances join or leave, partitions are reassigned, and consumption pauses briefly.
- **Retention:** messages expire by time or size. **Compaction** instead keeps the latest message per key.
- **Replication:** copies across brokers survive failures. `acks=all` waits for in-sync replicas.

**In the industry.** Kafka, Redpanda (Kafka-compatible) and managed Confluent or MSK are common. RabbitMQ suits task queues and complex routing, and Pulsar is a further alternative. Schema Registry with Avro or Protobuf is commonly used to enforce message contracts.

**In this code.**

- Client: `libs/kafka/src/index.ts`
- Topic creation, with 3 partitions and compaction: `scripts/bootstrap.ts`
- Compacted topic: `restaurant.updated`, in `COMPACTED_TOPICS`
- Broker settings: `infra/docker-compose.yml`. The two listeners exist because containers reach the broker as `kafka:9092` and your host as `localhost:9094`.

**A design choice to question.** This project has one topic per event type. That is easy to read, but Kafka only orders within a partition, so `courier.assigned` could be consumed before `order.accepted`. See the "forward jumps" in `apps/order/src/saga.ts`. The alternative is one `order-events` topic keyed by order ID, which gives ordering per order but mixes event types.

**Try it.** Open Kafka UI at http://localhost:8088.

1. Open `order.created` and find the messages, keys and partitions.
2. Open consumer groups and compare `payment` with `analytics`.
3. Start a second WebSocket Gateway, `PORT=3011 pnpm --filter @food/ws-gateway start`, and watch the `ws-gateway` group split its partitions.
4. Stop Notification, place orders, and watch its lag grow. Restart it and watch lag return to zero.

**Check yourself.**
1. Three partitions and four consumers in one group: what does the fourth do?
2. Why is the partition key `orderId` and not random?
3. Why can a new service read last week's orders, when a typical RabbitMQ queue could not?

---

## Module 6: Delivery guarantees

**Problem.** A consumer can crash after doing work but before recording that it did. The message arrives again. If that work was a card charge, you charge twice.

**Theory.**

- **At-most-once:** commit, then process. A crash loses the message.
- **At-least-once:** process, then commit. A crash duplicates it. This is the usual choice.
- **Exactly-once:** Kafka transactions provide it within Kafka. Once an outside system such as a database or a card network is involved, you get the same effect from **at-least-once plus idempotent handling**.

**Idempotent** means that doing it twice has the same effect as doing it once. Ways to get there:

1. A processed-events table, updated in the same transaction as the work
2. Natural keys and upserts
3. Unique constraints as a final guard
4. An atomic claim in Redis

**Poison messages** fail every time. Retrying forever blocks the partition behind them, so after limited retries they go to a **dead-letter queue** for inspection.

**In the industry.** Retries often use delay topics (`orders.retry.5s`, `orders.retry.1m`), so that the main partition keeps moving. That gives up strict ordering. HTTP APIs use `Idempotency-Key` headers, a pattern Stripe made well known.

**In this code.** Each uses a different technique, so compare them:

| Where | Technique |
|---|---|
| `libs/kafka/src/process-message.ts` | Retry, backoff, DLQ. Read this first |
| `libs/kafka/src/index.ts` | Commit offset only after handling |
| `apps/order/src/order.service.ts`, `claim` | Processed-events row in the same transaction |
| `apps/payment/prisma/schema.prisma` | Unique `orderId`, so the database blocks a double charge |
| `apps/delivery/src/main.ts`, `once` | Redis `SET NX`, released on failure |
| `apps/search-indexer/src/main.ts` | Naturally idempotent: same document ID overwrites |
| `apps/analytics/src/main.ts` | `ReplacingMergeTree` with `FINAL` |
| `apps/notification/src/main.ts` | In-memory set, the weakest, and acceptable for an email |
| `order.service.ts`, `create` | `Idempotency-Key` with a unique index for concurrent races |

Retries here block the partition on purpose, to protect ordering and keep the code readable.

**Try it.** Read the "duplicate Kafka event" and "malformed event" tests in `scripts/e2e.ts`. In Kafka UI, look at `payment.done.dlq` and read the `x-reason` header. Notice that one bad message produced one DLQ message per consumer group.

**Check yourself.**
1. Why must the dedup insert share a transaction with the business change?
2. Why does Delivery delete its Redis claim on failure?
3. A handler fails for 10 minutes because a dependency is down. What happens with these settings, and is DLQ the right result? (This is a real weakness to discuss.)

---

## Module 7: The dual-write problem, outbox and CDC

This is the most important module in the course.

**Problem.** Consider this code:

```ts
await db.saveOrder(order);
await kafka.publish('order.created', order); // the process crashes before this line
```

The order exists but no one is ever told. Swap the lines and you can announce an order that never saved. You cannot wrap a database and Kafka in one normal transaction.

**Theory.** **Transactional outbox:** write the event into an `outbox` table **in the same database transaction** as the business change. Both commit or neither does. A separate process relays outbox rows to the broker. The relay can publish a row twice, so consumers must still be idempotent, as in Module 6.

There are two kinds of relay:

| | Polling publisher | Change data capture (CDC) |
|---|---|---|
| How | `SELECT` unsent rows on a timer | Reads the database's transaction log |
| Latency | Depends on the poll interval | Very low |
| Load on the database | Repeated queries | Low |
| Complexity | A small job in your code | Runs Kafka Connect and Debezium |

**CDC with Postgres.** Every committed change is first written to the **write-ahead log (WAL)**. With `wal_level=logical`, Postgres can decode it into row changes. Debezium holds a **replication slot** that remembers its position. Postgres keeps WAL until the slot consumes it, so events survive Debezium being down. The Outbox Event Router transform then turns each inserted row into a clean Kafka message.

**Operational risk:** an abandoned replication slot makes Postgres retain WAL forever, which can fill the disk. Monitor slot lag in production.

**In the industry.** Debezium is the standard tool for CDC. Polling is a perfectly good starting point and needs no new infrastructure. Listen-to-yourself and event sourcing are alternatives. Kafka transactions alone do not solve this, because they do not include your database.

**In this code.**

- Atomic write: `apps/order/src/order.service.ts`, `create` and `enqueue`
- Table: `Outbox` in `apps/order/prisma/schema.prisma`
- Connector: `infra/debezium/orders-outbox.json`. Note how `route.by.field` picks the topic and `table.field.event.key` sets the partition key.
- Postgres setting and `REPLICATION` role: `infra/docker-compose.yml`, `infra/postgres/init.sql`
- Cleanup: the end of `sweep`. Deleting old rows is safe because Debezium reads the log, not the table.

Note that Order Service's `bus` never publishes domain events. The outbox is its only way out.

**Try it.**

1. Run `pnpm chaos` and read section 1, which stops Debezium.
2. Manually: `docker compose -f infra/docker-compose.yml stop debezium`, place an order, and run this:

   ```bash
   docker compose -f infra/docker-compose.yml exec postgres \
     psql -U orders_user -d orders -c 'select type, "createdAt" from outbox order by "createdAt" desc limit 5;'
   ```

   Now check the slot with `select slot_name, active, restart_lsn from pg_replication_slots;`. Then start Debezium and watch the order move.
3. Check status: `curl localhost:8083/connectors/orders-outbox/status`.

**Check yourself.**
1. Why does the outbox guarantee at-least-once and not exactly-once?
2. Why can old outbox rows be deleted, and why would that be unsafe with a polling relay that had not sent them yet?
3. Payment lacks an outbox. Describe exactly how an event gets lost there, and what catches it.

---

## Module 8: The saga pattern

**Problem.** Placing an order touches Orders, Payments, Restaurants and Delivery, each with its own database. If the restaurant rejects after the card was charged, you cannot roll back a committed transaction in another service.

**Theory.** A **saga** is a sequence of local transactions. When a later step fails, **compensating transactions** semantically undo the earlier ones. A refund is not a rollback: the charge really happened, and the refund is a new fact.

| | Orchestration | Choreography |
|---|---|---|
| Control | One coordinator decides the next step | Each service reacts to events |
| Flow visibility | In one place | Spread across services |
| Coupling | Coordinator knows the steps | Looser |
| Risk | Coordinator becomes too big | Hard to follow, cycles |

**Why not two-phase commit?** 2PC locks resources across services while waiting on a coordinator. It reduces availability and most brokers and modern databases do not take part in it across services.

**Sagas are not isolated.** Others can see intermediate states such as `PAID` before the order is confirmed. Design for that using explicit states (semantic locks), which is why the statuses are visible here.

Also consider **pivot transactions**: the point after which the saga must go forward. Here, once a courier has the food, there are no more automatic refunds.

**In the industry.** Temporal, Camunda and AWS Step Functions run durable workflows and are commonly used as orchestrators, with retries and timers built in. Many systems hand-roll a state machine as this one does.

**In this code.**

- The state machine, with no I/O: `apps/order/src/saga.ts`. Read `TABLE` slowly, as the whole saga is there.
- Tests: `apps/order/src/saga.test.ts`
- Applying a step: `applySagaEvent`, in `order.service.ts`
- Row lock: `lock` uses `FOR UPDATE` to serialize events against the timeout sweep
- Timeouts: `sweep`
- Compensation target: `refund` in `apps/payment/src/main.ts`

**A subtle case to study.** A timeout fires while `order.created` is still waiting in Kafka. The refund arrives at Payment first. Payment writes a `VOIDED` row, so when the charge event arrives later, it is refused. Without that, the customer would be charged for a cancelled order. Find it in `apps/payment/src/main.ts`.

**Try it.** In the web app, try each ending and read the ledger:

1. Decline the card: `CANCELLED` with no refund
2. Reject in the kitchen: `REFUNDING`, then `CANCELLED`
3. Accept with no courier online: same compensation, with a different reason
4. Timeout: stop `pnpm dev`, then start it again as `SAGA_RESTAURANT_TIMEOUT_MS=10000 pnpm dev`, place an order and do nothing

**Check yourself.**
1. Why does a declined card need no refund?
2. Why are there deliberate "forward jumps" in `TABLE`?
3. Why can't an order time out in `COURIER_ASSIGNED`? Should it? What would you do if a courier disappears?
4. Is this orchestration or choreography? What in the code shows that?

---

## Module 9: Data ownership and eventual consistency

**Problem.** If services share a database, a schema change in one breaks another, and the database becomes a hidden monolith.

**Theory.** **Database per service:** only the owner touches its tables, and others use its API or events. But then Order needs prices that Restaurant owns, and there are three ways to get them:

| Option | Trade-off |
|---|---|
| Sync call at order time | Always fresh. Order goes down when Restaurant does |
| Client sends the price | Simple and insecure |
| **Local copy updated by events** | Stays up by itself. May be briefly stale |

The last option is **event-carried state transfer**. The event carries the data rather than a pointer to it. Stale reads are the price, known as **eventual consistency**.

**In the industry.** Isolation can be separate instances, separate databases or separate schemas, with stricter options costing more to run. Teams choose per data type: a stale menu price is usually acceptable, while an account balance often is not.

**In this code.**

- Credentials: `infra/postgres/init.sql` creates a separate role per database
- Publisher: `publishRestaurant` in `apps/restaurant/src/main.ts`
- Local copy: `MenuItemSnapshot` and `onRestaurantUpdated` in `apps/order/src/order.service.ts`
- Price is copied into the order at purchase time, so past orders do not change

**Try it.** In the kitchen view, change a price and watch `restaurant.updated` in Event stream. New orders use it, and old ones keep theirs. Then stop Restaurant and place an order, which still works because Order has its copy. Try to connect to another service's database:

```bash
docker compose -f infra/docker-compose.yml exec -e PGPASSWORD=orders_pass postgres \
  psql -h localhost -U orders_user -d payments -c 'select 1'
```

**Check yourself.**
1. Between a price change and its arrival at Order, what does a customer pay?
2. Why is `restaurant.updated` compacted and not deleted after a retention period?
3. Would you use this pattern for checking a user's bank balance?

---

## Module 10: Read models and CQRS

**Problem.** One database shape cannot serve every query well. Fuzzy search and aggregating millions of events are both poor fits for Postgres at scale.

**Theory.** **CQRS** separates the write model from read models. Writes go to the source of truth, and events keep specialized read stores updated. A read model is **disposable**: replaying the log can rebuild it.

Do not confuse this with **event sourcing**, where events are the source of truth. This project uses CQRS without event sourcing, as the Postgres tables remain authoritative.

- **Elasticsearch** builds an inverted index (word to documents), so full-text and fuzzy search are fast.
- **ClickHouse** is a columnar store. Aggregating one column reads only that column, so analytics are very fast, while single-row updates are not its strength.

**In the industry.** Elasticsearch and OpenSearch dominate search. ClickHouse, Druid, BigQuery and Snowflake are common for analytics. Kafka Connect sinks are often used in place of custom consumers. ClickHouse can also read Kafka directly using its Kafka table engine.

**In this code.**

- `apps/search-indexer/src/main.ts`: the indexer, and `fuzziness: 'AUTO'`
- `apps/analytics/src/main.ts`: per-event inserts, a known simplification explained in a comment
- `infra/clickhouse/init.sql`: `ReplacingMergeTree`

**Try it.** Rebuild a read model:

```bash
curl -XDELETE localhost:9200/restaurants
# Restart search-indexer, then restart restaurant to republish its data
```

Next, try a replay. Stop search-indexer, reset the `search-indexer` group offsets to earliest in Kafka UI, and start it again. Search for `margerita` in the app. Then open http://localhost:8123/play and run:

```sql
SELECT type, count() FROM analytics.events FINAL GROUP BY type ORDER BY 2 DESC
```

**Check yourself.**
1. Why is a read model safe to delete, and the Orders DB not?
2. What would break by removing `FINAL`?
3. What does a user see between saving a menu change and it being indexed?

---

## Module 11: Redis GEO and concurrency

**Problem.** Find the nearest free courier, thousands of times with constantly changing locations, and never give one courier two orders at once.

**Theory.** Redis GEO stores locations in a sorted set, encoding coordinates with a geohash. `GEOADD` updates a position and `GEOSEARCH` finds nearby members by distance.

Check-then-act is a classic race: two processes both see the courier free, and both assign. `SET key value NX` is atomic, so only one wins.

**In the industry.** Redis GEO is fine at moderate scale. Larger systems use H3 or S2 hexagonal or spherical cells, and PostGIS is common where complex spatial queries matter. Real dispatch optimizes across many orders rather than choosing nearest-first.

**In this code.** `apps/delivery/src/main.ts`:

- `assign`: walks couriers by distance, trying to reserve each
- `keys.reservation`: holding this key is what makes a courier busy
- `keys.alive`: a TTL key, so couriers who vanish stop being candidates
- `release`: on delivery or cancellation

**Consider the weak spots.** The reservation lasts a day. If a courier disappears mid-job, nothing reassigns the order. Also, Redis is the only store here, so with no persistence, losing it loses active jobs.

**Try it.**

```bash
docker compose -f infra/docker-compose.yml exec redis redis-cli
GEOPOS couriers:geo 00000000-0000-4000-8000-000000000002
GEOSEARCH couriers:geo FROMLONLAT 30.5234 50.4501 BYRADIUS 50 km ASC WITHDIST
KEYS courier:*
TTL courier:00000000-0000-4000-8000-000000000002:alive
```

**Check yourself.**
1. Why is GET then SET unsafe for the reservation?
2. What happens when a courier closes their browser mid-wait?
3. How would you reassign an order if a courier goes silent?

---

## Module 12: WebSockets at scale

**Problem.** HTTP is request-response. Polling for status is wasteful and slow, so the server needs to push.

**Theory.** A WebSocket is a long-lived two-way connection. The issue is that a user's socket lives on one server instance. With several instances:

1. **Which instance consumes the event?** With one shared consumer group, only one does.
2. **Where is the socket?** Possibly on another instance.

A pub/sub backplane solves this: the consuming instance publishes the broadcast through Redis, and every instance delivers to its local sockets. **Rooms** group sockets by audience.

If every instance used its own consumer group, each would see all events and no backplane would be needed. That is a valid design too, with its own trade-offs.

**In the industry.** Server-Sent Events are simpler for one-way pushes. Socket.IO adds rooms and reconnection. Managed services include Pusher and Ably. Load balancers need sticky sessions or WebSocket-only transport for Socket.IO.

Clients must handle reconnects, and events sent while they are disconnected are missed. A common recovery pattern is to refetch state after reconnecting.

**In this code.** `apps/ws-gateway/src/main.ts`:

- `RedisIoAdapter`: the backplane
- `handleConnection`: JWT check and room joining
- `forward`: picks rooms, and `withoutPii` strips the email

In the web app, `apps/web/src/live.ts` treats events as a trigger to refetch rather than as data to patch, so the server stays the source of truth.

**Try it.** Start a second instance on port 3011. In Kafka UI, confirm that the `ws-gateway` group has two members. Place orders and verify that the live updates still reach a browser connected only to 3010, including events consumed by 3011.

**Check yourself.**
1. Remove the Redis adapter. Which users stop getting updates, and why only some?
2. Why are events not trusted as the source of order state on the client?
3. The Event stream is available to any logged-in user. Why is that unacceptable in production?

---

## Module 13: Observability and the road to production

**Problem.** One customer complaint could involve ten services. Without a way to connect logs, you are guessing.

**Theory.** The three pillars are **logs**, **metrics** and **traces**. A **correlation ID** is the simplest tool: generate one at the edge and pass it everywhere. Distributed tracing extends that with timed spans per service.

Useful resilience patterns that this project does **not** have:

- **Circuit breaker:** stop calling a failing dependency for a while
- **Bulkhead:** isolate resources so that one failure cannot exhaust everything
- **Retry budget:** cap retries so they do not amplify an outage

**In this code.**

- `libs/observability/src/index.ts`: `AsyncLocalStorage` carries the ID through async calls without passing it as a parameter
- Crossing boundaries: HTTP header, gRPC metadata, Kafka envelope

**Try it.** Find a correlation ID in Event stream and search for it in the logs:

```bash
pnpm dev 2>&1 | tee /tmp/food.log
grep <correlation-id> /tmp/food.log
```

Query ClickHouse for the same ID: `SELECT type, occurred_at FROM analytics.events FINAL WHERE correlation_id LIKE '<prefix>%' ORDER BY occurred_at`.

**What production would add:**

| Area | Here | Production |
|---|---|---|
| Tracing | Correlation ID | OpenTelemetry with Jaeger or Tempo |
| Metrics | None | Prometheus and Grafana, including consumer lag |
| Deployment | Compose | Kubernetes, health probes, rolling deploys |
| Kafka | One broker | 3+ brokers, replication factor 3, `min.insync.replicas=2` |
| Contracts | Shared zod package | Schema Registry and compatibility rules |
| Security | Open localhost ports | mTLS, network policies, a secrets manager |
| Secrets | Plain text in the repo | Vault or a cloud secrets manager |
| Migrations | `db push` | Versioned migrations in CI |
| Testing | E2E script | Contract tests (for example Pact) between services |
| DLQ | Read by hand | Alerts and a replay tool |

**Check yourself.**
1. Why is `libs/contracts` shared code a form of coupling? What would you do with independent teams?
2. Which single alert would you add first?

---

## Module 14: Capstone exercises

Build these yourself, then have Claude review them. They go from easiest to hardest.

1. **Add a consumer.** Build a "loyalty points" service that awards points on `delivery.completed`. Touch nothing else. It should backfill past deliveries on its first run. *This proves why events decouple services.*
2. **Add an outbox to Payment.** Fix the dual-write gap, using a polling relay rather than Debezium. Write a test that crashes between commit and publish. *The core lesson of Module 7.*
3. **Non-blocking retries.** Replace in-process retries with `.retry` topics. Decide what it means for ordering. *Answers the question in Module 6.*
4. **Courier reassignment.** If a courier stops sending location, release them and find another. *A saga step and a Redis problem together.*
5. **Circuit breaker.** Add one to the gateway's gRPC client, then prove with chaos that it opens and recovers.
6. **Tracing.** Add OpenTelemetry and view one order as a single trace in Jaeger, including across Kafka.
7. **Switch to choreography.** Move one saga step out of Order, then write down what you gained and lost. *The best way to feel the trade-off in Module 8.*
8. **One order topic.** Move order events to a single topic keyed by order ID, and remove the "forward jumps". *Revisits the design choice from Module 5.*

### Suggested order of study

- **Short on time?** Do modules 1, 5, 6, 7 and 8. Those are the core of event-driven microservices.
- **Interview preparation?** Be able to explain from memory: the dual-write problem, at-least-once with idempotency, orchestration versus choreography, and how to scale consumers.
