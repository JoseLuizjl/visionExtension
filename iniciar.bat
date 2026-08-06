@echo off
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I "ollama.exe" >NUL
if errorlevel 1 (
    echo Iniciando Ollama...
    start "" /min "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve
    timeout /t 2 /nobreak >NUL
) else (
    echo Ollama ja esta rodando.
)

cd /d "%~dp0server"
echo.
echo Iniciando servidor...
echo (deixe esta janela aberta - o link de acesso aparece abaixo)
echo.
call npm start
pause
