@echo off
rem Starts Vocal Studio and opens it in the browser once the server is ready.
cd /d "%~dp0"
".venv\Scripts\python.exe" server.py
pause
