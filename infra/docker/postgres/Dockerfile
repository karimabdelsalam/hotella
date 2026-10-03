# PostgreSQL 18 + pgvector + pgBackRest (ADR-0013: backups and PITR with pgBackRest, quarterly restore drills).
ARG PG_IMAGE=pgvector/pgvector:pg18
FROM ${PG_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o postgres -g postgres -m 0750 /var/lib/pgbackrest /var/log/pgbackrest /var/spool/pgbackrest \
 && install -d -o postgres -g postgres -m 0700 /var/lib/postgresql/drill \
 && pgbackrest version
COPY --chown=postgres:postgres pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY --chmod=0755 restore-drill.sh /usr/local/bin/restore-drill
