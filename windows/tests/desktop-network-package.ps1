$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'desktop-viewer-package.ps1') -Kind network
