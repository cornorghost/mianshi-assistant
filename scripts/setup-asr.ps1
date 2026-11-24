$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
    & py -3.11 -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.11 is required. Install Python 3.11 and retry.' }
}
& '.venv/Scripts/python.exe' -m pip install -r scripts/requirements.txt --index-url https://pypi.tuna.tsinghua.edu.cn/simple --timeout 30
if ($LASTEXITCODE -ne 0) { throw 'Speech dependency installation failed.' }
& '.venv/Scripts/python.exe' scripts/asr.py --model small --download-only
if ($LASTEXITCODE -ne 0) { throw 'Model download failed. Check network access to huggingface.co and retry.' }
Write-Host 'Local speech recognition is ready.'
