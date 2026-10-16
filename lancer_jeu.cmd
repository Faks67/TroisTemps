@echo off
rem Lance Trois Temps puis ouvre le navigateur sur http://localhost:5190
cd /d "%~dp0"
echo Demarrage de Trois Temps sur http://localhost:5190 (fermez cette fenetre pour l'arreter)...
echo Pour jouer depuis des telephones : meme Wi-Fi que ce PC, puis scannez le QR code du salon.
start "" /b cmd /c ""%SystemRoot%\System32\timeout.exe" /t 6 /nobreak >nul & start http://localhost:5190"
dotnet run --project "%~dp0TroisTemps.Web\TroisTemps.Web.csproj" --launch-profile http
pause
