@echo off
REM ============================================================================
REM pu3-stale-event-test.cmd
REM   PU-3 ordering-guard BEHAVIOURAL proof (Phase 4.4l Finding D).
REM
REM   Fires two synthetic RENEWAL events at the webhook:
REM     1. "fresh"  — event_timestamp_ms = NOW  → expect applied:tier1
REM     2. "stale"  — event_timestamp_ms = NOW - 60s → expect stale_skipped
REM
REM   After running, the watermark is left at "fresh"s timestamp (which is
REM   monotonic with real RC events that arrive after, so it does NOT
REM   lock the tester out of future real events). Re-run v2 Check J:
REM     SELECT count(*) FROM public.revenuecat_webhook_log
REM      WHERE processing_note = 'stale_skipped';
REM   Expect at least 1 row → roadmap item PU-3 closed.
REM
REM USAGE
REM   pu3-stale-event-test.cmd [parent_uuid] [webhook_url]
REM
REM     parent_uuid:  defaults to d0ce42a2-baa7-43a0-9843-406f71f02e2a
REM                   (your existing staging tester — safe; the synthetic
REM                   events look identical to one extra sandbox cycle)
REM     webhook_url:  defaults to staging
REM                   https://zhnaxafmacygbhpvtwvf.supabase.co/functions/v1/revenuecat-webhook
REM
REM   Set REVENUECAT_WEBHOOK_SECRET in env before running, OR script will
REM   prompt for it. The value MUST match Supabase Edge Function secret
REM   for the target project.
REM
REM REQUIREMENTS
REM   • Windows 10+ (built-in curl)
REM   • PowerShell (built-in; used for JSON escaping + ms timestamps only)
REM ============================================================================

setlocal ENABLEDELAYEDEXPANSION

REM --- Args -------------------------------------------------------------------
set PARENT_UUID=%~1
if "%PARENT_UUID%"=="" set PARENT_UUID=d0ce42a2-baa7-43a0-9843-406f71f02e2a

set WEBHOOK_URL=%~2
if "%WEBHOOK_URL%"=="" set WEBHOOK_URL=https://zhnaxafmacygbhpvtwvf.supabase.co/functions/v1/revenuecat-webhook

REM --- Secret -----------------------------------------------------------------
if "%REVENUECAT_WEBHOOK_SECRET%"=="" (
    echo.
    echo REVENUECAT_WEBHOOK_SECRET env var not set.
    set /P REVENUECAT_WEBHOOK_SECRET=Paste webhook secret: 
)
if "%REVENUECAT_WEBHOOK_SECRET%"=="" (
    echo No secret provided. Aborting.
    exit /b 1
)

REM --- Timestamps (PowerShell for 64-bit math + ms precision) -----------------
for /f "tokens=1,2" %%a in ('powershell -NoProfile -Command "$f = [int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); $s = $f - 60000; Write-Output \"$f $s\""') do (
    set T_FRESH=%%a
    set T_STALE=%%b
)

REM --- Unique event_ids (so subsequent runs don't hit idempotency short-circuit)
for /f "delims=" %%i in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString().ToUpper()"') do set EID_FRESH=%%i
for /f "delims=" %%i in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString().ToUpper()"') do set EID_STALE=%%i

REM --- Working dir for payload files ------------------------------------------
set WORKDIR=%TEMP%\pu3-test
if not exist "%WORKDIR%" mkdir "%WORKDIR%"

REM --- Generate payloads via PowerShell (clean JSON escaping) -----------------
powershell -NoProfile -Command ^
  "$p = @{ event = @{ id='%EID_FRESH%'; type='RENEWAL'; app_user_id='%PARENT_UUID%'; product_id='lexilens_premium_monthly:monthly-v2'; event_timestamp_ms=[int64]%T_FRESH%; expiration_at_ms=[int64](%T_FRESH% + 2592000000) } } | ConvertTo-Json -Depth 4 -Compress; Set-Content -Path '%WORKDIR%\fresh.json' -Value $p -Encoding utf8"

powershell -NoProfile -Command ^
  "$p = @{ event = @{ id='%EID_STALE%'; type='RENEWAL'; app_user_id='%PARENT_UUID%'; product_id='lexilens_premium_monthly:monthly-v2'; event_timestamp_ms=[int64]%T_STALE%; expiration_at_ms=[int64](%T_STALE% + 2592000000) } } | ConvertTo-Json -Depth 4 -Compress; Set-Content -Path '%WORKDIR%\stale.json' -Value $p -Encoding utf8"

echo.
echo ==============================================================================
echo PU-3 ordering-guard behavioural proof
echo ==============================================================================
echo parent_uuid:   %PARENT_UUID%
echo webhook_url:   %WEBHOOK_URL%
echo fresh ts (ms): %T_FRESH%
echo stale ts (ms): %T_STALE% (60s before fresh)
echo fresh evt id:  %EID_FRESH%
echo stale evt id:  %EID_STALE%
echo payloads:      %WORKDIR%\fresh.json  /  %WORKDIR%\stale.json
echo.

REM --- Step 1: fire FRESH event (should land as applied:tier1) ---------------
echo [1/2] Firing FRESH event (expect HTTP 200 + applied:tier1)...
curl -sS -w "\n  -> HTTP %%{http_code}\n" ^
  -X POST "%WEBHOOK_URL%" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer %REVENUECAT_WEBHOOK_SECRET%" ^
  --data-binary "@%WORKDIR%\fresh.json"
echo.

REM --- 2-second pause so the fresh write commits before the stale arrives -----
REM    (Edge Function cold start + 4 DB round-trips can take ~1s per Check H)
echo Waiting 2s for fresh write to commit...
timeout /t 2 /nobreak >nul
echo.

REM --- Step 2: fire STALE event (should be stale_skipped) ---------------------
echo [2/2] Firing STALE event (expect HTTP 200 + stale_skipped)...
curl -sS -w "\n  -> HTTP %%{http_code}\n" ^
  -X POST "%WEBHOOK_URL%" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer %REVENUECAT_WEBHOOK_SECRET%" ^
  --data-binary "@%WORKDIR%\stale.json"
echo.

echo ==============================================================================
echo Done. Verify in Supabase SQL editor:
echo ==============================================================================
echo.
echo   SELECT event_id, event_type, processing_note, received_at
echo     FROM public.revenuecat_webhook_log
echo    WHERE event_id IN ('%EID_FRESH%', '%EID_STALE%');
echo.
echo Expected:
echo   %EID_FRESH%  RENEWAL  applied:tier1
echo   %EID_STALE%  RENEWAL  stale_skipped
echo.
echo Then re-run v2 Check J:
echo   SELECT count(*) AS stale_skipped_n FROM public.revenuecat_webhook_log
echo    WHERE processing_note = 'stale_skipped';
echo Expected: stale_skipped_n ^>= 1
echo.

endlocal
