# Redis — Amazon ElastiCache

Prod uses **ElastiCache for Redis**, not a self-hosted container.

- `deploy/aws/buzz.tf`: `aws_elasticache_replication_group.buzz` (Redis 7, `cache.t4g.micro`, `num_cache_clusters=2`, `automatic_failover_enabled=true`, private subnets, SG `buzz_redis` VPC-only 6379)
- Auth: `random_password.buzz_redis` (32 chars) → Secrets Manager `buzz_redis_url` → `REDIS_URL=rediss://:token@host:6379` with `transit_encryption_enabled=true`
- App: `BUZZ_RELAY_URL` + `REDIS_URL` wired via `buzz_runtime.ts` / `buzz-surface.ts`; core validates `kind` whitelist, not Redis directly
- Local dev: `buzz-redis:7-alpine` + `buzz-postgres:17-alpine` in `buzz-local` Docker network are throwaway; `buzz-e2e` local relay uses same image but isolated net

No `docker-compose.buzz.yml` in prod — that file is deprecated (see its header).
