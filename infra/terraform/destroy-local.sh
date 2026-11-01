#!/usr/bin/env bash
# Removes everything deployed to Floci. Services go first, because Cloud Map refuses to
# delete a service that still has registered instances.
set -euo pipefail
cd "$(dirname "$0")/../.."

tf() { terraform -chdir=infra/terraform/environments/local "$@"; }

tf apply -input=false -auto-approve -var run_services=false \
  -target=module.services.aws_ecs_service.node
tf destroy -input=false -auto-approve -var run_services=true \
  -target=module.services.aws_ecs_service.support
sleep 10

# A task killed outside ECS stays registered on Floci, which real ECS would clean up.
python3 - <<'PY'
import json
import urllib.request


def call(action, body):
    request = urllib.request.Request(
        "http://localhost:4566/",
        data=json.dumps(body).encode(),
        headers={
            "content-type": "application/x-amz-json-1.1",
            "x-amz-target": f"Route53AutoNaming_v20170314.{action}",
            "authorization": "AWS4-HMAC-SHA256 Credential=test/20260101/eu-central-1/"
            "servicediscovery/aws4_request, SignedHeaders=host, Signature=x",
        },
    )
    return json.load(urllib.request.urlopen(request, timeout=10))


for service in call("ListServices", {}).get("Services", []):
    instances = call("ListInstances", {"ServiceId": service["Id"]}).get("Instances", [])
    for instance in instances:
        call("DeregisterInstance", {"ServiceId": service["Id"], "InstanceId": instance["Id"]})
        print(f"Removed stale registration: {service['Name']} {instance['Id']}")
PY
sleep 3

tf destroy -input=false -auto-approve -var run_services=false
