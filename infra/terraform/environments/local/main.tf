terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

# Everything specific to the emulator is in this block. A real AWS environment
# would use the same modules with a normal provider block and an S3 state backend.
provider "aws" {
  region     = var.region
  access_key = "test"
  secret_key = "test"

  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true

  endpoints {
    ec2              = var.floci_endpoint
    ecs              = var.floci_endpoint
    elasticache      = var.floci_endpoint
    elbv2            = var.floci_endpoint
    iam              = var.floci_endpoint
    kafka            = var.floci_endpoint
    logs             = var.floci_endpoint
    opensearch       = var.floci_endpoint
    rds              = var.floci_endpoint
    route53          = var.floci_endpoint
    s3               = var.floci_endpoint
    secretsmanager   = var.floci_endpoint
    servicediscovery = var.floci_endpoint
    ssm              = var.floci_endpoint
    sts              = var.floci_endpoint
  }
}

locals {
  name = "food-delivery-${var.environment}"
}

module "network" {
  source = "../../modules/network"
  name   = local.name
}

module "data" {
  source             = "../../modules/data"
  name               = local.name
  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [module.network.services_security_group_id]
}

module "services" {
  source                          = "../../modules/services"
  name                            = local.name
  region                          = var.region
  image                           = var.image
  vpc_id                          = module.network.vpc_id
  subnet_ids                      = module.network.private_subnet_ids
  public_subnet_ids               = module.network.public_subnet_ids
  security_group_id               = module.network.services_security_group_id
  load_balancer_security_group_id = module.network.load_balancer_security_group_id
  database_urls                   = module.data.database_urls
  kafka_brokers                   = module.data.kafka_brokers
  # Floci reports Redis as localhost, which means nothing inside a container, so tasks
  # use its container name. Real AWS would use module.data.redis_url as is.
  redis_url = "redis://floci-aws-valkey-food-delivery-local:6379"
  # Floci's endpoint already has a scheme. A real OpenSearch endpoint needs https:// added.
  search_url   = module.data.search_endpoint
  run_services = var.run_services
}

module "web" {
  source      = "../../modules/web"
  bucket_name = "${local.name}-web"
  site_dir    = "${path.root}/../../../../apps/web/dist"
  region      = var.region
}
