#!/usr/bin/env bash
# Deploys the whole app to Floci, in the order a real AWS deploy would need:
# build, create data services, set up schemas, then start the services.
set -euo pipefail
cd "$(dirname "$0")/../.."

NETWORK=food-delivery-floci_default
IMAGE=food-delivery/app:local
tf() { terraform -chdir=infra/terraform/environments/local "$@"; }
step() { printf '\n==> %s\n' "$1"; }

step "Starting Floci"
docker compose -f infra/terraform/docker-compose.floci.yml \
  -f infra/terraform/docker-compose.floci-ui.yml up -d --wait

step "Building the React app and the service image"
pnpm --filter @food/web build
docker build -q -f infra/deploy.Dockerfile -t "$IMAGE" .

step "Creating data services, network and load balancer"
tf init -input=false >/dev/null
tf apply -input=false -auto-approve -var run_services=false

step "Enabling logical replication on the Orders database"
# Floci-only workaround. Real RDS applies rds.logical_replication from its parameter
# group, and refuses ALTER SYSTEM.
HOST=$(tf output -json orders_db | python3 -c 'import json,sys;print(json.load(sys.stdin)["host"])')
PORT=$(tf output -json orders_db | python3 -c 'import json,sys;print(json.load(sys.stdin)["port"])')
PASSWORD=$(tf output -json orders_db | python3 -c 'import json,sys;print(json.load(sys.stdin)["password"])')
psql_orders() {
  docker run --rm --network "$NETWORK" -e PGPASSWORD="$PASSWORD" postgres:17-alpine \
    psql -h "$HOST" -p "$PORT" -U orders_user -d orders -tAc "$1"
}
if [ "$(psql_orders 'show wal_level')" != logical ]; then
  psql_orders 'ALTER SYSTEM SET wal_level = logical' >/dev/null
  curl -sf localhost:4566/ \
    -H 'authorization: AWS4-HMAC-SHA256 Credential=test/20260101/eu-central-1/rds/aws4_request, SignedHeaders=host, Signature=x' \
    -d 'Action=RebootDBInstance&Version=2014-10-31&DBInstanceIdentifier=food-delivery-local-orders' >/dev/null
  until [ "$(psql_orders 'show wal_level' 2>/dev/null)" = logical ]; do sleep 2; done
fi

step "Creating database tables"
tf output -json database_urls | python3 -c '
import json, sys
apps = {"auth": "auth", "restaurants": "restaurant", "orders": "order", "payments": "payment"}
for db, url in json.load(sys.stdin).items():
    print(apps[db], url)
' | while read -r app url; do
  docker run --rm --network "$NETWORK" -e DATABASE_URL="$url" -w "/repo/apps/$app" "$IMAGE" \
    pnpm exec prisma db push --skip-generate --accept-data-loss </dev/null >/dev/null
  echo "  $app"
done

step "Creating Kafka topics"
BROKERS=$(tf output -raw kafka_brokers)
docker run --rm --network "$NETWORK" -e KAFKA_BROKERS="$BROKERS" -w /repo/scripts "$IMAGE" \
  pnpm exec tsx create-topics.ts

step "Registering the Debezium connector"
DEBEZIUM=$(docker ps -q --filter ancestor=quay.io/debezium/connect:3.0 | head -1)
until docker exec "$DEBEZIUM" curl -sf localhost:8083/connectors >/dev/null 2>&1; do sleep 2; done
HOST="$HOST" PORT="$PORT" PASSWORD="$PASSWORD" python3 -c '
import json, os
config = json.load(open("infra/debezium/orders-outbox.json"))["config"]
config.update({
    "database.hostname": os.environ["HOST"],
    "database.port": os.environ["PORT"],
    "database.password": os.environ["PASSWORD"],
})
print(json.dumps(config))
' | docker exec -i "$DEBEZIUM" curl -sf -X PUT -H 'content-type: application/json' \
  --data-binary @- localhost:8083/connectors/orders-outbox/config >/dev/null

step "Starting the services"
tf apply -input=false -auto-approve -var run_services=true

step "Waiting for the load balancer"
for url in http://localhost:4400/health http://localhost:3010/health; do
  until curl -sf -m 2 "$url" >/dev/null; do sleep 3; done
  echo "  $url ok"
done

# A healthy gateway does not mean the services behind it have finished starting.
step "Waiting for the services behind it"
until curl -sf -m 5 localhost:4400/auth/login -H 'content-type: application/json' \
  -d '{"email":"customer@demo.com","password":"demo1234"}' >/dev/null; do sleep 3; done
echo "  login ok"
until curl -sf -m 5 'localhost:4400/search?q=margherita' | grep -q restaurantId; do sleep 3; done
echo "  search ok"

printf '\nDeployed.\n  Web app:  %s\n  API:      http://localhost:4400\n  Console:  http://localhost:4566/_floci/ui\n' \
  "$(tf output -raw website_url)"
