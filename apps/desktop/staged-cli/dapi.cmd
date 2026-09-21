@echo off
rem diffusion-studio-dapi-shim v1: stable launcher, resolves the current install at every run. Do not edit.
chcp 65001 >nul
set ELECTRON_RUN_AS_NODE=1
set "DIFFUSION_APP_PATH=%~dp0..\Diffusion Studio.exe"
"%DIFFUSION_APP_PATH%" "%~dp0dapi.js" %*
