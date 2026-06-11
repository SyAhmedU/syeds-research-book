@echo off
rem Detached refresh-through-today runner: construct sweep, journal-by-DOI sweep,
rem then the (self-preserving) merge into data/recent.index.json. Resumable.
cd /d "%~dp0.."
echo [%date% %time%] refresh-today starting > data\openalex-refresh\run.log
node scripts\refresh-openalex.mjs --mode construct --since 2026-04-01 --per 100 >> data\openalex-refresh\run.log 2>&1
node scripts\refresh-openalex.mjs --mode journal-doi --since 2026-05-01 --per 50 >> data\openalex-refresh\run.log 2>&1
node scripts\merge-refresh.mjs >> data\openalex-refresh\run.log 2>&1
echo [%date% %time%] refresh-today DONE >> data\openalex-refresh\run.log
echo DONE > data\openalex-refresh\run.done
