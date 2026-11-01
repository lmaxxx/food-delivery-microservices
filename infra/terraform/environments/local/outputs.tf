output "ecs_cluster" {
  value = module.services.cluster_name
}

output "web_bucket" {
  value = module.web.bucket_name
}

output "database_urls" {
  value     = module.data.database_urls
  sensitive = true
}

output "orders_db" {
  value     = module.data.orders_db
  sensitive = true
}

output "kafka_brokers" {
  value = module.data.kafka_brokers
}

output "redis_url" {
  value = module.data.redis_url
}

output "search_endpoint" {
  value = module.data.search_endpoint
}

output "website_url" {
  value = module.web.website_url
}
