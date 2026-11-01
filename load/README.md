# Load experiments

Five k6 experiments against the [local AWS deployment](../infra/terraform/README.md). Each one tests a claim about microservices, by injecting load and failures while tracking latency, errors and Kafka lag.

```bash
brew install k6
pnpm aws:deploy              # if the deployment is not running
pnpm load <experiment>       # baseline | spike | failure | scaling | slow-consumer
pnpm load all                # all five, about 15 minutes
```

The runner raises the rate limit and the kitchen timeout for the test, checks those settings on the live containers, and restores the defaults afterwards. Raw results go to `load/results/`, which is ignored by git.

## Recorded results

One run of each, on one laptop with all containers sharing 8 GB of Docker memory. They show behaviour, not production capacity. There is no monolith here to compare with: these experiments show what this design does, not that it beats a specific alternative.

### Failure isolation

Steady 10 orders/s. Payment frozen and two services killed for 30 s.

| Phase | Requests | Errors | p50 | p95 |
|---|---|---|---|---|
| Healthy | 294 | 0% | 13 ms | 54 ms |
| Payment frozen, Search and Analytics killed | 300 | 0% | 13 ms | 27 ms |
| Recovering | 400 | 0% | 13 ms | 86 ms |

Payment lag peaked at 302 events and had cleared by the end of the run. Customers could still place orders; those orders stayed `PENDING_PAYMENT` until Payment returned.

### Spike

Payment slowed by a simulated 100 ms card network delay. Load jumps from 5 to 60 orders/s for 20 s.

| Phase | Requests | Errors | p50 | p95 |
|---|---|---|---|---|
| Before, 5/s | 99 | 0% | 14 ms | 45 ms |
| Spike, 60/s | 1194 | 0% | 20 ms | 301 ms |
| After, 5/s | 100 | 0% | 12 ms | 52 ms |

The API stayed fast while Payment fell behind, with lag peaking at 1251 events. The cost is delay: the backlog took about 278 s to clear after the load stopped.

### Independent scaling

Payment slowed by 200 ms. 10 orders/s for 20 s, about 200 orders. Only Payment changes.

| Payment tasks | Peak lag | Total seconds to process everything |
|---|---|---|
| 1 | 103 | 44.0 |
| 3 | 7 | 21.6 |

20 s of each total is the load itself. Topics have 3 partitions, so more than 3 tasks would not help.

### Stuck consumer

Steady 10 orders/s. Notification frozen for 45 s.

| Phase | Requests | Errors | p50 | p95 |
|---|---|---|---|---|
| Healthy | 148 | 0% | 14 ms | 42 ms |
| Notification frozen | 450 | 0% | 14 ms | 80 ms |

Notification's lag reached 897 while Payment and Order stayed at 0. It caught up about 2 s after being unfrozen.

### The cost: baseline

Rising load, with no failures. This is where the design pays.

| Target rate | Requests | Errors | p50 | p95 |
|---|---|---|---|---|
| Ramp to 5/s | 148 | 0% | 15 ms | 71 ms |
| Ramp to 20/s | 374 | 0% | 34 ms | 582 ms |
| Ramp to 50/s | 719 | 0% | 1008 ms | 3143 ms |
| Ramp to 100/s | 186 | 0% | 3514 ms | 4026 ms |

The API saturated between 20 and 50 orders/s on this laptop. Zero errors is misleading at the top: k6 ran out of virtual users because requests were so slow, so it sent far fewer than the target. A healthy order took about 1 s from placement to leaving `PENDING_PAYMENT`, and the slowest took about 72 s under overload.

Analytics fell thousands of events behind in most runs, because it inserts one row per event. Nothing else was affected.

## What the stress test found

- **A real bug.** When a consumer was frozen long enough, Kafka removed it from its group. Its next commit failed, kafkajs treated that as fatal, and the consumer stopped for good, while the process stayed up and `/health` still said OK. `libs/kafka` now replaces a crashed consumer. Notification hit this crash during the stuck consumer experiment, replaced its consumer and recovered.
- **Still open:** `/health` does not check that the consumer is running, so it would not reveal a problem like this one. A real system should also alert on consumer lag.
