# Scenario 2 Prompt: Zero-Downtime Partitioning & Migration of Monolithic Orders Table

## User Request
> "Our monolithic PostgreSQL database has an `orders` table with over 120 million rows, causing severe table bloat, slow sequential scans during reporting, and high autovacuum CPU spikes. We need a zero-downtime database migration strategy to partition this table by range (monthly partitions) and migrate to a sharded/partitioned PostgreSQL cluster without impacting active customer traffic. The plan must include dual-writing, a robust CDC / Debezium Kafka backfill pipeline, an automated shadow-read comparison proxy to verify zero discrepancies, and an automated cutover gate."

## Architectural Goals
1. Model the multi-phase transition architecture: Legacy Monolith -> Dual-Write & CDC Backfill -> Target Partitioned DB.
2. Clearly highlight added components (`migration_proxy_layer`, `cdc_debezium_worker`, `shadow_verifier`) and deprecated components (`legacy_orders_db`).
3. Provide step-by-step sequence playback for dual-write and shadow read divergence checking.
4. Model the physical range-partitioned database tables (`orders_2026_08`, `orders_2026_09`, `orders_2026_10`) with partition keys and BRIN indexes.
5. Provide a risk-gated 5-phase migration plan with rollback criteria.
