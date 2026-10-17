@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   ACTUALIZAR ObraControl CMI
echo   Trae la ultima version desde GitHub a esta PC.
echo   (Hace doble clic en esto ANTES de empezar a trabajar)
echo ============================================================
echo.
git config core.hooksPath .githooks
git pull --no-rebase origin main
echo.
echo ------------------------------------------------------------
echo   Listo. Ya tenes la version mas reciente en esta PC.
echo ------------------------------------------------------------
pause
