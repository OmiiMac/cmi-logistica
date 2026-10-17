@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   SUBIR CAMBIOS a GitHub (y a la app en vivo)
echo ============================================================
echo.
git config core.hooksPath .githooks

echo Trayendo primero lo que haya en GitHub...
git pull --no-rebase origin main
if errorlevel 1 (
  echo.
  echo *** Hubo un problema al traer los cambios. No subo nada.
  echo *** Avisale a quien te ayuda con esto antes de seguir.
  pause
  exit /b 1
)

echo.
set /p msg="Escribi en pocas palabras que cambiaste: "
git add -A
git commit -m "%msg%"
git push origin main
echo.
echo ------------------------------------------------------------
echo   Si arriba NO aparece "PUSH DETENIDO" ni errores, quedo subido.
echo   La app en Railway se actualiza sola en 1-2 minutos.
echo ------------------------------------------------------------
pause
