-- full_reconcile resume checkpoint.
--
-- A walk that exceeds one claim budget must resume from its last completed
-- events.list page, rather than restart and exhaust MAX_ATTEMPTS. These columns
-- persist the walk position across retries and cooperative yields.
--
-- resume_page_token          next Google events.list pageToken to fetch
--                            (NULL = start from the first page)
-- resume_processed_count     events processed by all prior attempts of this
--                            walk; summed into drift counting on completion
-- resume_sweep_start_seconds sweep anchor captured when the walk STARTED;
--                            pins the orphan-sweep cutoff and drift window
--                            across attempts
-- resume_time_min            exact timeMin used by the walk's first page;
--                            Google pagination requires every pageToken
--                            request to repeat the original query parameters
-- resume_yield_count         attempt-free cooperative yields consumed so far;
--                            capped in code so yields cannot bypass the
--                            MAX_ATTEMPTS dead-letter guarantee
ALTER TABLE google_calendar_import_jobs ADD COLUMN resume_page_token TEXT;
ALTER TABLE google_calendar_import_jobs ADD COLUMN resume_processed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE google_calendar_import_jobs ADD COLUMN resume_sweep_start_seconds INTEGER;
ALTER TABLE google_calendar_import_jobs ADD COLUMN resume_time_min TEXT;
ALTER TABLE google_calendar_import_jobs ADD COLUMN resume_yield_count INTEGER NOT NULL DEFAULT 0;
