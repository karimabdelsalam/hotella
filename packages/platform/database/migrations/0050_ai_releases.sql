ALTER TABLE "ai"."evaluation_runs" ALTER COLUMN "set_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai"."evaluation_results" ADD COLUMN "compared_execution_id" uuid;--> statement-breakpoint
-- Rolling back a release reinstates the previous version (BUILD_PLAN 12.2): SUPERSEDED → PUBLISHED is allowed too, with
-- nothing but the status changing; the content of a published version still never changes (rule 9).
CREATE OR REPLACE FUNCTION "ai"."published_versions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION '%.%: version % is % and immutable', TG_TABLE_SCHEMA, TG_TABLE_NAME, OLD.id, OLD.status;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF ((OLD.status = 'PUBLISHED' AND NEW.status = 'SUPERSEDED')
      OR (OLD.status = 'SUPERSEDED' AND NEW.status = 'PUBLISHED'))
     AND (to_jsonb(NEW) - 'status' - 'updated_at' - 'published_at') = (to_jsonb(OLD) - 'status' - 'updated_at' - 'published_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%.%: version % is % and immutable', TG_TABLE_SCHEMA, TG_TABLE_NAME, OLD.id, OLD.status;
END;
$$;
