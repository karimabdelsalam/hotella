-- Tightens the request history trigger of 0019: anonymization may only clear the guest's words — a reason becomes
-- NULL, field values may only be removed (the new value is contained in the old one) — never rewrite them.
CREATE OR REPLACE FUNCTION "catalog"."service_request_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog.service_request_events is append-only';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.request_id, NEW.type, NEW.from_status, NEW.to_status, NEW.actor_type, NEW.actor_id,
      NEW.source, NEW.occurred_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.request_id, OLD.type, OLD.from_status, OLD.to_status, OLD.actor_type, OLD.actor_id,
      OLD.source, OLD.occurred_at)
     OR (NEW.reason IS NOT NULL AND NEW.reason IS DISTINCT FROM OLD.reason)
     OR (NEW.fields IS NOT NULL AND (OLD.fields IS NULL OR NOT (NEW.fields <@ OLD.fields))) THEN
    RAISE EXCEPTION 'catalog.service_request_events is append-only';
  END IF;
  RETURN NEW;
END;
$$;
