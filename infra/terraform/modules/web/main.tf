# Private bucket for the React build. On real AWS, CloudFront serves it to users.

variable "bucket_name" {
  type = string
}

variable "site_dir" {
  description = "Folder holding the built React app."
  type        = string
}

variable "region" {
  type = string
}

locals {
  content_types = {
    html = "text/html"
    js   = "text/javascript"
    css  = "text/css"
    svg  = "image/svg+xml"
    png  = "image/png"
  }
}

resource "aws_s3_bucket" "web" {
  bucket        = var.bucket_name
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_website_configuration" "web" {
  bucket = aws_s3_bucket.web.id

  index_document {
    suffix = "index.html"
  }

  # Client-side routes such as /orders have no file, so the React app handles them.
  error_document {
    key = "index.html"
  }
}

resource "aws_s3_object" "site" {
  for_each     = fileset(var.site_dir, "**")
  bucket       = aws_s3_bucket.web.id
  key          = each.value
  source       = "${var.site_dir}/${each.value}"
  etag         = filemd5("${var.site_dir}/${each.value}")
  content_type = lookup(local.content_types, reverse(split(".", each.value))[0], "application/octet-stream")
}

output "website_url" {
  value = "http://${aws_s3_bucket.web.bucket}.s3-website-${var.region}.localhost:4566/"
}

output "bucket_name" {
  value = aws_s3_bucket.web.bucket
}
